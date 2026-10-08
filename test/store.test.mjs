import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createGame} from '../lib/game.mjs';
import {createPostgresStore} from '../lib/store.mjs';

// Runs in Render's build environment against an isolated temporary schema.
// The live game tables and real player records are never touched.
test('Postgres serializes two server instances and restores deposits, profiles and one-time payouts', {skip:!process.env.DATABASE_URL,timeout:45000}, async()=>{
  const {Pool}=await import('pg'),connectionString=process.env.DATABASE_URL;
  const admin=new Pool({connectionString,max:1,connectionTimeoutMillis:8000});
  const schema='test_'+randomUUID().replaceAll('-','');
  const stores=[];
  const config={secret:'postgres-test-only-secret-at-least-32-chars',goalCode:'1234567890',artworks:[{name:'Skin',weapon:'AWP',image:'/assets/test.png',rarity:'gold'}],random:()=>.5};
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    async function instance() {
      const game=createGame(config),pool=new Pool({connectionString,max:2,options:`-c search_path=${schema}`,connectionTimeoutMillis:8000});
      const store=await createPostgresStore(game,connectionString,{pool});stores.push(store);return {game,run:(fn)=>store.run(()=>fn(game))};
    }
    const one=await instance(),two=await instance();
    const alice=await one.run((g)=>g.start('Alice')),bob=await two.run((g)=>g.start('Bob')),third=await two.run((g)=>g.start('Third'));
    const created=await one.run((g)=>g.battles.create(alice.token,100,2));
    const joins=await Promise.allSettled([one.run((g)=>g.battles.join(bob.token,created.battle.id)),two.run((g)=>g.battles.join(third.token,created.battle.id))]);
    assert.equal(joins.filter((r)=>r.status==='fulfilled').length,1);
    const opponent=joins.find((r)=>r.status==='fulfilled').value;
    const chain=created.battle.players[0].chains[0];
    await one.run((g)=>g.battles.upgrade(created.token,created.battle.id,chain.id,'skin-100',0,false));
    await Promise.all([one.run((g)=>g.battles.stop(created.token,created.battle.id)),two.run((g)=>g.battles.stop(opponent.token,created.battle.id))]);
    const restored=await instance();
    assert.equal((await restored.run((g)=>g.resume(alice.token))).player.balance,600);
    assert.equal((await restored.run((g)=>g.profile(alice.player.id))).bestDrop.item.price,100);
    await restored.run((g)=>g.battles.tick());
    assert.equal((await one.run((g)=>g.resume(alice.token))).player.balance,600);
  } finally {
    for(const store of stores)await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
