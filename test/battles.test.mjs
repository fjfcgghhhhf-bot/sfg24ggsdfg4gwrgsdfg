import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame} from '../lib/game.mjs';
import {createApplication} from '../server.mjs';
const config={secret:'battle-test-secret-at-least-32-characters',goalCode:'1234567890',artworks:[{name:'Test skin',weapon:'AWP',image:'/assets/test.png',rarity:'gold'}]};
function setup() {let time=1700000000000,draw=.5;const game=createGame({...config,now:()=>time,random:()=>draw});return {game,advance:(ms)=>{time+=ms;},draw:(value)=>{draw=value;}};}
const error=(code)=>(e)=>e.code===code;
function duel(game,amount=100,count=2) {
  let alice=game.start('Алиса'),bob=game.start('Борис');
  const created=game.battles.create(alice.token,amount,count);alice=created;
  bob=game.battles.join(bob.token,created.battle.id);
  return {alice,bob,id:created.battle.id};
}
function spin(game,session,id,index=0,targetId='skin-100') {
  const state=game.battles.state(session.token,id),chain=state.battle.players.find((p)=>p.id===session.player.id).chains[index];
  return game.battles.upgrade(session.token,id,chain.id,targetId,chain.attempts,false);
}
test('deposits split exactly and identical sets start on one shared five-minute deadline',()=>{
  const {game}=setup(),{alice,bob,id}=duel(game,100.01,3);
  const battle=game.battles.state(alice.token,id).battle;
  assert.equal(alice.player.balance,399.99);assert.equal(bob.player.balance,399.99);
  assert.equal(battle.bank,200.02);assert.equal(battle.endsAt-battle.startedAt,300000);
  assert.deepEqual(battle.players[0].chains.map((c)=>c.item.price),[33.34,33.34,33.33]);
  assert.deepEqual(battle.players[0].chains.map((c)=>c.itemId),battle.players[1].chains.map((c)=>c.itemId));
  assert.notEqual(battle.players[0].chains[0].id,battle.players[1].chains[0].id);
  assert.equal(game.resume(alice.token).player.inventory.length,0);
});
test('waiting cancellation and expiration return deposits once, insufficient funds and self-join do not charge',()=>{
  const {game,advance}=setup(),alice=game.start('Alice'),bob=game.start('Bob');
  for(const [amount,count] of [[1000,2],[10,2],[0,1],[100,0],[100,11],[100.001,1]])assert.throws(()=>game.battles.create(alice.token,amount,count));
  assert.equal(game.resume(alice.token).player.balance,500);
  const waiting=game.battles.create(alice.token,100,2);
  assert.throws(()=>game.battles.join(waiting.token,waiting.battle.id),error('SELF_BATTLE'));
  assert.throws(()=>game.battles.cancel(bob.token,waiting.battle.id),error('CANNOT_CANCEL_BATTLE'));
  assert.throws(()=>game.reset(waiting.token),error('BATTLE_IN_PROGRESS'));
  const cancelled=game.battles.cancel(waiting.token,waiting.battle.id);
  assert.equal(cancelled.player.balance,500);
  assert.throws(()=>game.battles.cancel(cancelled.token,waiting.battle.id));
  assert.throws(()=>game.battles.join(bob.token,waiting.battle.id));
  const another=game.battles.create(cancelled.token,300,3);advance(900000);
  assert.equal(game.battles.state(another.token).player.balance,500);
  assert.equal(game.battles.list().battles.length,0);
});
test('a third player cannot take a filled slot and one player cannot reserve multiple battles',()=>{
  const {game}=setup(),{alice,bob,id}=duel(game),third=game.start('Third');
  assert.throws(()=>game.battles.join(third.token,id),error('BATTLE_NOT_WAITING'));
  assert.throws(()=>game.battles.create(alice.token,100,1),error('BATTLE_IN_PROGRESS'));
  assert.throws(()=>spin(game,third,id));
  assert.throws(()=>game.battles.stop(third.token,id),error('NOT_BATTLE_PLAYER'));
  assert.equal(game.resume(third.token).player.balance,500);
  assert.equal(game.resume(bob.token).player.balance,400);
});
test('unlimited chains, 75 percent cap, booster prohibition, stop, and one-time payout',()=>{
  const {game,advance}=setup(),{alice,bob,id}=duel(game);
  const original=game.battles.state(alice.token,id).battle.players[0].chains[0];
  assert.throws(()=>game.battles.upgrade(alice.token,id,original.id,'skin-100',0,true),error('BATTLE_BOOSTER_DISABLED'));
  assert.throws(()=>game.battles.upgrade(alice.token,id,original.id,'skin-55.55',0,false),error('CHANCE_TOO_HIGH'));
  let result=spin(game,alice,id);
  assert.equal(result.result.won,true);assert.equal(result.battle.players[0].total,150);
  assert.throws(()=>spin(game,alice,id,0,'skin-200'),error('BATTLE_SPIN_PENDING'));
  advance(2600);
  assert.throws(()=>game.battles.upgrade(alice.token,id,original.id,'skin-200',0,false),error('STALE_BATTLE'));
  result=spin(game,alice,id,0,'skin-200');advance(2600);
  result=spin(game,alice,id,0,'skin-400');advance(2600);
  assert.equal(result.battle.players[0].attempts,3,'more attempts than the two starting chains');
  game.battles.stop(alice.token,id);
  assert.throws(()=>spin(game,alice,id,1),error('BATTLE_STOPPED'));
  const ended=game.battles.stop(bob.token,id);
  assert.equal(ended.battle.winnerId,alice.player.id);assert.equal(ended.battle.status,'finished');
  assert.equal(game.resume(alice.token).player.balance,600);assert.equal(game.resume(bob.token).player.balance,400);
  game.battles.stop(bob.token,id);advance(600000);game.battles.tick();
  assert.equal(game.resume(alice.token).player.balance,600);
  assert.deepEqual(game.resume(alice.token).player.inventory,[]);
  assert.equal(game.resume(alice.token).player.boosters.luckyRemaining,3);
  const profile=game.profile(alice.player.id);
  assert.equal(profile.history.length,3);assert.equal(profile.bestDrop.item.price,400);assert.equal(profile.battleWins,1);
});
test('timeout and both-empty chains settle automatically; ties refund both and code cannot be won in a battle',()=>{
  const {game,advance,draw}=setup();let pair=duel(game);
  const c=game.battles.state(pair.alice.token,pair.id).battle.players[0].chains[0];
  assert.throws(()=>game.battles.upgrade(pair.alice.token,pair.id,c.id,'code',0,false),error('BATTLE_GOAL_DISABLED'));
  advance(300000);assert.throws(()=>spin(game,pair.alice,pair.id),error('BATTLE_NOT_ACTIVE'));
  assert.equal(game.resume(pair.alice.token).player.balance,500);assert.equal(game.resume(pair.bob.token).player.balance,500);
  pair=duel(game,100,1);draw(0);spin(game,pair.alice,pair.id,0,'skin-200');spin(game,pair.bob,pair.id,0,'skin-200');
  assert.equal(game.battles.state(pair.alice.token,pair.id).battle.tie,true);
  assert.equal(game.resume(pair.alice.token).player.balance,500);
  pair=duel(game,100,1);draw(.5);spin(game,pair.alice,pair.id,0,'skin-200');advance(300000);game.battles.tick();
  assert.equal(game.resume(pair.alice.token).player.balance,600);
});
test('persisted records restore offline payouts and profiles and do not reapply settlement',()=>{
  const {game,advance}=setup(),{alice,bob,id}=duel(game);
  spin(game,alice,id);advance(300000);game.battles.tick();
  const rows=game.takeChanges(),restored=createGame(config);restored.hydrate(rows,{clear:true});
  assert.equal(restored.battles.state(alice.token,id).player.balance,600);
  assert.equal(restored.battles.state(bob.token,id).player.balance,400);
  assert.equal(restored.profile(alice.player.id).bestDrop.item.price,100);
  restored.battles.tick();assert.equal(restored.resume(alice.token).player.balance,600);
  assert.equal(restored.takeChanges().length,0);
});
test('profiles use distinct IDs for equal nicknames, keep the best lost-later drop, and expose no code or tokens',()=>{
  const {game,draw}=setup();let alice=game.start('Same'),bob=game.start('Same');
  alice=game.buy(alice.token,'skin-100');alice=game.upgrade(alice.token,alice.player.inventory[0].inventoryId,'skin-200');
  draw(0);alice=game.upgrade(alice.token,alice.player.inventory[0].inventoryId,'skin-400');
  const profile=game.profile(alice.player.id);
  assert.notEqual(alice.player.id,bob.player.id);assert.equal(profile.bestDrop.item.price,200);
  assert.deepEqual(profile.history.map((e)=>e.won),[false,true]);assert.equal(profile.balance,400);
  assert.equal(game.profile(bob.player.id).history.length,0);
  for(const value of [config.goalCode,alice.token,'unlockedCode','boosters','inventoryId'])assert.ok(!JSON.stringify(profile).includes(value));
});
test('HTTP battle flow enforces identity, deposits and stop semantics for independent clients',async()=>{
  const {game}=setup(),server=createApplication({game});await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function post(route,body){const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  try {
    const a=(await post('session',{nickname:'HTTP Alice'})).data,b=(await post('session',{nickname:'HTTP Bob'})).data;
    const created=(await post('battle/create',{token:a.token,amount:100,count:2})).data;
    const joined=(await post('battle/join',{token:b.token,battleId:created.battle.id})).data;
    assert.equal(joined.battle.status,'active');assert.equal(joined.player.balance,400);
    const finishedA=await post('battle/stop',{token:created.token,battleId:created.battle.id});assert.equal(finishedA.status,200);
    const finishedB=(await post('battle/stop',{token:joined.token,battleId:created.battle.id})).data;
    assert.equal(finishedB.battle.tie,true);assert.equal(finishedB.player.balance,500);
    assert.equal((await post('battle/state',{token:'bad'})).status,401);
  }finally{server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));}
});
