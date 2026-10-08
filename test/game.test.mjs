import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
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
const initialBoosters = { luckyRemaining: 3 };

function fixtureToken(state) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  cipher.setAAD(Buffer.from('upgrade-session-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function readFixtureToken(token) {
  const raw = Buffer.from(token, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from('upgrade-session-v1'));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

test('new player receives 500 and validation is enforced', () => {
  const engine = game();
  const session = engine.start('  Игрок  ');
  assert.deepEqual(session.player, { nickname: 'Игрок', balance: 500, inventory: [], wins: 0, attempts: 0, boosters: initialBoosters });
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
  assert.equal(catalog.get('skin-15').price, 15);
  assert.throws(() => catalog.get('skin-500000'), isError('ITEM_NOT_FOUND'));
  assert.throws(() => catalog.list({ min: 'NaN' }), isError('INVALID_FILTER'));
  assert.throws(() => catalog.list({ min: 30, max: 10 }), isError('INVALID_FILTER'));
});

test('exact cent-priced items and exact catalog filters are available to purchase', () => {
  const engine = game();
  for (const price of [10, 10.01, 15, 22.5, 22.51, 500.01, 5000.01, 50_000.01, 499_999.99]) {
    const exact = engine.catalog.get(`skin-${price}`);
    assert.equal(exact.price, price);
    assert.ok(exact.image && exact.name);
    assert.deepEqual(engine.catalog.list({ min: String(price), max: String(price) }).items, [exact]);
  }
  assert.equal(engine.catalog.get('skin-22.50').id, 'skin-22.5');
  for (const id of ['skin-9.99', 'skin-10.001', 'skin-1e3', 'skin-+10', 'skin-010', 'skin-500000.00', 'skin-499999.999', 'skin-Infinity']) assert.throws(() => engine.catalog.get(id), isError('ITEM_NOT_FOUND'));
  assert.throws(() => engine.catalog.list({ min: '10.001', max: '10.001' }), isError('INVALID_FILTER'));
  assert.equal(engine.catalog.list({ min: 500_000, max: 500_000 }).items[0].id, 'code');
  assert.equal(engine.catalog.list({ min: 22.5, max: 22.5, q: 'does-not-exist' }).total, 0);
  let session = engine.start('Копейки');
  for (let index = 0; index < 10; index++) {
    session = engine.buy(session.token, 'skin-22.51');
    assert.equal(session.player.balance, 477.49);
    session = engine.sell(session.token, session.player.inventory[0].inventoryId);
    assert.equal(session.player.balance, 500);
  }
  session = engine.buy(session.token, 'skin-489.99');
  assert.equal(session.player.balance, 10.01);
  session = engine.buy(session.token, 'skin-10.01');
  assert.equal(session.player.balance, 0);
  assert.equal(game().resume(session.token).player.balance, 0);
  assert.throws(() => engine.buy(session.token, 'skin-10'), isError('INSUFFICIENT_FUNDS'));
});

test('one-and-a-half upgrades retain the actual 66.67 percent chance without 10-ruble rounding', () => {
  const engine = game({ random: () => 0.5 });
  let session = engine.start('Полтора');
  session = engine.buy(session.token, 'skin-10');
  session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-15');
  assert.ok(Math.abs(session.result.chance - 66.66666666666666) < 1e-10);
  assert.equal(session.player.inventory[0].price, 15);
  session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-22.5');
  assert.ok(Math.abs(session.result.chance - 66.66666666666666) < 1e-10);
  assert.equal(session.player.inventory[0].price, 22.5);
  session = engine.sell(session.token, session.player.inventory[0].inventoryId);
  assert.equal(session.player.balance, 512.5);
});

test('Lucky guarantees three valid wins and rejects the fourth without spending', () => {
  const engine = game({ random: () => 0 });
  let session = engine.start('Счастливчик');
  session = engine.buy(session.token, 'skin-10');
  for (const [count, price] of [20, 40, 80].entries()) {
    session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, `skin-${price}`, { lucky: true });
    assert.equal(session.result.won, true);
    assert.equal(session.result.chance, 50);
    assert.equal(session.result.angle, 90);
    assert.equal(session.result.luckyUsed, true);
    assert.equal(session.player.boosters.luckyRemaining, 2 - count);
  }
  assert.throws(() => engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-160', { lucky: true }), isError('LUCKY_EXHAUSTED'));
  assert.deepEqual(engine.resume(session.token), { token: session.token, player: session.player });
  assert.deepEqual(game().resume(session.token).player.boosters, { luckyRemaining: 0 });
  engine.reset(session.token);
  assert.deepEqual(engine.start('Заново').player.boosters, initialBoosters);
});

test('Lucky charges even a naturally winning draw and uniformly maps draws into the normal arc', () => {
  for (const draw of [0, 0.25, 0.5, 0.75, 0.999999999]) {
    const engine = game({ random: () => draw });
    let session = engine.start('Счастливчик');
    session = engine.buy(session.token, 'skin-15.01');
    session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-30.02', { lucky: true });
    assert.equal(session.result.chance, 50);
    assert.equal(session.result.won, true);
    assert.ok(session.result.angle >= 90 && session.result.angle < 270);
    assert.equal(session.result.angle, 90 + draw * 180);
    assert.equal(session.player.boosters.luckyRemaining, 2);
  }
});

test('Lucky below 50 percent and non-boolean booster flags are rejected before all changes', () => {
  let draws = 0;
  const engine = game({ random: () => { draws++; return 0.5; } });
  let session = engine.start('Проверка');
  session = engine.buy(session.token, 'skin-10');
  const source = session.player.inventory[0].inventoryId;
  assert.throws(() => engine.upgrade(session.token, source, 'skin-20.01', { lucky: true }), isError('LUCKY_CHANCE_TOO_LOW'));
  for (const options of [{ lucky: 'true' }, { lucky: 1 }, { lucky: null }, { lucky: [] }, null, []]) assert.throws(() => engine.upgrade(session.token, source, 'skin-20', options), isError('INVALID_BOOSTER'));
  assert.equal(draws, 0);
  assert.deepEqual(engine.resume(session.token), session);
});

test('legacy saves migrate with their money and inventory and invalid booster saves cannot refill charges', () => {
  const legacy = { v: 1, sid: randomUUID(), revision: 7, nickname: 'Старый игрок', balance: 345, inventory: [{ inventoryId: randomUUID(), itemId: 'skin-100' }], wins: 2, attempts: 4, unlocked: false };
  const token = fixtureToken(legacy);
  const engine = game({ random: () => 0 });
  let session = engine.resume(token);
  assert.notEqual(session.token, token);
  assert.equal(session.player.balance, 345);
  assert.equal(session.player.inventory[0].inventoryId, legacy.inventory[0].inventoryId);
  assert.deepEqual(session.player.boosters, initialBoosters);
  session = engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-200', { lucky: true });
  assert.equal(session.player.boosters.luckyRemaining, 2);
  assert.equal(engine.resume(token).player.boosters.luckyRemaining, 2);
  assert.equal(game().resume(session.token).player.boosters.luckyRemaining, 2);
  for (const boosters of [null, {}, { luckyRemaining: -1 }, { luckyRemaining: 4 }, { luckyRemaining: 0.5 }, { luckyRemaining: '3' }]) {
    assert.throws(() => game().resume(fixtureToken({ ...legacy, boosters })), isError('INVALID_SESSION'));
  }
  const v2 = { ...legacy, v: 2, balanceCents: 34_500, boosters: initialBoosters };
  delete v2.balance;
  const missing = { ...v2 }; delete missing.boosters;
  assert.throws(() => game().resume(fixtureToken(missing)), isError('INVALID_SESSION'));
  assert.throws(() => game().resume(fixtureToken({ ...v2, balanceCents: 34_500.5 })), isError('INVALID_SESSION'));
});

test('v2 migration drops removed booster fields, preserves spent Lucky charges, and old request flags never save losses', async () => {
  const legacy = {
    v: 2, sid: randomUUID(), revision: 9, nickname: 'Старое сохранение', balanceCents: 12_345,
    inventory: [{ inventoryId: randomUUID(), itemId: 'skin-22.5' }], wins: 5, attempts: 8,
    boosters: { phoenixRemaining: 7, luckyRemaining: 0 }, unlocked: false,
  };
  const legacyToken = fixtureToken(legacy);
  const engine = game({ random: () => 0 });
  const server = createApplication({ game: engine });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const migrated = await post('/api/resume', { token: legacyToken });
    assert.notEqual(migrated.token, legacyToken);
    assert.equal(migrated.player.balance, 123.45);
    assert.equal(migrated.player.inventory[0].inventoryId, legacy.inventory[0].inventoryId);
    assert.equal(migrated.player.inventory[0].price, 22.5);
    assert.equal(migrated.player.wins, 5);
    assert.equal(migrated.player.attempts, 8);
    assert.deepEqual(migrated.player.boosters, { luckyRemaining: 0 });
    const saved = readFixtureToken(migrated.token);
    assert.equal(saved.v, 3);
    assert.deepEqual(saved.boosters, { luckyRemaining: 0 });
    assert.ok(!JSON.stringify(saved).includes('phoenix'));
    assert.deepEqual(game().resume(migrated.token), migrated);
    assert.throws(() => engine.upgrade(migrated.token, legacy.inventory[0].inventoryId, 'skin-45', { lucky: true }), isError('LUCKY_EXHAUSTED'));
    const lost = await post('/api/upgrade', { token: migrated.token, inventoryId: legacy.inventory[0].inventoryId, targetId: 'skin-45', phoenix: true });
    assert.equal(lost.result.won, false);
    assert.equal(lost.player.inventory.length, 0);
    assert.equal(lost.player.balance, 123.45);
    assert.equal(lost.player.attempts, 9);
    assert.deepEqual(lost.player.boosters, { luckyRemaining: 0 });
    assert.equal(Object.hasOwn(lost.result, 'savedByPhoenix'), false);
    assert.equal(engine.resume(legacyToken).player.inventory.length, 0);
    assert.deepEqual(readFixtureToken(lost.token).boosters, { luckyRemaining: 0 });
  } finally { await new Promise((resolve) => server.close(resolve)); }
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

test('bulk cart purchase is atomic, prices come from the catalog, and duplicates get unique inventory IDs',()=>{
  const engine=game();let session=engine.start('Cart player');
  for(const items of [[],null,[{itemId:'skin-10',quantity:0}],[{itemId:'skin-10',quantity:1.5}],[{itemId:'skin-10',quantity:'2'}],[{itemId:'skin-10',quantity:201}]])assert.throws(()=>engine.buyCart(session.token,items),isError('INVALID_CART'));
  assert.throws(()=>engine.buyCart(session.token,[{itemId:'skin-10',quantity:1},{itemId:'code',quantity:1}]),isError('GOAL_NOT_BUYABLE'));
  assert.throws(()=>engine.buyCart(session.token,[{itemId:'skin-10',quantity:1},{itemId:'skin-499',quantity:1}]),isError('INSUFFICIENT_FUNDS'));
  assert.equal(engine.resume(session.token).player.balance,500);
  assert.equal(engine.resume(session.token).player.inventory.length,0);
  const previous=session.token;
  session=engine.buyCart(session.token,[{itemId:'skin-10.03',quantity:2,price:0},{itemId:'skin-22.51',quantity:1},{itemId:'skin-10.03',quantity:1}]);
  assert.deepEqual(session.purchase,{count:4,total:52.6});assert.equal(session.player.balance,447.4);
  assert.equal(new Set(session.player.inventory.map((item)=>item.inventoryId)).size,4);
  assert.throws(()=>engine.buyCart(previous,[{itemId:'skin-10',quantity:1}]),isError('STALE_SESSION'));
  const restarted=game().resume(session.token);assert.equal(restarted.player.balance,447.4);assert.equal(restarted.player.inventory.length,4);
});

test('cart enforces the inventory capacity on the whole purchase without partial changes',()=>{
  const engine=game();const base=readFixtureToken(engine.start('Capacity').token);
  base.inventory=Array.from({length:198},()=>({inventoryId:randomUUID(),itemId:'skin-10'}));
  const saved=fixtureToken(base);
  // A fresh process restores the fixture as authoritative state.
  const restored=game();
  assert.throws(()=>restored.buyCart(saved,[{itemId:'skin-10',quantity:2},{itemId:'skin-10',quantity:1}]),isError('INVENTORY_FULL'));
  assert.equal(restored.resume(saved).player.balance,500);
  const purchased=restored.buyCart(saved,[{itemId:'skin-10',quantity:2}]);assert.equal(purchased.player.inventory.length,200);
});

test('sell all sums cents once, preserves the final reward, rejects replay and leaves empty sales unchanged',()=>{
  const engine=game({random:()=>.5});let session=engine.start('Collector');
  assert.throws(()=>engine.sellAll(session.token),isError('NO_ITEMS_TO_SELL'));
  session=engine.buy(session.token,'skin-10');session=engine.upgrade(session.token,session.player.inventory[0].inventoryId,'code');
  session=engine.buyCart(session.token,[{itemId:'skin-10.03',quantity:2},{itemId:'skin-22.51',quantity:1}]);
  const previous=session.token;
  session=engine.sellAll(session.token);
  assert.deepEqual(session.sale,{count:3,total:42.57});assert.equal(session.player.balance,490);
  assert.deepEqual(session.player.inventory.map((item)=>item.id),['code']);assert.equal(session.player.unlockedCode,goalCode);
  assert.throws(()=>engine.sellAll(previous),isError('STALE_SESSION'));
  assert.throws(()=>engine.sellAll(session.token),isError('NO_ITEMS_TO_SELL'));
  assert.deepEqual(game().resume(session.token).player,session.player);
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
    assert.deepEqual(initial.payload.player.boosters, initialBoosters);
    const shopper=await post('/api/session',{nickname:'Bulk HTTP'});
    const cart=await post('/api/buy-cart',{token:shopper.payload.token,items:[{itemId:'skin-10.03',quantity:2}]});
    assert.equal(cart.status,200);assert.equal(cart.payload.player.balance,479.94);
    const all=await post('/api/sell-all',{token:cart.payload.token});
    assert.equal(all.status,200);assert.equal(all.payload.player.balance,500);assert.equal(all.payload.player.inventory.length,0);
    const exact = await (await fetch(base + '/api/item?id=skin-22.51')).json();
    assert.equal(exact.price, 22.51);
    const exactList = await (await fetch(base + '/api/catalog?min=22.51&max=22.51')).json();
    assert.deepEqual(exactList.items, [exact]);
    const bought = await post('/api/buy', { token: initial.payload.token, itemId: 'skin-100' });
    assert.equal(bought.payload.player.balance, 400);
    const stale = await post('/api/buy', { token: initial.payload.token, itemId: 'skin-100' });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.token, bought.payload.token);
    const invalidBooster = await post('/api/upgrade', { token: bought.payload.token, inventoryId: bought.payload.player.inventory[0].inventoryId, targetId: 'skin-150', lucky: 'true' });
    assert.equal(invalidBooster.status, 400);
    assert.equal(invalidBooster.payload.code, 'INVALID_BOOSTER');
    const invalidChance = await post('/api/upgrade', { token: bought.payload.token, inventoryId: bought.payload.player.inventory[0].inventoryId, targetId: 'skin-200.01', lucky: true });
    assert.equal(invalidChance.status, 400);
    assert.equal(invalidChance.payload.code, 'LUCKY_CHANCE_TOO_LOW');
    const lucky = await post('/api/upgrade', { token: bought.payload.token, inventoryId: bought.payload.player.inventory[0].inventoryId, targetId: 'skin-150', lucky: true });
    assert.equal(lucky.status, 200);
    assert.equal(lucky.payload.result.luckyUsed, true);
    assert.deepEqual(lucky.payload.player.boosters, { luckyRemaining: 2 });
    const upgraded = await post('/api/upgrade', { token: lucky.payload.token, inventoryId: lucky.payload.player.inventory[0].inventoryId, targetId: 'code' });
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
