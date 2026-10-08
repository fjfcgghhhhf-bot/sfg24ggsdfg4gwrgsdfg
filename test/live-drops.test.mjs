import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../lib/game.mjs';
import { createLiveDrops } from '../lib/live-drops.mjs';
import { createApplication } from '../server.mjs';

test('all viewers receive real wins, reconnects catch up, and private results never enter the feed', async () => {
  let draw = .5;
  const goalCode = '9876543210';
  const game = createGame({ secret: 'feed-test-secret-with-at-least-32-characters', goalCode, random: () => draw,
    artworks: [{ name: 'Redline', weapon: 'AK-47', image: '/assets/skins/redline.png', rarity: 'red' }] });
  const server = createApplication({ game });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connections = [];
  async function post(route, body) {
    const response = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function connect() {
    const controller = new AbortController();
    connections.push(controller);
    const response = await fetch(base + '/api/live-drops/stream', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    return async () => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
          const data = frame.match(/^data: (.+)$/m), event = frame.match(/^event: (.+)$/m);
          if (data && event) return { event: event[1], data: JSON.parse(data[1]) };
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE remains open');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
  }
  try {
    const [viewerA,viewerB] = await Promise.all([connect(),connect()]);
    assert.deepEqual(await viewerA(), { event: 'snapshot', data: [] });
    assert.deepEqual(await viewerB(), { event: 'snapshot', data: [] });
    const alice = (await post('session', { nickname: 'Алиса' })).data;
    const bought = (await post('buy', { token: alice.token, itemId: 'skin-100' })).data;
    const body = { token: bought.token, inventoryId: bought.player.inventory[0].inventoryId, targetId: 'skin-200' };
    const won = (await post('upgrade', body)).data;
    assert.equal(won.result.won, true);
    const [a,b] = await Promise.all([viewerA(),viewerB()]);
    assert.deepEqual(a,b);
    assert.equal(a.event,'drop');
    assert.equal(a.data.nickname,'Алиса');
    assert.equal(a.data.item.price,200);
    assert.equal((await post('upgrade',body)).status,409,'replayed upgrade is rejected');
    const bob = (await post('session', { nickname: 'Борис' })).data;
    const bobBought = (await post('buy', { token: bob.token, itemId: 'skin-100' })).data;
    draw = 0;
    assert.equal((await post('upgrade', { token: bobBought.token, inventoryId: bobBought.player.inventory[0].inventoryId, targetId: 'skin-200' })).data.result.won,false);
    draw = .5;
    const codeWin = (await post('upgrade', { token: won.token, inventoryId: won.player.inventory[0].inventoryId, targetId: 'code' })).data;
    assert.equal(codeWin.player.unlockedCode,goalCode);
    const [codeA,codeB] = await Promise.all([viewerA(),viewerB()]);
    assert.deepEqual(codeA,codeB);
    assert.equal(codeA.data.item.id,'code');
    assert.ok(!JSON.stringify(codeA).includes(goalCode));
    const viewerC = await connect(), snapshot = await viewerC();
    assert.deepEqual(snapshot,{ event:'snapshot',data:[codeA.data,a.data] });
    const publicFeed = await (await fetch(base+'/api/live-drops')).json();
    assert.deepEqual(publicFeed.drops,snapshot.data);
    for (const drop of publicFeed.drops) assert.deepEqual(Object.keys(drop).sort(),['at','id','item','lucky','mode','nickname','profileId']);
    const profile=await (await fetch(base+'/api/profile?id='+a.data.profileId)).json();
    assert.equal(profile.nickname,'Алиса');assert.equal(profile.history.length,2);
    assert.ok(!JSON.stringify(profile).includes(goalCode));
    const text = JSON.stringify(publicFeed);
    for (const privateField of ['token','unlockedCode','inventoryId','boosters',goalCode]) assert.ok(!text.includes(privateField));
    assert.equal((await post('live-drops', { nickname:'Fake win' })).status,404,'clients cannot publish events');
  } finally {
    for (const controller of connections) controller.abort();
    server.closeAllConnections();
    await new Promise((resolve)=>server.close(resolve));
  }
});

test('feed is bounded and returns independent snapshots, with no fabricated losses', () => {
  const feed = createLiveDrops();
  const payload = (price,won=true) => ({ player:{nickname:'Игрок',unlockedCode:'1234567890'},result:{won,luckyUsed:true,item:{id:`skin-${price}`,price,name:'Skin',weapon:'AWP',image:'/assets/test.png',rarity:'gold'}} });
  feed.publish(payload(10,false));
  assert.deepEqual(feed.list(),[]);
  for (let price=10;price<50;price++) feed.publish(payload(price));
  const list = feed.list();
  assert.equal(list.length,30);
  assert.equal(list[0].item.price,49);
  assert.equal(list.at(-1).item.price,20);
  assert.equal(new Set(list.map((entry)=>entry.id)).size,30);
  list[0].nickname='changed';
  assert.equal(feed.list()[0].nickname,'Игрок');
  feed.close();
});
