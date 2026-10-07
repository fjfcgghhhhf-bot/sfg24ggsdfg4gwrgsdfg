import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalog, createGame, GameError } from '../lib/game.mjs';
import { loadConfiguration } from '../lib/config.mjs';
import { createApplication } from '../server.mjs';

const secret = 'test-only-secret-012345678901234567890123456789';
const goalCode = '1234567890';
const artworks = [
  { name: 'Redline', weapon: 'AK-47', image: '/assets/skins/redline.png', rarity: '#f55' },
  { name: 'Dragon Lore', weapon: 'AWP', image: '/assets/skins/dragon.png', rarity: '#ffdf00' },
];
const game = (options = {}) => createGame({ secret, goalCode, artworks, ...options });
const isError = (code) => (error) => error instanceof GameError && error.code === code;

test('new player receives 500 and validation is enforced', () => {
  const engine = game();
  const session = engine.start('  Игрок  ');
  assert.deepEqual(session.player, { nickname: 'Игрок', balance: 500, inventory: [], wins: 0, attempts: 0 });
  assert.throws(() => engine.start('<script>'), isError('INVALID_NICKNAME'));
  assert.throws(() => engine.start('a'), isError('INVALID_NICKNAME'));
  assert.throws(() => engine.start('a\nB'), isError('INVALID_NICKNAME'));
  assert.throws(() => engine.start('a'.repeat(25)), isError('INVALID_NICKNAME'));
});

test('catalog covers every 10-ruble tier, filters, sorts and paginates', () => {
  const catalog = createCatalog(artworks);
  const all = catalog.list();
  assert.equal(all.total, 50_000);
  assert.equal(all.pages, 1250);
  assert.equal(catalog.list({ sort: 'desc' }).items[0].id, 'code');
  for (let price = 10; price < 500_000; price += 10) assert.equal(catalog.get(`skin-${price}`).price, price);
  assert.deepEqual(catalog.list({ min: 10, max: 30 }).items.map((item) => item.price), [10, 20, 30]);
  assert.deepEqual(catalog.list({ min: 10, max: 30, sort: 'desc' }).items.map((item) => item.price), [30, 20, 10]);
  assert.equal(catalog.list({ min: 10, max: 30, q: 'awp' }).items[0].price, 20);
  assert.equal(catalog.list({ q: 'код' }).items[0].id, 'code');
  assert.equal(catalog.list({ min: 10, max: 30, page: 2, limit: 2 }).items[0].price, 30);
  assert.equal(catalog.list({ q: 'impossible item' }).total, 0);
  assert.throws(() => catalog.get('skin-0'), isError('ITEM_NOT_FOUND'));
  assert.throws(() => catalog.get('skin-15'), isError('ITEM_NOT_FOUND'));
  assert.throws(() => catalog.get('skin-500000'), isError('ITEM_NOT_FOUND'));
  assert.throws(() => catalog.list({ min: 'NaN' }), isError('INVALID_FILTER'));
  assert.throws(() => catalog.list({ min: 30, max: 10 }), isError('INVALID_FILTER'));
});

test('large catalog maps low prices to ordinary skins and high prices to premium skins', () => {
  const images = Array.from({ length: 62 }, (_, index) => ({ name: `Artwork ${index}`, weapon: 'Weapon', image: `/assets/skin-${index}.png`, rarity: 'gold' }));
  const catalog = createCatalog(images);
  const indexOf = (price) => Number(catalog.get(`skin-${price}`).name.split(' ')[1]);
  for (let price = 10; price <= 500; price += 10) assert.ok(indexOf(price) < 20);
  for (let price = 510; price <= 5_000; price += 10) assert.ok(indexOf(price) >= 20 && indexOf(price) < 40);
  for (let price = 5_010; price <= 50_000; price += 10) assert.ok(indexOf(price) >= 40 && indexOf(price) < 55);
  for (let price = 50_010; price < 500_000; price += 10) assert.ok(indexOf(price) >= 42 && indexOf(price) < 62);
  const searched = catalog.list({ q: 'Artwork 61', limit: 100 });
  assert.ok(searched.items.length);
  assert.ok(searched.items.every((item) => item.name === 'Artwork 61' && item.price > 50_000));
});

test('bundled catalog and page references point to existing local static assets', async () => {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const bundled = JSON.parse(await readFile(path.join(publicDir, 'assets/skins.json'), 'utf8'));
  assert.ok(bundled.length >= 40);
  for (const item of bundled) {
    assert.match(item.image, /^\/assets\/skins\/[a-z0-9-]+\.png$/);
    const details = await stat(path.join(publicDir, item.image));
    assert.ok(details.isFile() && details.size > 500, item.image);
  }
  for (const filename of ['index.html', 'app.js', 'style.css', 'assets/code.svg']) assert.ok((await stat(path.join(publicDir, filename))).isFile());
  const page = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  for (const reference of page.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) assert.ok((await stat(path.join(publicDir, reference[1]))).isFile(), reference[1]);
});

test('buy and sell preserve exact balances, duplicate items have unique inventory IDs', () => {
  const engine = game();
  let session = engine.start('Игрок');
  session = engine.buy(session.token, 'skin-100');
  session = engine.buy(session.token, 'skin-100');
  assert.equal(session.player.balance, 300);
  assert.equal(session.player.inventory.length, 2);
  assert.notEqual(session.player.inventory[0].inventoryId, session.player.inventory[1].inventoryId);
  const sold = session.player.inventory[0].inventoryId;
  session = engine.sell(session.token, sold);
  assert.equal(session.player.balance, 400);
  assert.equal(session.player.inventory.length, 1);
  assert.throws(() => engine.sell(session.token, sold), isError('INVENTORY_ITEM_NOT_FOUND'));
  session = engine.buy(session.token, 'skin-400');
  assert.equal(session.player.balance, 0);
  assert.throws(() => engine.buy(session.token, 'skin-10'), isError('INSUFFICIENT_FUNDS'));
  assert.throws(() => engine.buy(session.token, 'code'), isError('GOAL_NOT_BUYABLE'));
  assert.equal(engine.resume(session.token).player.balance, 0);
});

test('canonical revision rejects duplicate requests and resume recovers latest state', () => {
  const engine = game();
  const initial = engine.start('Игрок');
  const bought = engine.buy(initial.token, 'skin-100');
  assert.throws(() => engine.buy(initial.token, 'skin-100'), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'STALE_SESSION');
    assert.deepEqual(error.snapshot, bought);
    return true;
  });
  assert.deepEqual(engine.resume(initial.token), bought);
  const sold = engine.sell(bought.token, bought.player.inventory[0].inventoryId);
  assert.throws(() => engine.sell(bought.token, bought.player.inventory[0].inventoryId), isError('STALE_SESSION'));
  assert.equal(sold.player.balance, 500);
});

test('encrypted persistence survives restart and detects tampering and wrong server key', () => {
  let session = game().start('Игрок');
  const oldEngine = game();
  session = oldEngine.buy(session.token, 'skin-200');
  const restored = game().resume(session.token);
  assert.deepEqual(restored, session);
  assert.equal(restored.player.balance, 300);
  const bytes = Buffer.from(session.token, 'base64url');
  bytes[35] ^= 1;
  assert.throws(() => game().resume(bytes.toString('base64url')), isError('INVALID_SESSION'));
  assert.throws(() => game({ secret: secret + 'wrong' }).resume(session.token), isError('INVALID_SESSION'));
  assert.throws(() => game().resume('not-a-token'), isError('INVALID_SESSION'));
  assert.throws(() => game().resume('a'.repeat(100_001)), isError('INVALID_SESSION'));
  assert.ok(!session.token.includes(goalCode));
  assert.ok(!Buffer.from(session.token, 'base64url').toString('utf8').includes('Игрок'));
});

test('a newer authenticated save advances a restarted server after an older tab resumes first', () => {
  const beforeRestart = game();
  const older = beforeRestart.start('Игрок');
  const newer = beforeRestart.buy(older.token, 'skin-200');
  const restarted = game();
  assert.deepEqual(restarted.resume(older.token), older);
  assert.deepEqual(restarted.resume(newer.token), newer);
  assert.equal(restarted.resume(older.token).player.balance, 300);
  assert.equal(restarted.resume(older.token).player.inventory[0].id, 'skin-200');
  assert.throws(() => restarted.buy(older.token, 'skin-10'), isError('STALE_SESSION'));
  const latest = restarted.buy(newer.token, 'skin-100');
  assert.equal(latest.player.balance, 200);
  assert.equal(latest.player.inventory.length, 2);
  assert.deepEqual(restarted.resume(newer.token), latest);
});

test('win consumes source, grants target, and landing is within bottom arc', () => {
  const engine = game({ random: () => 0.5 });
  let session = engine.start('Игрок');
  session = engine.buy(session.token, 'skin-100');
  const source = session.player.inventory[0].inventoryId;
  session = engine.upgrade(session.token, source, 'skin-200');
  assert.equal(session.result.won, true);
  assert.equal(session.result.chance, 50);
  assert.equal(session.result.angle, 180);
  assert.equal(session.player.inventory[0].id, 'skin-200');
  assert.notEqual(session.player.inventory[0].inventoryId, source);
  assert.equal(session.player.balance, 400);
  assert.equal(session.player.attempts, 1);
  assert.equal(session.player.wins, 1);
  assert.throws(() => engine.upgrade(session.token, source, 'skin-200'), isError('INVENTORY_ITEM_NOT_FOUND'));
});

test('loss consumes source, grants nothing, and landing is within top arc', () => {
  const engine = game({ random: () => 0 });
  let session = engine.start('Игрок');
  session = engine.buy(session.token, 'skin-100');
  session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-200');
  assert.equal(session.result.won, false);
  assert.equal(session.result.angle, 0);
  assert.equal(session.player.inventory.length, 0);
  assert.equal(session.player.attempts, 1);
  assert.equal(session.player.wins, 0);
});

test('visual landing and probability agree at arc edges and across a uniform sample', () => {
  for (const [draw, won] of [[0.249999, false], [0.25, true], [0.749999, true], [0.75, false]]) {
    const engine = game({ random: () => draw });
    let session = engine.start('Игрок');
    session = engine.buy(session.token, 'skin-100');
    session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-200');
    assert.equal(session.result.won, won);
  }
  let wins = 0;
  for (let index = 0; index < 1000; index++) {
    const engine = game({ random: () => index / 1000 });
    let session = engine.start('Игрок');
    session = engine.buy(session.token, 'skin-100');
    session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-400');
    if (session.result.won) wins++;
  }
  assert.equal(wins, 250);
});

test('invalid upgrade is atomic and does not consume an item', () => {
  const engine = game();
  let session = engine.start('Игрок');
  session = engine.buy(session.token, 'skin-100');
  for (const target of ['skin-100', 'skin-90']) assert.throws(() => engine.upgrade(session.token, session.player.inventory[0].inventoryId, target), isError('TARGET_TOO_CHEAP'));
  assert.deepEqual(engine.resume(session.token), session);
});

test('goal stays secret until won, survives restore, and cannot be sold', () => {
  const engine = game({ random: () => 0.5 });
  let session = engine.start('Игрок');
  session = engine.buy(session.token, 'skin-500');
  assert.ok(!JSON.stringify(session).includes(goalCode));
  assert.ok(!JSON.stringify(engine.catalog.get('code')).includes(goalCode));
  assert.equal(session.player.unlockedCode, undefined);
  session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'code');
  assert.equal(session.result.chance, 0.1);
  assert.equal(session.player.unlockedCode, goalCode);
  assert.equal(game().resume(session.token).player.unlockedCode, goalCode);
  assert.throws(() => engine.sell(session.token, session.player.inventory[0].inventoryId), isError('GOAL_NOT_SELLABLE'));
});

test('reset invalidates all previous tokens without resetting independent players', () => {
  const engine = game();
  const first = engine.start('Первый');
  const other = engine.start('Другой');
  const updated = engine.buy(first.token, 'skin-200');
  assert.deepEqual(engine.reset(first.token), { ok: true });
  assert.throws(() => engine.resume(updated.token), isError('SESSION_RESET'));
  assert.throws(() => engine.resume(first.token), isError('SESSION_RESET'));
  assert.deepEqual(engine.resume(other.token), other);
  assert.equal(engine.start('Заново').player.balance, 500);
});

test('local configuration is stable, private and production never creates a fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upgrade-config-'));
  try {
    const one = await loadConfiguration(directory, {});
    const two = await loadConfiguration(directory, {});
    assert.deepEqual(one, two);
    assert.match(one.goalCode, /^\d{10}$/);
    assert.equal(one.secret.length, 64);
    const saved = JSON.parse(await readFile(path.join(directory, '.local-secrets.json'), 'utf8'));
    assert.equal(saved.GOAL_CODE, one.goalCode);
    assert.equal(saved.SESSION_SECRET, one.secret);
    await assert.rejects(() => loadConfiguration(directory, { NODE_ENV: 'production' }), /Production requires/);
    await assert.rejects(() => loadConfiguration(directory, { NODE_ENV: 'production', SESSION_SECRET: 'short', GOAL_CODE: goalCode }), /at least 32/);
    await assert.rejects(() => loadConfiguration(directory, { NODE_ENV: 'production', SESSION_SECRET: secret, GOAL_CODE: '123' }), /ten digits/);
    assert.deepEqual(await loadConfiguration(directory, { NODE_ENV: 'production', SESSION_SECRET: secret, GOAL_CODE: goalCode }), { secret, goalCode });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP flow, safe static serving, JSON validation and private data boundaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upgrade-http-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Upgrade</title>');
  await writeFile(path.join(directory, '.hidden.json'), '{"secret":"hidden"}');
  const server = createApplication({ game: game({ random: () => 0.5 }), publicDir: directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (const url of ['/server.mjs', '/.local-secrets.json', '/%2ehidden.json', '/..%2fserver.mjs', '/%5c..%5cserver.mjs']) assert.equal((await fetch(base + url)).status, 404, url);
    const initial = await post('/api/session', { nickname: 'Tester' });
    assert.equal(initial.status, 200);
    const bought = await post('/api/buy', { token: initial.payload.token, itemId: 'skin-100' });
    assert.equal(bought.payload.player.balance, 400);
    const stale = await post('/api/buy', { token: initial.payload.token, itemId: 'skin-100' });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.token, bought.payload.token);
    const upgraded = await post('/api/upgrade', { token: bought.payload.token, inventoryId: bought.payload.player.inventory[0].inventoryId, targetId: 'code' });
    assert.equal(upgraded.payload.player.unlockedCode, goalCode);
    assert.equal((await fetch(base + '/api/item?id=code')).status, 200);
    const publicItem = await (await fetch(base + '/api/item?id=code')).text();
    assert.ok(!publicItem.includes(goalCode));
    const invalid = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_JSON');
    assert.equal((await fetch(base + '/api/session', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await post('/api/session', { nickname: 'a'.repeat(140_000) })).status, 413);
    assert.equal((await post('/api/resume', { token: 'bad' })).status, 401);
    assert.equal((await post('/api/nope', {})).status, 404);
    assert.equal((await fetch(base + '/api/session')).status, 405);
    assert.equal((await post('/api/reset', { token: upgraded.payload.token })).status, 200);
    assert.equal((await post('/api/resume', { token: upgraded.payload.token })).status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
