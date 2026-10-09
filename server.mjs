import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGame, GameError } from './lib/game.mjs';
import { loadConfiguration } from './lib/config.mjs';
import { createLiveDrops } from './lib/live-drops.mjs';
import { createPostgresStore } from './lib/store.mjs';
import {createFirebase} from './lib/firebase.mjs';
import {createCommunity} from './lib/community.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const BODY_LIMIT = 131_072;

function sendJSON(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readJSON(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new GameError('Ожидается JSON.', 'INVALID_CONTENT_TYPE', 415);
  if (Number(request.headers['content-length']) > BODY_LIMIT) {
    request.resume();
    throw new GameError('Запрос слишком большой.', 'PAYLOAD_TOO_LARGE', 413);
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new GameError('Запрос слишком большой.', 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    return body;
  } catch { throw new GameError('Некорректный JSON.', 'INVALID_JSON'); }
}

export function createApplication({ game, publicDir = path.join(DIRECTORY, 'public'), trustProxy = false, store, community }) {
  publicDir = path.resolve(publicDir);
  const rates = new Map();
  const liveDrops = createLiveDrops();
  const run=(fn)=>store ? store.run(()=>{game.battles.tick();return fn();}):Promise.resolve().then(()=>{game.battles.tick();return fn();});
  const published=new Map();
  const requireCommunity=()=>{if(!community)throw new GameError('Общение временно недоступно. Попробуйте позже.','COMMUNITY_OFFLINE',503);return community;};
  async function publish(battle){if(community&&battle&&published.get(battle.id)!==battle.revision){await community.publishBattle(battle);published.set(battle.id,battle.revision);}}
  let lastSweep = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health' || url.pathname === '/api/health') return sendJSON(response, 200, { status: 'ok' });
      if (url.pathname.startsWith('/api/')) {
        const now = Date.now();
        if (now - lastSweep > 60_000) {
          for (const [ip, rate] of rates) if (rate.until <= now) rates.delete(ip);
          lastSweep = now;
        }
        const forwarded = trustProxy ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 80) : '';
        const ip = forwarded || request.socket.remoteAddress || 'unknown';
        let rate = rates.get(ip);
        if (!rate || rate.until <= now) { rate = { count: 0, until: now + 60_000 }; rates.set(ip, rate); }
        if (++rate.count > 240) {
          response.setHeader('Retry-After', Math.ceil((rate.until - now) / 1000));
          throw new GameError('Слишком много запросов. Подождите немного.', 'RATE_LIMITED', 429);
        }
        if (request.method === 'GET' && url.pathname === '/api/catalog') return sendJSON(response, 200, game.catalog.list(Object.fromEntries(url.searchParams)));
        if (request.method === 'GET' && url.pathname === '/api/item') return sendJSON(response, 200, game.catalog.get(url.searchParams.get('id')));
        if (request.method === 'GET' && url.pathname === '/api/community') return sendJSON(response,200,requireCommunity().snapshot());
        if (request.method === 'GET' && url.pathname === '/api/community/stream') return requireCommunity().connect(response);
        if (request.method === 'GET' && url.pathname === '/api/profile') return sendJSON(response,200,await run(()=>game.profile(url.searchParams.get('id'),url.searchParams.get('page'))));
        if (request.method === 'GET' && url.pathname === '/api/battles') return sendJSON(response,200,await run(()=>game.battles.list()));
        if (request.method === 'GET' && url.pathname === '/api/live-drops') return sendJSON(response, 200, { drops: liveDrops.list() });
        if (request.method === 'GET' && url.pathname === '/api/live-drops/stream') return liveDrops.connect(response);
        if (request.method !== 'POST') throw new GameError('Метод не поддерживается.', 'METHOD_NOT_ALLOWED', 405);
        const body = await readJSON(request);
        if(['/api/presence','/api/chat','/api/wheel-style','/api/challenge'].includes(url.pathname)){
          const social=requireCommunity(),identity=await run(()=>game.resume(body.token));
          if(url.pathname==='/api/presence')return sendJSON(response,200,await social.heartbeat(identity.player));
          if(url.pathname==='/api/chat')return sendJSON(response,200,await social.message(identity.player,body.text,body.requestId));
          if(url.pathname==='/api/wheel-style')return sendJSON(response,200,await social.saveStyle(identity.player,body.style));
          if(!social.isOnline(body.playerId))throw new GameError('Игрок сейчас не в сети.','PLAYER_OFFLINE');
          const created=await run(()=>game.battles.create(body.token,body.amount,body.count,body.playerId));
          try{await publish(created.battle);}catch{
            const cancelled=await run(()=>game.battles.cancel(created.token,created.battle.id));
            throw new GameError('Вызов не доставлен. Взнос возвращён.','CHALLENGE_UNDELIVERED',503,cancelled);
          }
          return sendJSON(response,200,created);
        }
        const handlers = {
          '/api/session': () => game.start(body.nickname),
          '/api/resume': () => game.resume(body.token),
          '/api/buy': () => game.buy(body.token, body.itemId),
          '/api/buy-cart': () => game.buyCart(body.token, body.items),
          '/api/sell': () => game.sell(body.token, body.inventoryId),
          '/api/sell-all': () => game.sellAll(body.token),
          '/api/upgrade': () => game.upgrade(body.token, body.inventoryId, body.targetId, { lucky: body.lucky }),
          '/api/reset': () => game.reset(body.token),
          '/api/battle/state': () => game.battles.state(body.token,body.battleId),
          '/api/battle/create': () => game.battles.create(body.token,body.amount,body.count),
          '/api/battle/join': () => game.battles.join(body.token,body.battleId),
          '/api/battle/cancel': () => game.battles.cancel(body.token,body.battleId),
          '/api/battle/decline': () => game.battles.decline(body.token,body.battleId),
          '/api/battle/stop': () => game.battles.stop(body.token,body.battleId),
          '/api/battle/upgrade': () => game.battles.upgrade(body.token,body.battleId,body.chainId,body.targetId,body.attempt,body.lucky,body.fast),
        };
        if (!Object.hasOwn(handlers, url.pathname)) throw new GameError('Маршрут не найден.', 'NOT_FOUND', 404);
        const retiredId=url.pathname==='/api/reset'?(await run(()=>game.resume(body.token))).player.id:null;
        const payload = await run(handlers[url.pathname]);
        if(payload.battle)await publish(payload.battle).catch(()=>console.error('Battle broadcast delayed; retrying on the next tick.'));
        if(retiredId&&community)await community.retire(retiredId).catch(()=>console.error('Presence cleanup delayed.'));
        if (url.pathname === '/api/upgrade'||url.pathname === '/api/battle/upgrade') liveDrops.publish(payload);
        return sendJSON(response, 200, payload);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new GameError('Метод не поддерживается.', 'METHOD_NOT_ALLOWED', 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new GameError('Некорректный адрес.', 'BAD_URL'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part.startsWith('.'))) throw new GameError('Файл не найден.', 'NOT_FOUND', 404);
      const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(publicDir, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !MIME[path.extname(filename).toLowerCase()]) throw new GameError('Файл не найден.', 'NOT_FOUND', 404);
      let details;
      try { details = await stat(filename); } catch { throw new GameError('Файл не найден.', 'NOT_FOUND', 404); }
      if (!details.isFile()) throw new GameError('Файл не найден.', 'NOT_FOUND', 404);
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename).toLowerCase()], 'Content-Length': details.size, 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache' });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(filename);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof GameError) return sendJSON(response, error.status, { error: error.message, code: error.code, ...error.snapshot });
      console.error('Request failed:', error.message);
      sendJSON(response, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.', code: 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => liveDrops.close());
  let ticking=false;
  const timer=setInterval(async()=>{if(ticking)return;ticking=true;try{const battles=await run(()=>community?game.battles.recent():[]);for(const battle of battles)await publish(battle);}catch{console.error('Battle timer or broadcast temporarily unavailable.');}finally{ticking=false;}},5000);
  timer.unref();server.on('close',()=>{clearInterval(timer);community?.close();});
  return server;
}

export async function startServer() {
  const config = await loadConfiguration(DIRECTORY);
  const artworks = JSON.parse(await readFile(path.join(DIRECTORY, 'public/assets/skins.json'), 'utf8'));
  const game = createGame({ ...config, artworks });
  if(process.env.NODE_ENV==='production'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required for profiles and battles.');
  const store=process.env.DATABASE_URL ? await createPostgresStore(game,process.env.DATABASE_URL):undefined;
  if(store)await store.run(()=>game.battles.tick());
  let community;
  if(process.env.FIREBASE_SERVICE_ACCOUNT){
    const database=createFirebase({url:process.env.FIREBASE_DATABASE_URL||'https://upgrader-c809b-default-rtdb.firebaseio.com/',serviceAccount:process.env.FIREBASE_SERVICE_ACCOUNT});
    await database.secure();community=await createCommunity({database});
  }
  const server = createApplication({ game, store, community, trustProxy: process.env.RENDER === 'true' || process.env.TRUST_PROXY === 'true' });
  if(store)server.on('close',()=>store.close().catch(()=>{}));
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Upgrade is ready on http://localhost:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
