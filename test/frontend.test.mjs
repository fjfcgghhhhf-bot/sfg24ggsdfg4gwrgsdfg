import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createGame, GameError } from '../lib/game.mjs';

// Unit-level DOM, animation and Web Audio doubles. These tests do not launch,
// control, or connect to a browser, and never touch a real player's session.
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appWithoutStartup = appSource.replace(/\binit\(\);\s*$/, '');
const SESSION_KEY = 'upgrade.session.v1';
const PREFS_KEY = 'upgrade.preferences.v1';
const TEST_SECRET = 'frontend-test-secret-01234567890123456789';
const artwork = [{ name: 'Test skin', weapon: 'AWP', image: '/assets/test.png', rarity: 'blue' }];
const settled = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function harness({ random = () => 0.5, engine, savedToken, preferences, intercept, reducedMotion=false, animationRandom=()=>.5 } = {}) {
  engine ||= createGame({ secret: TEST_SECRET, goalCode: '1234567890', artworks: artwork, random });
  const elements = new Map(), documentListeners = new Map(), windowListeners = new Map();
  const storage = new Map(), frames = new Map(), timers = new Map();
  const requests = [], dialogs = [], audio = [], trace = [], streams = [];
  class EventSource {
    constructor(url) { this.url=url;this.listeners=new Map();streams.push(this); }
    addEventListener(name,callback) { this.listeners.set(name,callback); }
    emit(name,data) { this.listeners.get(name)?.({data:JSON.stringify(data)}); }
    close() { this.closed=true; }
  }
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
      showModal() { dialogs.push(id); this.open = true; }, close() { this.open = false; for(const callback of listeners.get('close') || [])callback(); }, scrollIntoView() {},
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
    AudioContext, matchMedia: () => ({ matches: reducedMotion }),
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
      else if (path === '/api/buy-cart') result = engine.buyCart(body.token, body.items);
      else if (path === '/api/sell') result = engine.sell(body.token, body.inventoryId);
      else if (path === '/api/sell-all') result = engine.sellAll(body.token);
      else if (path === '/api/upgrade') result = engine.upgrade(body.token, body.inventoryId, body.targetId, { lucky: body.lucky });
      else if (path === '/api/reset') result = engine.reset(body.token);
      else throw new Error(`Unexpected route: ${path}`);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      return { ok: false, status: error.status, json: async () => ({ error: error.message, code: error.code, ...error.snapshot }) };
    }
  }
  const context = vm.createContext({
    document, window, fetch: fetchDouble, URLSearchParams, Intl, console, EventSource,
    Math:Object.assign(Object.create(Math),{random:animationRandom}),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    location: { reload() { reloads++; } }, navigator: { clipboard: { writeText: async () => {} } },
    performance: { now: () => clock }, requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
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
  return { engine, context, evaluate, plain, seed, install, dispatch, clickDataset, finishAnimation, frame, requests, storage, dialogs, audio, trace, presets, streams, windowEvent(name) { for(const listener of windowListeners.get(name)||[])listener(); }, element: (id) => elements.get(id), get pendingFrames() { return frames.size; }, get reloads() { return reloads; }, async storageEvent(value) { for (const listener of windowListeners.get('storage') || []) await listener({ key: SESSION_KEY, newValue: value }); } };
}

function feedDrop(id='drop-1') {
  return {id,nickname:'Другой игрок',at:1700000000000,lucky:true,item:{id:'skin-200',name:'Redline',weapon:'AK-47',price:200,image:'/assets/skins/redline.png',rarity:'red'}};
}

test('live feed escapes names, deduplicates snapshots and limits history to 30 actual events',()=>{
  const h=harness();h.evaluate('connectLiveDrops()');
  const stream=h.streams[0],drop=feedDrop();
  stream.emit('snapshot',[]);
  assert.match(h.element('liveFeedList').innerHTML,/Кто сорвёт первый дроп/);
  drop.nickname='"<img onerror=alert(1)>"';drop.item.name='<script>bad()</script>';
  stream.emit('drop',drop);
  const markup=h.element('liveFeedList').innerHTML;
  assert.match(markup,/&lt;img onerror=alert\(1\)&gt;/);
  assert.ok(!markup.includes('<script>'));
  assert.match(markup,/live-drop-new/);
  stream.emit('drop',drop);
  assert.equal(h.plain('liveDrops').length,1);
  assert.ok(!h.element('liveFeedList').innerHTML.includes('live-drop-new'));
  for(let i=2;i<=40;i++)stream.emit('drop',feedDrop(`drop-${i}`));
  assert.equal(h.plain('liveDrops').length,30);
  assert.equal(h.plain('liveDrops')[0].id,'drop-40');
  stream.emit('snapshot',[feedDrop('drop-41'),...h.plain('liveDrops')]);
  assert.equal(h.plain('liveDrops')[0].id,'drop-41');
  assert.equal(h.plain('liveDrops').length,30);
  stream.emit('drop',{id:'bad'});
  stream.listeners.get('drop')({data:'not JSON'});
  assert.equal(h.plain('liveDrops').length,30);
});

test('live drops wait until the pointer stops before revealing any new wins',async()=>{
  const h=harness();h.seed();h.evaluate('connectLiveDrops()');
  const stream=h.streams[0];stream.emit('snapshot',[]);
  const before=h.element('liveFeedList').innerHTML;
  const spin=h.evaluate('upgrade()');await settled();
  assert.equal(h.evaluate('liveFeedPaused'),true);
  stream.emit('drop',feedDrop());
  assert.equal(h.element('liveFeedList').innerHTML,before);
  await h.finishAnimation();await spin;
  assert.equal(h.evaluate('liveFeedPaused'),false);
  assert.match(h.element('liveFeedList').innerHTML,/Другой игрок/);
});

test('live feed preserves history on connection errors and releases its connection when leaving',()=>{
  const h=harness();h.evaluate('connectLiveDrops();connectLiveDrops()');
  assert.equal(h.streams.length,1);
  const stream=h.streams[0];stream.emit('open');stream.emit('snapshot',[feedDrop()]);
  assert.equal(h.element('liveFeedDot').classList.contains('connected'),true);
  const before=h.element('liveFeedList').innerHTML;
  stream.emit('error');
  assert.equal(h.element('liveFeedList').innerHTML,before);
  assert.equal(h.element('liveFeedStatus').textContent,'Переподключаемся…');
  assert.equal(h.element('liveFeedDot').classList.contains('connected'),false);
  h.windowEvent('pagehide');assert.equal(stream.closed,true);
  h.windowEvent('pageshow');assert.equal(h.streams.length,2);
  h.streams[1].emit('snapshot',[feedDrop('missed'),feedDrop()]);
  assert.equal(h.plain('liveDrops').length,2);
});

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
  assert.equal(request.body.lucky, true); assert.equal(Object.hasOwn(request.body, 'phoenix'), false);
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

test('a legacy save with Phoenix charges resumes normally but a loss removes the skin without Phoenix controls or requests', async () => {
  const legacyState = {
    v: 2, sid: 'legacy-frontend-session', revision: 4, nickname: 'Legacy Player', balanceCents: 40000,
    inventory: [{ inventoryId: 'legacy-skin', itemId: 'skin-100' }], wins: 0, attempts: 0,
    boosters: { phoenixRemaining: 10, luckyRemaining: 2 }, unlocked: false,
  };
  const iv = randomBytes(12), key = createHash('sha256').update(TEST_SECRET).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('upgrade-session-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(legacyState), 'utf8'), cipher.final()]);
  const savedToken = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const h = harness({ random: () => 0, savedToken });
  await h.evaluate('init()');
  assert.equal(h.element('nickname').textContent, 'Legacy Player');
  assert.equal(h.element('luckyCount').textContent, '2');
  assert.deepEqual(h.plain('player.boosters'), { luckyRemaining: 2 });
  assert.equal(h.element('phoenixToggle'), undefined);
  assert.doesNotMatch(pageSource, /phoenix|феникс/i);
  assert.doesNotMatch(appSource, /phoenix|феникс/i);
  await h.evaluate('selectSource("legacy-skin")');
  h.evaluate('prefs.fast=true');
  const spinning = h.evaluate('upgrade()'); await h.finishAnimation(); await spinning;
  assert.equal(h.plain('player.inventory').length, 0);
  assert.equal(h.evaluate('source'), null);
  assert.equal(h.element('inventoryCount').textContent, '0');
  assert.match(h.element('statusLine').textContent, /Неудача.*потерян/);
  const request = h.requests.find((r) => r.path === '/api/upgrade');
  assert.equal(Object.hasOwn(request.body, 'phoenix'), false);
  assert.equal(request.body.lucky, false);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.engine.resume(h.storage.get(SESSION_KEY)).player.inventory.length, 0);
});

test('rotation schedules ticks while moving and respects muting during the same animation', async () => {
  const h = harness(); h.evaluate('prefs.fast=true; primeAudio()');
  const spinning = h.evaluate('animatePointer(180)');
  h.frame(150);
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

test('cart keeps quantities across catalog pages and checkout buys once without changing the shop or selected skin', async () => {
  const gate=deferred();
  const h=harness({intercept:(request)=>request.path==='/api/buy-cart'?gate.promise:undefined});
  h.seed();const originalId=h.evaluate('source.inventoryId');
  await h.evaluate('mode="shop";loadShop()');
  await h.clickDataset({action:'add-cart',key:'skin-10'});
  await h.clickDataset({action:'add-cart',key:'skin-10'});
  await h.clickDataset({action:'add-cart',key:'skin-20'});
  assert.equal(h.element('cartCount').textContent,'3');
  assert.equal(h.requests.filter((r)=>r.path==='/api/buy-cart').length,0);
  await h.evaluate('shopPage=2;loadShop()');
  assert.equal(h.element('cartCount').textContent,'3');
  await h.dispatch('cartButton','click');
  const purchase=h.dispatch('checkoutButton','click');
  await settled();await h.dispatch('checkoutButton','click');
  assert.equal(h.requests.filter((r)=>r.path==='/api/buy-cart').length,1);
  gate.resolve();await purchase;
  assert.equal(h.evaluate('mode'),'shop');assert.equal(h.evaluate('shopPage'),2);
  assert.equal(h.evaluate('source.inventoryId'),originalId);
  assert.equal(h.evaluate('target.price'),200);
  assert.equal(h.evaluate('player.balance'),360);
  assert.equal(h.plain('player.inventory').length,4);
  assert.equal(h.element('cartCount').textContent,'0');
  assert.equal(h.element('cartDialog').open,false);
  const restored=h.engine.resume(h.storage.get(SESSION_KEY));
  assert.equal(restored.player.balance,360);assert.equal(restored.player.inventory.length,4);
});

test('cart can reduce and remove quantities and prevents checkout above the balance',async()=>{
  const h=harness();h.seed();await h.evaluate('mode="shop";loadShop()');
  await h.clickDataset({action:'add-cart',key:'skin-200'});
  await h.clickDataset({action:'add-cart',key:'skin-200'});
  await h.clickDataset({action:'add-cart',key:'skin-10'});
  assert.equal(h.element('checkoutButton').disabled,true);
  assert.match(h.element('cartNotice').textContent,/Не хватает 10/);
  await h.evaluate('checkout()');assert.equal(h.requests.filter((r)=>r.path==='/api/buy-cart').length,0);
  await h.clickDataset({action:'cart-minus',key:'skin-200'});
  assert.equal(h.element('checkoutButton').disabled,false);
  await h.clickDataset({action:'cart-remove',key:'skin-200'});
  await h.clickDataset({action:'cart-minus',key:'skin-10'});
  assert.equal(h.element('cartCount').textContent,'0');
  assert.equal(h.element('checkoutButton').disabled,true);
});

test('a rejected cart is retained and does not partially spend money',async()=>{
  const h=harness();let session=h.seed();await h.evaluate('mode="shop";loadShop()');
  await h.clickDataset({action:'add-cart',key:'skin-200'});
  session=h.engine.buy(session.token,'skin-300');
  await h.evaluate('checkout()');
  assert.equal(h.evaluate('player.balance'),100);
  assert.equal(h.plain('player.inventory').length,2);
  assert.equal(h.element('cartCount').textContent,'1');
  assert.equal(h.element('checkoutButton').disabled,true);
  assert.equal(h.evaluate('mode'),'shop');
});

test('a lost checkout response restores the purchase and clears the cart without buying twice',async()=>{
  const engine=createGame({secret:TEST_SECRET,goalCode:'1234567890',artworks:artwork});
  const h=harness({engine:{...engine,buyCart(...args){engine.buyCart(...args);throw new Error('Connection interrupted');}}});
  h.seed();await h.evaluate('mode="shop";loadShop()');
  await h.clickDataset({action:'add-cart',key:'skin-10'});
  await h.evaluate('checkout()');
  assert.equal(h.evaluate('player.balance'),390);
  assert.equal(h.plain('player.inventory').length,2);
  assert.equal(h.element('cartCount').textContent,'0');
  await h.evaluate('checkout()');
  assert.equal(h.requests.filter((r)=>r.path==='/api/buy-cart').length,1);
  assert.equal(engine.resume(h.storage.get(SESSION_KEY)).player.balance,390);
});

test('sell all removes skins and the selected source, preserves the code, and disables empty inventory actions',async()=>{
  const h=harness();let session=h.seed(10,20);
  session=h.engine.upgrade(session.token,session.player.inventory[0].inventoryId,'code');
  session=h.engine.buyCart(session.token,[{itemId:'skin-10.03',quantity:2},{itemId:'skin-22.51',quantity:1}]);
  h.install(session);await h.evaluate('selectSource(player.inventory.find((item)=>item.id!=="code").inventoryId)');
  const selling=h.clickDataset({action:'sell-all'});await h.clickDataset({action:'sell-all'});await selling;
  assert.equal(h.requests.filter((r)=>r.path==='/api/sell-all').length,1);
  assert.equal(h.evaluate('source'),null);
  assert.equal(h.evaluate('player.balance'),490);
  assert.deepEqual(h.plain('player.inventory.map((item)=>item.id)'),['code']);
  assert.equal(h.evaluate('player.unlockedCode'),'1234567890');
  assert.equal(h.element('sellAllButton').disabled,true);
  assert.equal(h.element('sellAllInline').disabled,true);
  assert.equal(h.engine.resume(h.storage.get(SESSION_KEY)).player.balance,490);
});

test('all sector animations cross 50% smoothly on a fixed circle, stay centred, and finish at the exact chance',()=>{
  const circle=pageSource.match(/<path id="winArc"[^>]* d="([^"]+)"/)[1];
  assert.equal(circle,'M 200 47 A 153 153 0 0 1 200 353 A 153 153 0 0 1 200 47');
  for(const style of ['smooth','quick','inertia']) {
    const h=harness({preferences:{zoneAnimation:style}}),arc=h.element('winArc');
    arc.setAttribute('d',circle);
    h.evaluate('winSector.set(10,{immediate:true});winSector.set(90)');
    let previous=10,intermediate=0;
    for(let frame=0;frame<65;frame++) {
      h.frame(16);
      const [win,lose]=arc.getAttribute('stroke-dasharray').split(' ').map(Number);
      const start=-Number(arc.getAttribute('stroke-dashoffset'));
      assert.ok(win>=previous && win<=90,`${style} never reverses or overshoots`);
      assert.ok(Math.abs(win+lose-100)<1e-10);
      assert.ok(Math.abs(start+win/2-50)<1e-10,'sector remains centred at 180 degrees');
      assert.equal(arc.getAttribute('d'),circle,'circle geometry never changes');
      if(win>10 && win<90)intermediate++;
      previous=win;
    }
    assert.ok(intermediate>3);assert.equal(previous,90);assert.equal(h.pendingFrames,0);
    h.evaluate('winSector.set(0.002)');h.frame(1000);
    assert.equal(h.evaluate('winSector.value'),.002);
    h.evaluate('winSector.set(99.998)');h.frame(1000);
    assert.equal(h.evaluate('winSector.value'),99.998);
  }
});

test('rapid sector retargeting starts at the visible position and keeps only one animation frame',()=>{
  const h=harness();h.evaluate('winSector.set(10,{immediate:true});winSector.set(90)');h.frame(170);
  let current=h.evaluate('winSector.value');
  for(const next of [20,80,35,95,5]) {
    h.evaluate(`winSector.set(${next})`);
    assert.equal(h.evaluate('winSector.value'),current,'retarget does not jump to an endpoint');
    assert.equal(h.pendingFrames,1);
    h.frame(33);current=h.evaluate('winSector.value');
    assert.ok(Number.isFinite(current));
  }
  h.frame(1000);assert.equal(h.evaluate('winSector.value'),5);assert.equal(h.pendingFrames,0);
});

test('repeated renders do not restart a sector animation and a spin settles the exact zone before sending its request',async()=>{
  const gate=deferred();const h=harness({intercept:(request)=>request.path==='/api/upgrade'?gate.promise:undefined});
  h.seed(100,125);h.frame(200);
  for(let i=0;i<10;i++)h.evaluate('renderSelection()');
  h.frame(300);assert.equal(h.evaluate('winSector.value'),80);assert.equal(h.pendingFrames,0);
  h.evaluate('target={...target,id:"skin-400",price:400};renderSelection()');h.frame(40);
  assert.ok(h.evaluate('winSector.value')>25);
  const spin=h.evaluate('upgrade()');
  assert.equal(h.evaluate('winSector.value'),25);assert.equal(h.evaluate('winSector.running'),false);
  assert.equal(h.element('zoneAnimationButton').disabled,true);
  gate.resolve();await h.finishAnimation();await spin;
  assert.equal(h.evaluate('winSector.value'),25,'the result zone does not reset to 50%');
});

test('animation selection persists, preview stays separate from the game, and closing it cancels its frames',async()=>{
  const h=harness();h.seed(100,200);const snapshot=h.storage.get(SESSION_KEY);
  await h.dispatch('zoneAnimationButton','click');
  assert.equal(h.element('zoneAnimationDialog').open,true);
  await h.dispatch('zone-inertia','click');h.frame(80);
  assert.equal(JSON.parse(h.storage.get(PREFS_KEY)).zoneAnimation,'inertia');
  assert.equal(h.element('zoneAnimationLabel').textContent,'Инерция');
  await h.dispatch('zonePreview10','click');
  assert.equal(h.element('zonePreviewValue').textContent,'10%');
  assert.equal(h.evaluate('winSector.value'),50);assert.equal(h.storage.get(SESSION_KEY),snapshot);
  assert.equal(h.requests.length,0,'preview never calls game APIs');
  await h.clickDataset({close:'zoneAnimationDialog'});
  assert.equal(h.pendingFrames,0);
  const restored=harness({preferences:JSON.parse(h.storage.get(PREFS_KEY))});
  restored.evaluate('renderPreferences()');assert.equal(restored.element('zone-inertia').getAttribute('aria-pressed'),'true');
});

test('reduced motion and no-animation mode apply instantly and invalid saved modes fall back to smooth',()=>{
  for(const options of [{reducedMotion:true},{preferences:{zoneAnimation:'none'}}]) {
    const h=harness(options);h.evaluate('winSector.set(12.345)');
    assert.equal(h.evaluate('winSector.value'),12.345);assert.equal(h.pendingFrames,0);
  }
  const h=harness({preferences:{zoneAnimation:'unknown'}});
  assert.equal(h.evaluate('prefs.zoneAnimation'),'smooth');
});

test('normal pointer spin starts gently, retains a long braking phase and lands without a jump',async()=>{
  const h=harness();h.evaluate('prefs.sound=false');
  const start=h.evaluate('rotation');const spin=h.evaluate('animatePointer(267.25)');
  const samples=[start];
  for(let i=0;h.pendingFrames && i<90;i++){h.frame(100);samples.push(h.evaluate('rotation'));}
  assert.equal(h.pendingFrames,0);
  await spin;
  const steps=samples.slice(1).map((value,i)=>value-samples[i]);
  assert.ok(steps.every((step)=>step>=0),'pointer never reverses');
  assert.ok(steps[0]<steps[3]/5,'gentle takeoff instead of an immediate maximum speed');
  assert.ok(steps.length>=62 && steps.length<=82);
  for(let i=Math.ceil(steps.length*.28)+1;i<steps.length;i++)assert.ok(steps[i]<=steps[i-1]+1e-8,'speed decreases throughout the long braking phase');
  assert.ok(samples.at(-1)-samples[36]>200,'substantial visible movement remains after the old 3.6-second stop');
  assert.ok(samples.at(-1)-samples.at(-11)>5,'the last second still has a visible slow approach');
  assert.ok(steps.at(-1)<.2,'last frame reaches the result without a visible snap');
  assert.equal(((h.evaluate('rotation')%360)+360)%360,267.25);
  assert.equal(h.pendingFrames,0);
});

test('pointer landing is identical across frame rates, dropped frames, both speeds and repeated spins',async()=>{
  for(const fast of [false,true]) for(const step of [1000/144,1000/60,1000/30,230]) {
    const h=harness({preferences:{fast,sound:false}});
    for(const angle of [0,359.999,126.75]) {
      const spin=h.evaluate(`animatePointer(${angle})`);
      let frames=0;while(h.pendingFrames && frames++<1300)h.frame(step);
      assert.equal(h.pendingFrames,0);await spin;
      const landed=((h.evaluate('rotation')%360)+360)%360;
      assert.ok(Math.abs(landed-angle)<1e-8,`${fast?'fast':'normal'} ${step}ms frames: ${landed}`);
    }
  }
});

test('fast pointer mode retains an extended slowing finish and reduced motion skips the spin',async()=>{
  const h=harness({preferences:{fast:true,sound:false}});
  const spin=h.evaluate('animatePointer(90)');h.frame(550);
  assert.equal(h.pendingFrames,1,'fast spin no longer ends at 550ms');
  h.frame(1050);const approaching=h.evaluate('rotation');
  assert.equal(h.pendingFrames,1);h.frame(1000);await spin;
  assert.ok(h.evaluate('rotation')>approaching);assert.equal(h.evaluate('rotation')%360,90);
  const reduced=harness({reducedMotion:true});
  const instant=reduced.evaluate('animatePointer(45)');reduced.frame(16);await instant;
  assert.equal(reduced.evaluate('rotation')%360,45);assert.equal(reduced.pendingFrames,0);assert.equal(reduced.audio.length,0);
});

test('cosmetic randomness varies consecutive spins even for the same result and never resamples on animation frames',async()=>{
  let draws=0;const h=harness({preferences:{sound:false},animationRandom:()=>{draws++;return .5;}});
  const fingerprints=[];
  for(let i=0;i<4;i++) {
    h.evaluate('rotation=180');
    const spin=h.evaluate('animatePointer(180)');const drawsAtStart=draws;
    const positions=[];
    for(let frame=0;h.pendingFrames && frame<90;frame++){h.frame(100);positions.push(h.evaluate('rotation'));}
    await spin;fingerprints.push(JSON.stringify(positions));
    assert.equal(draws,drawsAtStart,'no random jitter or curve changes while spinning');
    assert.equal(h.evaluate('rotation')%360,180);
  }
  for(let i=1;i<fingerprints.length;i++)assert.notEqual(fingerprints[i],fingerprints[i-1]);
});

test('all random motion boundaries are smooth and bounded, and random duration and turns never change the landing',async()=>{
  for(const fast of [false,true])for(const draw of [0,.5,.999999]) {
    const h=harness({preferences:{fast,sound:false},animationRandom:()=>draw});
    for(let variant=0;variant<3;variant++) {
      const motion=h.plain(`randomSpinMotion(${fast})`);
      assert.ok(motion.duration>=(fast?1800:6200) && motion.duration<=(fast?2600:8200));
      assert.ok(motion.turns>=(fast?2:4) && motion.turns<=(fast?3:6));
      assert.ok((1-motion.accelerate-motion.cruise)*motion.duration>=(fast?1300:4500),'long braking remains');
      h.context.motionFixture=motion;
      let previous=0;
      for(let sample=0;sample<=500;sample++) {
        const progress=h.evaluate(`pointerProgress(${sample/500},motionFixture)`);
        assert.ok(progress>=previous-1e-12 && progress<=1,'no bounce, reversal or overshoot');previous=progress;
      }
      for(const boundary of [motion.accelerate,motion.accelerate+motion.cruise]) {
        const delta=.00001;
        const left=h.evaluate(`(pointerProgress(${boundary},motionFixture)-pointerProgress(${boundary-delta},motionFixture))/${delta}`);
        const right=h.evaluate(`(pointerProgress(${boundary+delta},motionFixture)-pointerProgress(${boundary},motionFixture))/${delta}`);
        assert.ok(Math.abs(left-right)<1e-5,'velocity remains continuous at phase boundaries');
      }
      const spin=h.evaluate('animatePointer(71.125)');await h.finishAnimation();await spin;
      assert.ok(Math.abs(h.evaluate('rotation')%360-71.125)<1e-8);
    }
  }
});

test('motion randomness leaves upgrade outcome and probability unchanged for identical server draws',async()=>{
  for(const draw of [0,.5,.999999]) {
    const h=harness({random:()=>.5,animationRandom:()=>draw,preferences:{sound:false}});
    h.seed(100,200);const spin=h.evaluate('upgrade()');await h.finishAnimation();await spin;
    assert.equal(h.evaluate('player.inventory[0].price'),200);
    assert.equal(h.evaluate('player.wins'),1);assert.equal(h.evaluate('rotation')%360,180);
    assert.equal(h.evaluate('winSector.value'),50);
  }
});
