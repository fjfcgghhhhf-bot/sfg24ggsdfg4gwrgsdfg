import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {createCommunity,DEFAULT_WHEEL_STYLE} from '../lib/community.mjs';
import {createFirebase} from '../lib/firebase.mjs';
import {createGame} from '../lib/game.mjs';
import {createApplication} from '../server.mjs';

function memoryDatabase(){
  const data={},listeners=new Map();let queue=Promise.resolve();
  const read=async(path)=>{let value=data;for(const key of path.split('/'))value=value?.[key];return structuredClone(value??null);};
  async function write(path,value){const parts=path.split('/');let node=data;for(const key of parts.slice(0,-1))node=node[key]||={};if(value===null)delete node[parts.at(-1)];else node[parts.at(-1)]=structuredClone(value);for(const [root,callback]of listeners)callback(await read(root));}
  return {read,write,subscribe(path,callback){listeners.set(path,callback);return()=>listeners.delete(path);},transaction(path,update){const next=queue.then(async()=>{const value=update(await read(path));if(value!==undefined)await write(path,value);return value;});queue=next.catch(()=>{});return next;}};
}
const config={secret:'community-test-secret-with-at-least-32-chars',goalCode:'1234567890',artworks:[{name:'Skin',weapon:'AWP',image:'/assets/test.png',rarity:'blue'}],random:()=>.5};
test('presence counts players once, expires absent players, and colors survive a new community instance',async()=>{
  let now=100000;const database=memoryDatabase(),community=await createCommunity({database,now:()=>now});
  const alice={id:'alice',nickname:'Alice'},bob={id:'bob',nickname:'Bob'};
  try{
    await community.heartbeat(alice);await community.heartbeat(alice);await community.heartbeat(bob);assert.equal(community.online().length,2);
    now+=65001;assert.equal(community.online().length,0);await community.heartbeat(alice);assert.equal(community.online().length,1);
    const style={start:'#123456',end:'#AbCDEF',pointer:'#abcdef',center:'#123456'};
    await community.saveStyle(alice,style);assert.equal(community.style('alice').end,'#abcdef');
    await assert.rejects(community.saveStyle(alice,{...style,start:'url(javascript:x)'}),/цвета/);
    community.close();const restored=await createCommunity({database,now:()=>now});assert.equal(restored.style('alice').pointer,'#abcdef');restored.close();
  }finally{community.close();}
});
test('chat is bounded, validates messages, enforces delay and deduplicates retries',async()=>{
  let now=100000;const database=memoryDatabase(),community=await createCommunity({database,now:()=>now}),alice={id:'alice',nickname:'Alice'};
  try{
    const id=randomUUID();await community.message(alice,'<img onerror=x>',id);await community.message(alice,'<img onerror=x>',id);assert.equal(community.snapshot().messages.length,1);
    await assert.rejects(community.message(alice,'spam',randomUUID()),{code:'CHAT_RATE_LIMIT'});
    await assert.rejects(community.message(alice,'x'.repeat(301),randomUUID()),{code:'INVALID_MESSAGE'});
    await assert.rejects(community.message({id:'bob',nickname:'Bob'},'changed',id),{code:'MESSAGE_CONFLICT'});
    for(let i=0;i<105;i++){now+=3001;await community.message(alice,String(i),randomUUID());}assert.equal(community.snapshot().messages.length,100);
  }finally{community.close();}
});
test('targeted battles reserve their opponent and expose accurate spin timestamps without session secrets',async()=>{
  const game=createGame(config),a=game.start('Alice'),b=game.start('Bob'),c=game.start('Charlie');
  const created=game.battles.create(a.token,100,2,b.player.id);
  assert.throws(()=>game.battles.join(c.token,created.battle.id),{code:'BATTLE_RESERVED'});
  assert.throws(()=>game.battles.decline(c.token,created.battle.id),{code:'BATTLE_RESERVED'});
  const declined=game.battles.decline(b.token,created.battle.id);assert.equal(declined.battle.status,'cancelled');assert.equal(game.resume(a.token).player.balance,500);
  game.battles.decline(b.token,created.battle.id);assert.equal(game.resume(a.token).player.balance,500);
  const next=game.battles.create(game.resume(a.token).token,100,2,b.player.id);game.battles.join(b.token,next.battle.id);
  const spun=game.battles.upgrade(next.token,next.battle.id,next.battle.players[0].chains[0].id,'skin-100',0,false,true);
  const spin=spun.battle.players[0].lastSpin;assert.equal(spin.angle,180);assert.equal(spin.chance,50);assert.equal(spin.duration,867);assert.equal(spin.turns,1);assert.equal(spun.spinTurns,spin.turns);
  const database=memoryDatabase(),community=await createCommunity({database});
  try{await community.publishBattle(spun.battle);await community.publishBattle(next.battle);assert.equal(community.snapshot().battles[0].revision,spun.battle.revision);assert.equal(community.snapshot().battles[0].players[0].lastSpin.id,spin.id);for(const secret of [a.token,b.token,config.goalCode])assert.ok(!JSON.stringify(community.snapshot()).includes(secret));}finally{community.close();}
});
test('HTTP chat and challenges require identity and online presence; decline refunds the creator',async()=>{
  const game=createGame(config),community=await createCommunity({database:memoryDatabase()}),server=createApplication({game,community});
  await new Promise((done)=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
  async function post(path,body){const r=await fetch(`${base}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  try{
    const a=game.start('Alice'),b=game.start('Bob');
    assert.equal((await post('chat',{token:'invalid',text:'hi',requestId:randomUUID()})).status,401);
    assert.equal((await post('challenge',{token:a.token,playerId:b.player.id,amount:100,count:2})).data.code,'PLAYER_OFFLINE');
    await post('presence',{token:b.token});const created=await post('challenge',{token:a.token,playerId:b.player.id,amount:100,count:2});assert.equal(created.status,200);assert.equal(created.data.player.balance,400);
    assert.equal(community.snapshot().battles[0].targetPlayerId,b.player.id);
    await post('battle/decline',{token:b.token,battleId:created.data.battle.id});assert.equal(game.resume(a.token).player.balance,500);
    const chat=await post('chat',{token:b.token,text:'Hello',requestId:randomUUID()});assert.equal(chat.status,200);assert.equal(chat.data.message.nickname,'Bob');
  }finally{server.closeAllConnections();await new Promise((done)=>server.close(done));}
});
test('Firebase REST signs server authentication and retries conflicting conditional writes',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),calls=[];let value={count:1},conflict=true;
  const client=createFirebase({url:'https://unit-test.firebaseio.com/',serviceAccount:{client_email:'test@unit.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})},fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});if(String(url).includes('oauth2'))return Response.json({access_token:'test-token',expires_in:3600});
    assert.equal(options.headers.Authorization,'Bearer test-token');
    if(options.method==='GET')return Response.json(value,{headers:{etag:'"version"'}});
    assert.equal(options.headers['if-match'],'"version"');if(conflict){conflict=false;value={count:2};return Response.json(value,{status:412});}
    value=JSON.parse(options.body);return Response.json(value);
  }});
  assert.deepEqual(await client.transaction('counter',(old)=>({count:old.count+1})),{count:3});assert.equal(calls.filter((c)=>c.url.includes('oauth2')).length,1);client.close();
});
test('real Firebase stores and streams messages, presence and colors in an isolated test namespace',{skip:!process.env.FIREBASE_SERVICE_ACCOUNT,timeout:45000},async()=>{
  const database=createFirebase({url:process.env.FIREBASE_DATABASE_URL||'https://upgrader-c809b-default-rtdb.firebaseio.com/',serviceAccount:process.env.FIREBASE_SERVICE_ACCOUNT}),root=`upgrade/tests/${randomUUID()}`;
  await database.readRules();
  const community=await createCommunity({database,root}),alice={id:'alice',nickname:'Firebase test'};
  let unsubscribe,deadline;
  const received=new Promise((resolve,reject)=>{
    deadline=setTimeout(()=>reject(new Error('Firebase stream did not deliver the test message.')),15000);
    unsubscribe=database.subscribe(root,(data)=>{if(data?.messages&&data?.styles?.alice&&data?.presence?.alice){clearTimeout(deadline);resolve(data);}});
  });
  received.catch(()=>{});
  try{await community.heartbeat(alice);await community.saveStyle(alice,DEFAULT_WHEEL_STYLE);await community.message(alice,'isolated test',randomUUID());const stored=await database.read(root);assert.equal(stored.presence.alice.nickname,'Firebase test');assert.equal(Object.keys(stored.messages).length,1);assert.equal(stored.styles.alice.start,DEFAULT_WHEEL_STYLE.start);const streamed=await received;assert.equal(Object.values(streamed.messages)[0].text,'isolated test');}
  finally{clearTimeout(deadline);unsubscribe?.();await database.write(root,null);community.close();}
});

test('Firebase SSE parses split UTF-8 and CRLF frames, nested patches and deletion',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const frames=[
    ['put',{path:'/',data:{presence:{a:{nickname:'Алиса'}},messages:{old:{text:'old'}}}}],
    ['patch',{path:'/',data:{'presence/b':{nickname:'Боб'},'messages/old':null}}],
    ['put',{path:'/presence/a',data:null}],
  ].map(([event,data])=>`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`).join('');
  const bytes=new TextEncoder().encode(frames);
  const client=createFirebase({url:'https://unit-test.firebaseio.com/',serviceAccount:{client_email:'test@unit.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})},fetchImpl:async(url)=>{
    if(String(url).includes('oauth2'))return Response.json({access_token:'test-token',expires_in:3600});
    return new Response(new ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=3)controller.enqueue(bytes.slice(offset,offset+3));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  const snapshots=[];let unsubscribe,timeout;
  try{await new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('No SSE snapshot')),2000);unsubscribe=client.subscribe('test',(data)=>{snapshots.push(data);if(snapshots.length===3)resolve();});});
    assert.equal(snapshots[0].presence.a.nickname,'Алиса');assert.equal(snapshots[1].presence.b.nickname,'Боб');assert.ok(!snapshots[1].messages.old);assert.ok(!snapshots[2].presence.a);
  }finally{clearTimeout(timeout);unsubscribe?.();client.close();}
});

test('Firebase locks public access when exported rules contain comments',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let saved;
  const client=createFirebase({url:'https://unit-test.firebaseio.com/',serviceAccount:{client_email:'test@unit.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})},fetchImpl:async(url,options)=>{
    if(String(url).includes('oauth2'))return Response.json({access_token:'test-token',expires_in:3600});
    assert.ok(String(url).endsWith('/.settings/rules.json'));
    if(options.method==='GET')return new Response('{"rules": {\n ".read": true, // default expiry\n /* Firebase comment */ ".write": true,"other":{".validate":"newData.val() === \\\"https://example.com/*safe*/\\\"",},\n },}');
    saved=JSON.parse(options.body);return Response.json(saved);
  }});
  await client.secure();assert.equal(saved.rules['.read'],false);assert.equal(saved.rules['.write'],false);assert.deepEqual(saved.rules.upgrade,{'.read':false,'.write':false});assert.match(saved.rules.other['.validate'],/https:\/\/example.com\/\*safe\*\//);client.close();
});
