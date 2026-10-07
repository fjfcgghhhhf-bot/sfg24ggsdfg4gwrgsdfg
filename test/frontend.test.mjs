import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createGame, GameError } from '../lib/game.mjs';

// Unit-level DOM, animation and Web Audio doubles. These tests do not launch,
// control, or connect to a browser, and never touch a real player's session.
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appWithoutStartup = appSource.replace(/\binit\(\);\s*$/, '');
const SESSION_KEY = 'upgrade.session.v1';
const PREFS_KEY = 'upgrade.preferences.v1';
const artwork = [{ name: 'Test skin', weapon: 'AWP', image: '/assets/test.png', rarity: 'blue' }];
const settled = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function harness({ random = () => 0.5, engine, savedToken, preferences, intercept } = {}) {
  engine ||= createGame({ secret: 'frontend-test-secret-01234567890123456789', goalCode: '1234567890', artworks: artwork, random });
  const elements = new Map(), documentListeners = new Map(), windowListeners = new Map();
  const storage = new Map(), frames = new Map(), timers = new Map();
  const requests = [], dialogs = [], audio = [], trace = [];
  let clock = 0, nextFrame = 1, nextTimer = 1, reloads = 0;
  if (savedToken) storage.set(SESSION_KEY, savedToken);
  if (preferences) storage.set(PREFS_KEY, JSON.stringify(preferences));
  function classes() {
    const values = new Set();
    return { add: (...items) => items.forEach((item) => values.add(item)), remove: (...items) => items.forEach((item) => values.delete(item)), contains: (item) => values.has(item), toggle(item, enabled) { enabled = enabled === undefined ? !values.has(item) : enabled; if (enabled) values.add(item); else values.delete(item); return enabled; } };
  }
  function element(id = '') {
    const listeners = new Map(), attributes = new Map();
    const node = {
      id, value: '', innerHTML: '', disabled: false, hidden: false, open: false, dataset: {}, classList: classes(), listeners,
      get textContent() { return this.text || ''; }, set textContent(value) { this.text = String(value); },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
      setAttribute(name, value) { attributes.set(name, String(value)); }, getAttribute(name) { return attributes.get(name) ?? null; },
      showModal() { dialogs.push(id); this.open = true; }, close() { this.open = false; }, scrollIntoView() {},
      closest(selector) { if (selector === 'svg' && id === 'winArc') return wheel; if (selector === '[data-multiplier]' && this.dataset.multiplier) return this; if (selector === '[data-action]' && this.dataset.action) return this; if (selector === '[data-close]' && this.dataset.close) return this; return null; },
      querySelector(selector) { if (selector === 'button[type="submit"]') return submit; return null; },
    };
    return node;
  }
  const wheel = element('testWheel'), submit = element('testSubmit');
  for (const match of pageSource.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element(match[1]));
  const presets = [1.5, 2, 5, 10].map((value) => { const node = element(); node.dataset.multiplier = String(value); return node; });
  const document = {
    body: element('body'), getElementById: (id) => elements.get(id) || null,
    querySelectorAll(selector) { if (selector === '[data-multiplier]') return presets; return []; },
    addEventListener(type, listener) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(listener); },
  };
  function param() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
  class AudioContext {
    constructor() { trace.push('audio:create'); this.destination = {}; }
    get currentTime() { return clock / 1000; }
    resume() { trace.push('audio:resume'); return Promise.resolve(); }
    createOscillator() {
      const oscillator = { type: '', frequency: param(), connect() {}, disconnect() {}, start(at) { this.startedAt = at; }, stop(at) { this.stoppedAt = at; } };
      audio.push(oscillator); return oscillator;
    }
    createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
  }
  const window = {
    AudioContext, matchMedia: () => ({ matches: false }),
    addEventListener(type, listener) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(listener); },
  };
  async function fetchDouble(url, options = {}) {
    const parsed = new URL(url, 'http://unit.test'), path = parsed.pathname, body = options.body ? JSON.parse(options.body) : undefined;
    const request = { path, query: Object.fromEntries(parsed.searchParams), body };
    requests.push(request); trace.push(`fetch:${path}`);
    if (intercept) await intercept(request);
    try {
      let result;
      if (path === '/api/catalog') result = engine.catalog.list(request.query);
      else if (path === '/api/item') result = engine.catalog.get(request.query.id);
      else if (path === '/api/session') result = engine.start(body.nickname);
      else if (path === '/api/resume') result = engine.resume(body.token);
      else if (path === '/api/buy') result = engine.buy(body.token, body.itemId);
      else if (path === '/api/sell') result = engine.sell(body.token, body.inventoryId);
      else if (path === '/api/upgrade') result = engine.upgrade(body.token, body.inventoryId, body.targetId, { phoenix: body.phoenix, lucky: body.lucky });
      else if (path === '/api/reset') result = engine.reset(body.token);
      else throw new Error(`Unexpected route: ${path}`);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      return { ok: false, status: error.status, json: async () => ({ error: error.message, code: error.code, ...error.snapshot }) };
    }
  }
  const context = vm.createContext({
    document, window, fetch: fetchDouble, URLSearchParams, Intl, console,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    location: { reload() { reloads++; } }, navigator: { clipboard: { writeText: async () => {} } },
    performance: { now: () => clock }, requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(appWithoutStartup, context, { filename: 'public/app.js' });
  const evaluate = (code) => vm.runInContext(code, context);
  const plain = (code) => JSON.parse(evaluate(`JSON.stringify(${code})`));
  function install(snapshot, targetPrice = 200) {
    context.fixture = snapshot;
    context.fixtureTarget = targetPrice === 500000 ? engine.catalog.get('code') : engine.catalog.get(`skin-${targetPrice}`);
    evaluate('saveSnapshot(fixture,false); mode="inventory"; source=player.inventory[0]||null; target=fixtureTarget; cache.set(target.id,target); renderPlayer();');
    return snapshot;
  }
  function seed(price = 100, targetPrice = 200) {
    let snapshot = engine.start('Unit Tester');
    snapshot = engine.buy(snapshot.token, `skin-${price}`);
    return install(snapshot, targetPrice);
  }
  async function dispatch(id, type, extra = {}) {
    const node = elements.get(id);
    assert.ok(node, `HTML contains #${id}`);
    for (const listener of node.listeners.get(type) || []) await listener({ preventDefault() {}, target: node, ...extra });
    await settled();
  }
  async function clickDataset(dataset) {
    const node = element(); node.dataset = dataset;
    // Clicking an inner <span> should still resolve the delegated parent button.
    const child = { closest: (selector) => node.closest(selector) };
    for (const listener of documentListeners.get('click') || []) await listener({ target: child });
    await settled();
  }
  function frame(milliseconds = 50) {
    clock += milliseconds;
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(clock);
  }
  async function finishAnimation() {
    await settled();
    for (let count = 0; frames.size && count < 100; count++) { frame(100); await settled(); }
    assert.equal(frames.size, 0, 'animation eventually completes');
    await settled();
  }
  return { engine, context, evaluate, plain, seed, install, dispatch, clickDataset, finishAnimation, frame, requests, storage, dialogs, audio, trace, presets, element: (id) => elements.get(id), get reloads() { return reloads; }, async storageEvent(value) { for (const listener of windowListeners.get('storage') || []) await listener({ key: SESSION_KEY, newValue: value }); } };
}

test('frontend multiplier preserves 1.5x prices, rounds in cents, and caps at the goal', () => {
  const h = harness();
  for (const [price, multiplier, expected] of [[10, 1.5, 15], [15, 1.5, 22.5], [22.5, 1.5, 33.75], [10.03, 1.5, 15.05], [400000, 2, 500000]]) assert.equal(h.evaluate(`multiplierPrice(${price},${multiplier})`), expected);
});

test('1.5x selects an exact fractional item, displays 66.67%, and can find it in the shop', async () => {
  const h = harness(); let session = h.seed(10, 20);
  await h.evaluate('pickMultiplier(1.5)');
  assert.equal(h.evaluate('target.id'), 'skin-15');
  assert.equal(h.element('chanceValue').textContent, '66,67%');
  assert.match(h.element('targetGrid').innerHTML, /data-key="skin-15"/);
  await h.clickDataset({ action: 'find-in-shop', key: 'skin-15' });
  assert.equal(h.element('shopMin').value, '15'); assert.equal(h.element('shopMax').value, '15');
  assert.match(h.element('sourceGrid').innerHTML, /data-key="skin-15"/);
  session = h.engine.upgrade(session.token, session.player.inventory[0].inventoryId, 'skin-15');
  h.install(session, 30);
  await h.evaluate('pickMultiplier(1.5)');
  assert.equal(h.evaluate('target.id'), 'skin-22.5');
  assert.equal(h.element('chanceValue').textContent, '66,67%');
});

test('a pending multiplier blocks upgrade and cannot replace a later manual selection', async () => {
  const gate = deferred();
  const h = harness({ intercept: (request) => request.path === '/api/item' && request.query.id === 'skin-150' ? gate.promise : undefined });
  h.seed(); const choosing = h.evaluate('pickMultiplier(1.5)');
  assert.equal(h.element('upgradeButton').disabled, true);
  await h.evaluate('upgrade()');
  assert.equal(h.requests.filter((r) => r.path === '/api/upgrade').length, 0);
  h.evaluate('selectTarget("code")'); gate.resolve(); await choosing;
  assert.equal(h.evaluate('target.id'), 'code'); assert.equal(h.evaluate('targetLoading'), false);
});

test('new and restored sessions list the full shop range instead of a 500-ruble cap', async () => {
  const h = harness();
  await h.evaluate('init()');
  h.element('nicknameInput').value = 'New Player';
  await h.dispatch('welcomeForm', 'submit');
  const shopRequests = h.requests.filter((r) => r.path === '/api/catalog' && r.query.limit === '20');
  assert.ok(shopRequests.length >= 2);
  assert.ok(shopRequests.every((r) => Number(r.query.max) >= 499999.99));
  assert.equal(h.element('shopMax').value, '');
  const restored = harness({ engine: h.engine, savedToken: h.storage.get(SESSION_KEY) });
  await restored.evaluate('init()'); await settled();
  assert.equal(restored.element('shopMax').value, '');
  assert.ok(restored.requests.some((r) => r.path === '/api/catalog' && r.query.limit === '20' && Number(r.query.max) >= 499999.99));
});

test('custom multiplier buttons keep delegated clicks after rerender and ignore clicks while busy', async () => {
  const h = harness(); h.seed();
  await h.dispatch('multiplierSettings', 'click');
  [1.5, 2.25, 5, 10].forEach((value, index) => { h.element(`multiplier${index}`).value = String(value); });
  await h.dispatch('multiplierForm', 'submit');
  assert.equal(h.evaluate('target.price'), 225);
  assert.deepEqual(JSON.parse(h.storage.get(PREFS_KEY)).multipliers, [1.5, 2.25, 5, 10]);
  h.evaluate('activeMultiplier=null; renderSelection()');
  await h.clickDataset({ multiplier: h.presets[1].dataset.multiplier });
  assert.equal(h.evaluate('target.price'), 225);
  const requestCount = h.requests.length;
  h.evaluate('busy=true; renderSelection()');
  await h.clickDataset({ multiplier: '10' });
  assert.equal(h.requests.length, requestCount);
  assert.ok(h.presets.every((button) => button.disabled));
  h.evaluate('busy=false'); h.element('multiplier0').value = '1';
  await h.dispatch('multiplierForm', 'submit');
  assert.match(h.element('multiplierError').textContent, /1,01/);
  assert.equal(h.plain('prefs.multipliers')[0], 1.5);
});

test('repeated upgrade clicks issue one request, persist before animation, and never open a result popup', async () => {
  const h = harness(); const original = h.seed();
  h.evaluate('prefs.fast=true');
  const spinning = h.evaluate('upgrade()'); await h.evaluate('upgrade()'); await settled();
  assert.equal(h.requests.filter((r) => r.path === '/api/upgrade').length, 1);
  assert.notEqual(h.storage.get(SESSION_KEY), original.token);
  assert.equal(h.evaluate('busy'), true);
  assert.ok(h.trace.indexOf('audio:create') < h.trace.indexOf('fetch:/api/upgrade'));
  await h.finishAnimation(); await spinning;
  assert.equal(h.plain('player.inventory')[0].id, 'skin-200');
  assert.equal(h.dialogs.length, 0);
  assert.match(h.element('statusLine').textContent, /Успех/);
  assert.doesNotMatch(pageSource, /id="resultDialog"/);
});

test('777 refuses a base chance below 50% even when displayed chance rounds to 50%', async () => {
  const h = harness(); h.seed(249.99, 500);
  await h.dispatch('luckyToggle', 'click');
  assert.equal(h.element('chanceValue').textContent, '50%');
  assert.equal(h.element('upgradeButton').disabled, true);
  await h.evaluate('upgrade()');
  assert.equal(h.requests.filter((r) => r.path === '/api/upgrade').length, 0);
});

test('777 sends its flag, wins at exactly 50%, and restores the authoritative remaining count', async () => {
  const h = harness({ random: () => 0 }); h.seed(10, 20); h.evaluate('prefs.fast=true');
  await h.dispatch('luckyToggle', 'click');
  const spinning = h.evaluate('upgrade()'); await h.finishAnimation(); await spinning;
  const request = h.requests.find((r) => r.path === '/api/upgrade');
  assert.equal(request.body.lucky, true); assert.equal(request.body.phoenix, false);
  assert.equal(h.plain('player.inventory')[0].id, 'skin-20');
  assert.equal(h.element('luckyCount').textContent, '2');
  assert.equal(h.evaluate('luckyArmed'), false);
  const restored = harness({ engine: h.engine, savedToken: h.storage.get(SESSION_KEY) });
  await restored.evaluate('init()');
  assert.equal(restored.element('luckyCount').textContent, '2');
});

test('an exhausted 777 snapshot disarms the booster and re-enables an otherwise valid upgrade immediately', () => {
  const h = harness(); let session = h.seed(100, 300);
  session = h.engine.buy(session.token, 'skin-10');
  for (const price of [20, 40, 80]) {
    const item = session.player.inventory.find((entry) => entry.price < 100);
    session = h.engine.upgrade(session.token, item.inventoryId, `skin-${price}`, { lucky: true });
  }
  h.evaluate('luckyArmed=true; renderSelection()');
  assert.equal(h.element('upgradeButton').disabled, true);
  h.context.otherTabSnapshot = session;
  h.evaluate('saveSnapshot(otherTabSnapshot)');
  assert.equal(h.evaluate('luckyArmed'), false);
  assert.equal(h.element('luckyToggle').disabled, true);
  assert.equal(h.element('upgradeButton').disabled, false);
});

test('Phoenix keeps the source on ten losses, decrements only server snapshots, and turns off when exhausted', async () => {
  const h = harness({ random: () => 0 }); const original = h.seed(); h.evaluate('prefs.fast=true');
  await h.dispatch('phoenixToggle', 'click');
  for (let count = 9; count >= 0; count--) {
    const spinning = h.evaluate('upgrade()');
    await h.dispatch('phoenixToggle', 'click'); // repeated interaction while busy cannot disarm the request
    await h.finishAnimation(); await spinning;
    assert.equal(h.element('phoenixCount').textContent, String(count));
    assert.equal(h.plain('player.inventory')[0].inventoryId, original.player.inventory[0].inventoryId);
    assert.equal(h.evaluate('source.inventoryId'), original.player.inventory[0].inventoryId);
  }
  assert.equal(h.evaluate('phoenixArmed'), false); assert.equal(h.element('phoenixToggle').disabled, true);
  const finalSpin = h.evaluate('upgrade()'); await h.finishAnimation(); await finalSpin;
  assert.equal(h.plain('player.inventory').length, 0);
  const upgrades = h.requests.filter((r) => r.path === '/api/upgrade');
  assert.ok(upgrades.slice(0, 10).every((r) => r.body.phoenix));
  assert.equal(upgrades[10].body.phoenix, false);
});

test('rotation schedules ticks while moving and respects muting during the same animation', async () => {
  const h = harness(); h.evaluate('prefs.fast=true; primeAudio()');
  const spinning = h.evaluate('animatePointer(180)');
  h.frame(50);
  assert.ok(h.audio.some((oscillator) => oscillator.type === 'triangle' && oscillator.stoppedAt > oscillator.startedAt));
  h.evaluate('prefs.sound=false'); const count = h.audio.length;
  await h.finishAnimation(); await spinning;
  assert.equal(h.audio.length, count);
  const muted = h.evaluate('animatePointer(90)'); await h.finishAnimation(); await muted;
  assert.equal(h.audio.length, count);
  assert.match(h.element('pointer').getAttribute('transform'), /^rotate\(/);
});

test('a reset from another tab during animation is applied after the spin', async () => {
  const h = harness(); h.seed(); h.evaluate('prefs.fast=true');
  const spinning = h.evaluate('upgrade()'); await settled();
  await h.storageEvent(null); assert.equal(h.reloads, 0);
  await h.finishAnimation(); await spinning;
  assert.equal(h.reloads, 1); assert.equal(h.storage.has(SESSION_KEY), false);
});
