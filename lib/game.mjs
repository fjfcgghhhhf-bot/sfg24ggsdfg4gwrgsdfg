import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createBattles } from './battles.mjs';

export class GameError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400, snapshot) {
    super(message);
    this.code = code;
    this.status = status;
    this.snapshot = snapshot;
  }
}

export const GOAL_PRICE = 500_000;
export const MAX_UPGRADE_CHANCE = 75;
const MAX_INVENTORY = 200;
const MAX_SESSIONS = 20_000;
const MAX_TOKEN_LENGTH = 100_000;
const INITIAL_BOOSTERS = { luckyRemaining: 3 };
const WEAR = ['Прямо с завода', 'Немного поношенное', 'После полевых испытаний', 'Поношенное', 'Закалённое в боях'];

function priceInCents(price) { return Math.round(price * 100); }

function validBoosters(boosters) {
  return boosters && typeof boosters === 'object' && !Array.isArray(boosters)
    && Number.isInteger(boosters.luckyRemaining) && boosters.luckyRemaining >= 0 && boosters.luckyRemaining <= INITIAL_BOOSTERS.luckyRemaining;
}

/** Every 10-ruble tier is available. Prices are fictional game values. */
export function createCatalog(artworks) {
  if (!Array.isArray(artworks) || !artworks.length) throw new Error('Skin artwork catalog is empty.');
  const art = artworks.map((entry) => ({
    name: String(entry.name || 'CS2 Skin'),
    weapon: String(entry.weapon || 'CS2'),
    image: String(entry.image || '/assets/code.svg'),
    rarity: typeof entry.rarity === 'object' ? String(entry.rarity.color || '#ab5cff') : String(entry.rarity || '#ab5cff'),
  }));
  function artworkIndex(price) {
    const tier = Math.floor(price / 10) - 1;
    // The bundled collection is ordered from everyday weapons to rare trophies.
    // Small injected collections (for example tests) still use the full collection.
    if (art.length < 40) return tier % art.length;
    const [start, end, firstPrice] = price <= 500 ? [0, 20, 10]
      : price <= 5_000 ? [20, 40, 510]
        : price <= 50_000 ? [40, Math.min(55, art.length), 5_010]
          : [Math.max(0, art.length - 20), art.length, 50_010];
    // A 40-image collection may not have the optional third group.
    if (start >= end) return tier % art.length;
    return start + Math.max(0, Math.floor((price - firstPrice) / 10)) % (end - start);
  }
  function get(id) {
    if (id === 'code') return { id: 'code', name: 'Зашифрованный код', weapon: 'Финальная цель', image: '/assets/code.svg', rarity: '#ffdf00', price: GOAL_PRICE };
    const match = typeof id === 'string' ? /^skin-([1-9][0-9]{0,5})(?:\.([0-9]{1,2}))?$/.exec(id) : null;
    const cents = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : 0;
    if (!Number.isSafeInteger(cents) || cents < 1_000 || cents >= GOAL_PRICE * 100) throw new GameError('Предмет не найден.', 'ITEM_NOT_FOUND', 404);
    const price = cents / 100;
    const tier = Math.floor(price / 10) - 1;
    return { ...art[artworkIndex(price)], id: `skin-${price}`, price, wear: WEAR[Math.floor(tier / art.length) % WEAR.length] };
  }
  function list(query = {}) {
    const min = query.min === '' || query.min == null ? 0 : Number(query.min);
    const max = query.max === '' || query.max == null ? GOAL_PRICE : Number(query.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) throw new GameError('Проверьте диапазон цен.', 'INVALID_FILTER');
    const text = String(query.q || '').trim().toLocaleLowerCase('ru').slice(0, 100);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 40)));
    const ids = [];
    const first = Math.max(10, Math.ceil(min / 10) * 10);
    const last = Math.min(GOAL_PRICE - 10, Math.floor(max / 10) * 10);
    // Filter the small artwork set first, then map matching price tiers.
    const matches = art.map((entry) => `${entry.weapon} ${entry.name}`.toLocaleLowerCase('ru').includes(text));
    if (min === max && min >= 10 && min < GOAL_PRICE) {
      let exact;
      try { exact = get(`skin-${min}`); } catch { throw new GameError('Цена должна содержать не больше двух знаков после запятой.', 'INVALID_FILTER'); }
      if (matches[artworkIndex(exact.price)]) ids.push(exact.id);
    } else {
      for (let price = first; price <= last; price += 10) if (matches[artworkIndex(price)]) ids.push(`skin-${price}`);
    }
    if (min <= GOAL_PRICE && max >= GOAL_PRICE && `код code зашифрованный финальная цель`.includes(text)) ids.push('code');
    if (query.sort === 'desc') ids.reverse();
    const pages = Math.max(1, Math.ceil(ids.length / limit));
    const page = Math.max(1, Math.min(pages, Math.floor(Number(query.page) || 1)));
    return { items: ids.slice((page - 1) * limit, page * limit).map(get), total: ids.length, page, pages };
  }
  return { get, list };
}

export function createGame({ secret, goalCode, artworks, random = () => randomInt(0, 1_000_000_000) / 1_000_000_000, maxSessions = MAX_SESSIONS, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  if (!/^[0-9]{10}$/.test(goalCode)) throw new Error('GOAL_CODE must be exactly ten digits.');
  const key = createHash('sha256').update(secret).digest();
  const catalog = createCatalog(artworks);
  const sessions = new Map();
  const changes = new Map();
  const changed = (kind,id,data) => changes.set(`${kind}:${id}`,{kind,id,data:structuredClone(data)});
  function saveRecord(record) { sessions.set(record.state.sid,record);changed('session',record.state.sid,record);return record; }
  const newProfile = () => ({createdAt:now(),history:[],best:null,battleWins:0,battlesPlayed:0});

  function seal(state) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('upgrade-session-v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  function unseal(token) {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid token');
      const raw = Buffer.from(token, 'base64url');
      if (raw.length < 29 || raw.toString('base64url') !== token) throw new Error('Invalid token');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from('upgrade-session-v1'));
      decipher.setAuthTag(raw.subarray(12, 28));
      const state = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
      if (![1, 2, 3].includes(state.v) || typeof state.sid !== 'string' || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.inventory) || state.inventory.length > MAX_INVENTORY || typeof state.nickname !== 'string' || typeof state.unlocked !== 'boolean' || !Number.isSafeInteger(state.wins) || state.wins < 0 || !Number.isSafeInteger(state.attempts) || state.attempts < state.wins) throw new Error('Invalid state');
      if (state.v === 1) {
        if (!Number.isSafeInteger(state.balance) || state.balance < 0 || !Number.isSafeInteger(state.balance * 100)) throw new Error('Invalid legacy balance');
        state.balanceCents = state.balance * 100;
        delete state.balance;
        if (!Object.hasOwn(state, 'boosters')) state.boosters = { ...INITIAL_BOOSTERS };
      }
      if (!Number.isSafeInteger(state.balanceCents) || state.balanceCents < 0 || !validBoosters(state.boosters)) throw new Error('Invalid balance or boosters');
      const migrated = state.v !== 3 || Object.keys(state.boosters).length !== 1;
      state.boosters = { luckyRemaining: state.boosters.luckyRemaining };
      state.v = 3;
      const inventoryIds = new Set();
      for (const entry of state.inventory) {
        if (!entry || typeof entry.inventoryId !== 'string' || !entry.inventoryId || inventoryIds.has(entry.inventoryId)) throw new Error('Invalid inventory');
        inventoryIds.add(entry.inventoryId);
        entry.itemId = catalog.get(entry.itemId).id;
      }
      return { state, migrated };
    } catch {
      throw new GameError('Не удалось восстановить сессию. Начните новую игру.', 'INVALID_SESSION', 401);
    }
  }
  function snapshot(record) {
    const state = record.state;
    return {
      token: record.token,
      player: {
        id: state.sid,
        revision: state.revision,
        nickname: state.nickname,
        balance: state.balanceCents / 100,
        inventory: state.inventory.map(({ inventoryId, itemId }) => ({ ...catalog.get(itemId), inventoryId })),
        wins: state.wins,
        attempts: state.attempts,
        boosters: { ...state.boosters },
        ...(state.unlocked ? { unlockedCode: goalCode } : {}),
      },
    };
  }
  function remember(state) {
    const record = { state, token: seal(state), revoked: false, profile:sessions.get(state.sid)?.profile || newProfile() };
    return saveRecord(record);
  }
  function capacity() {
    if (sessions.size >= maxSessions) throw new GameError('Сервер занят. Попробуйте немного позже.', 'SERVER_BUSY', 503);
  }
  function resolve(token, mutation = false) {
    const { state, migrated } = unseal(token);
    if (migrated) token = seal(state);
    let record = sessions.get(state.sid);
    if (record?.revoked) throw new GameError('Сессия завершена. Начните новую игру.', 'SESSION_RESET', 410);
    if (!record) {
      capacity();
      record = { state, token, revoked: false, profile:newProfile() };
      saveRecord(record);
    } else if (state.revision > record.state.revision) {
      // After restart an older tab may reconnect first. A newer authenticated
      // save must advance the in-memory revision instead of losing progress.
      record = { ...record, state, token, revoked: false };
      saveRecord(record);
    }
    if (mutation && record.state.revision !== state.revision) throw new GameError('Данные обновились. Попробуйте ещё раз.', 'STALE_SESSION', 409, snapshot(record));
    return record;
  }
  function mutate(token, change) {
    const record = resolve(token, true);
    // Work on a copy so failed validation cannot partially spend a balance or item.
    const next = structuredClone(record.state);
    const extra = change(next) || {};
    next.revision += 1;
    return { ...snapshot(remember(next)), ...extra };
  }
  function itemInInventory(state, inventoryId) {
    const index = state.inventory.findIndex((entry) => entry.inventoryId === inventoryId);
    if (index < 0) throw new GameError('Этого предмета уже нет в инвентаре.', 'INVENTORY_ITEM_NOT_FOUND', 404);
    return { index, item: catalog.get(state.inventory[index].itemId) };
  }
  function buyCart(token, items) {
    return mutate(token, (state) => {
      if (!Array.isArray(items) || !items.length || items.length > MAX_INVENTORY) throw new GameError('Добавьте скины в корзину.', 'INVALID_CART');
      const entries = items.map((entry) => {
        if (!entry || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > MAX_INVENTORY) throw new GameError('Некорректное количество скинов.', 'INVALID_CART');
        const item = catalog.get(entry.itemId);
        if (item.id === 'code') throw new GameError('Код можно получить только апгрейдом.', 'GOAL_NOT_BUYABLE');
        return { item, quantity: entry.quantity };
      });
      const count = entries.reduce((sum, entry) => sum + entry.quantity, 0);
      if (state.inventory.length + count > MAX_INVENTORY) throw new GameError('В инвентаре нет места. Продайте несколько предметов.', 'INVENTORY_FULL');
      const total = entries.reduce((sum, entry) => sum + priceInCents(entry.item.price) * entry.quantity, 0);
      if (state.balanceCents < total) throw new GameError('Недостаточно средств на балансе.', 'INSUFFICIENT_FUNDS');
      state.balanceCents -= total;
      for (const { item, quantity } of entries) for (let i = 0; i < quantity; i++) state.inventory.push({ inventoryId: randomUUID(), itemId: item.id });
      return { purchase: { count, total: total / 100 } };
    });
  }
  function recordUpgrade(id,source,target,result,mode='upgrade',battleId=null) {
    const record=sessions.get(id),profile=structuredClone(record.profile || newProfile());
    const entry={id:randomUUID(),at:now(),sourceId:source.id,targetId:target.id,won:result.won,chance:result.chance,lucky:result.luckyUsed===true,mode,battleId};
    profile.history.unshift(entry);profile.history.length=Math.min(200,profile.history.length);
    if(result.won && (!profile.best || target.price>catalog.get(profile.best.itemId).price))profile.best={itemId:target.id,at:entry.at,mode};
    saveRecord({...record,profile});
  }
  const battles=createBattles({catalog,sessions,resolve,snapshot,remember,saveRecord,recordUpgrade,random,now,changed,GameError});
  return {
    catalog,
    battles,
    takeChanges(){const entries=[...changes.values()];changes.clear();return entries;},
    hydrate(rows,{clear=false}={}) {
      if(clear){sessions.clear();battles.clear();changes.clear();}
      for(const row of rows) {if(row.kind==='session')sessions.set(row.id,row.data);else if(row.kind==='battle')battles.hydrate(row.id,row.data);}
    },
    profile(id,page=1) {
      const record=sessions.get(id);if(!record)throw new GameError('Профиль пока недоступен. Игроку нужно снова открыть сайт.','PROFILE_NOT_FOUND',404);
      const profile=record.profile || newProfile(),number=Math.max(1,Math.floor(Number(page)||1));
      return {id,nickname:record.state.nickname,balance:record.state.balanceCents/100,retired:record.revoked,createdAt:profile.createdAt,
        wins:record.state.wins,attempts:record.state.attempts,battleWins:profile.battleWins,battlesPlayed:profile.battlesPlayed,
        bestDrop:profile.best ? {...profile.best,item:catalog.get(profile.best.itemId)}:null,
        history:profile.history.slice((number-1)*20,number*20).map((entry)=>({...entry,source:catalog.get(entry.sourceId),target:catalog.get(entry.targetId)})),
        page:number,pages:Math.max(1,Math.ceil(profile.history.length/20)),historyCount:profile.history.length};
    },
    start(nickname) {
      if (typeof nickname !== 'string') throw new GameError('Введите ник.', 'INVALID_NICKNAME');
      nickname = nickname.normalize('NFC').trim();
      if (nickname.length < 2 || nickname.length > 24 || /[\p{Cc}\p{Cf}<>]/u.test(nickname)) throw new GameError('Ник должен содержать от 2 до 24 символов.', 'INVALID_NICKNAME');
      capacity();
      return snapshot(remember({ v: 3, sid: randomUUID(), revision: 0, nickname, balanceCents: 50_000, inventory: [], wins: 0, attempts: 0, boosters: { ...INITIAL_BOOSTERS }, unlocked: false }));
    },
    resume(token) { return snapshot(resolve(token)); },
    buyCart,
    buy(token, itemId) {
      const { purchase, ...result } = buyCart(token, [{ itemId, quantity: 1 }]);
      return result;
    },
    sell(token, inventoryId) {
      return mutate(token, (state) => {
        const { index, item } = itemInInventory(state, inventoryId);
        if (item.id === 'code') throw new GameError('Код — ваша финальная награда. Его нельзя продать.', 'GOAL_NOT_SELLABLE');
        const cents = priceInCents(item.price);
        if (!Number.isSafeInteger(state.balanceCents + cents)) throw new GameError('Достигнут предел баланса.', 'BALANCE_LIMIT');
        state.balanceCents += cents;
        state.inventory.splice(index, 1);
      });
    },
    sellAll(token) {
      return mutate(token, (state) => {
        const items = state.inventory.filter((entry) => entry.itemId !== 'code');
        if (!items.length) throw new GameError('Нет скинов для продажи.', 'NO_ITEMS_TO_SELL');
        const total = items.reduce((sum, entry) => sum + priceInCents(catalog.get(entry.itemId).price), 0);
        if (!Number.isSafeInteger(state.balanceCents + total)) throw new GameError('Достигнут предел баланса.', 'BALANCE_LIMIT');
        state.balanceCents += total;
        state.inventory = state.inventory.filter((entry) => entry.itemId === 'code');
        return { sale: { count: items.length, total: total / 100 } };
      });
    },
    upgrade(token, inventoryId, targetId, boosters = {}) {
      if (!boosters || typeof boosters !== 'object' || Array.isArray(boosters) || (boosters.lucky !== undefined && typeof boosters.lucky !== 'boolean')) throw new GameError('Настройки бустеров должны быть true или false.', 'INVALID_BOOSTER');
      const lucky = boosters.lucky === true;
      let original;
      const payload=mutate(token, (state) => {
        const { index, item: source } = itemInInventory(state, inventoryId);
        original=source;
        const target = catalog.get(targetId);
        if (target.price <= source.price) throw new GameError('Выберите предмет дороже исходного.', 'TARGET_TOO_CHEAP');
        if (priceInCents(source.price) * 100 > priceInCents(target.price) * MAX_UPGRADE_CHANCE) throw new GameError('Максимальный шанс апгрейда — 75%. Выберите более дорогую цель или более дешёвый исходный скин.', 'CHANCE_TOO_HIGH');
        const probability = priceInCents(source.price) / priceInCents(target.price);
        if (lucky && state.boosters.luckyRemaining === 0) throw new GameError('Заряды Счастливчика закончились.', 'LUCKY_EXHAUSTED');
        if (lucky && probability < 0.5) throw new GameError('Счастливчик доступен при базовом шансе от 50%.', 'LUCKY_CHANCE_TOO_LOW');
        const draw = random();
        if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Random source out of range.');
        const angle = lucky ? 180 - 180 * probability + draw * 360 * probability : draw * 360;
        const won = lucky || (angle >= 180 - 180 * probability && angle < 180 + 180 * probability);
        state.inventory.splice(index, 1);
        if (lucky) state.boosters.luckyRemaining -= 1;
        state.attempts += 1;
        if (won) {
          state.inventory.push({ inventoryId: randomUUID(), itemId: target.id });
          state.wins += 1;
          if (targetId === 'code') state.unlocked = true;
        }
        return { result: { won, chance: probability * 100, angle, item: target, luckyUsed: lucky } };
      });
      recordUpgrade(payload.player.id,original,payload.result.item,payload.result);
      return payload;
    },
    reset(token) {
      const record = resolve(token);
      battles.assertCanReset(record.state.sid);
      // Keep a tombstone so previous tokens cannot revive the session in this process.
      record.revoked = true;
      saveRecord(record);
      return { ok: true };
    },
  };
}
