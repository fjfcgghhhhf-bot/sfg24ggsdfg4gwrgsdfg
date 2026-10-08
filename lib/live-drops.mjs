import { randomUUID } from 'node:crypto';

// A shared, bounded feed for this server. Never publish session snapshots.
export function createLiveDrops({ limit = 30, heartbeatMs = 25_000 } = {}) {
  const entries = [], clients = new Set();
  let heartbeat;
  function write(client, event, payload) {
    if (client.destroyed || client.writableEnded) return;
    // Disconnect slow consumers instead of retaining an unbounded write buffer.
    if (!client.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) client.destroy();
  }
  return {
    list() { return structuredClone(entries); },
    publish({ player, result }) {
      if (!result?.won) return;
      const { id, name, weapon, image, rarity, price, wear } = result.item;
      const drop = { id: randomUUID(), profileId:player.id, mode:result.mode || 'upgrade', nickname: player.nickname, at: Date.now(), lucky: result.luckyUsed === true,
        item: { id, name, weapon, image, rarity, price, ...(wear ? { wear } : {}) } };
      entries.unshift(drop);
      entries.length = Math.min(entries.length, limit);
      for (const client of clients) write(client, 'drop', drop);
    },
    connect(response) {
      if (clients.size >= 1000) {
        response.writeHead(503, { 'Retry-After': '15' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      clients.add(response);
      response.on('close', () => {
        clients.delete(response);
        if (!clients.size) { clearInterval(heartbeat); heartbeat = undefined; }
      });
      response.write('retry: 4000\n\n');
      // Every reconnect receives the latest snapshot, including missed events.
      write(response, 'snapshot', entries);
      heartbeat ||= setInterval(() => {
        for (const client of clients) if (!client.write(': heartbeat\n\n')) client.destroy();
      }, heartbeatMs);
      heartbeat.unref();
    },
    close() {
      clearInterval(heartbeat);
      heartbeat = undefined;
      for (const client of clients) client.destroy();
      clients.clear();
    },
  };
}
