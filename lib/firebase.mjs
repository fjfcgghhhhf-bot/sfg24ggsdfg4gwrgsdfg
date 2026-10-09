import {createSign} from 'node:crypto';

// Server-only Firebase REST client. No service-account material reaches the browser.
export function createFirebase({url,serviceAccount,fetchImpl=fetch,now=Date.now}) {
  const origin=new URL(url);
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.firebaseio.com'))throw new Error('Invalid Firebase database URL.');
  let account;
  try{account=typeof serviceAccount==='string'?JSON.parse(serviceAccount):serviceAccount;}catch{throw new Error('FIREBASE_SERVICE_ACCOUNT must be valid JSON.');}
  if(!account?.client_email||!account?.private_key)throw new Error('FIREBASE_SERVICE_ACCOUNT must contain the service-account JSON.');
  let credential=null,refresh=null,closed=false;
  const controllers=new Set();
  async function bearer(){
    if(credential&&credential.until>now()+60000)return credential.value;
    if(refresh)return refresh;
    refresh=(async()=>{
      const encode=(x)=>Buffer.from(JSON.stringify(x)).toString('base64url'),issued=Math.floor(now()/1000);
      const payload=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600});
      const signature=createSign('RSA-SHA256').update(payload).sign(account.private_key,'base64url');
      const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:payload+'.'+signature}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Firebase server authentication failed.');
      const data=await response.json();if(!data.access_token)throw new Error('Firebase access token missing.');
      credential={value:data.access_token,until:now()+Number(data.expires_in||3600)*1000};return credential.value;
    })().finally(()=>{refresh=null;});return refresh;
  }
  async function request(path,{method='GET',value,headers={},signal}={}){
    if(closed)throw new Error('Firebase connection closed.');
    const response=await fetchImpl(new URL(`${path}.json`,origin),{method,headers:{Authorization:`Bearer ${await bearer()}`,'Content-Type':'application/json',...headers},body:value===undefined?undefined:JSON.stringify(value),signal:signal||AbortSignal.timeout(10000)});
    if(response.status===401)credential=null;
    if(!response.ok&&response.status!==412)throw new Error(`Firebase request failed (${response.status}).`);
    return response;
  }
  async function read(path){return (await request(path)).json();}
  async function write(path,value){await request(path,{method:'PUT',value});}
  async function transaction(path,update){
    for(let attempt=0;attempt<12;attempt++){
      const previous=await request(path,{headers:{'X-Firebase-ETag':'true'}}),etag=previous.headers.get('etag');
      const value=update(await previous.json());if(value===undefined)return;
      const response=await request(path,{method:'PUT',value,headers:{'if-match':etag}});
      if(response.status!==412)return value;
    }
    throw new Error('Firebase transaction is busy. Please retry.');
  }
  function subscribe(path,receive){
    const controller=new AbortController();controllers.add(controller);let cache=null,timer;
    const copy=(x)=>x===undefined?null:structuredClone(x);
    function setAt(parts,value){if(parts.some((key)=>['__proto__','constructor','prototype'].includes(key)))return;if(!parts.length){cache=copy(value);return;}cache||={};let parent=cache;for(const part of parts.slice(0,-1))parent=parent[part]||=( {} );if(value===null)delete parent[parts.at(-1)];else parent[parts.at(-1)]=copy(value);}
    async function connect(){
      let reader;
      try{
        const response=await request(path,{headers:{Accept:'text/event-stream'},signal:controller.signal});
        reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
        while(!controller.signal.aborted){
          const {value,done}=await reader.read();if(done)break;buffer=(buffer+decoder.decode(value,{stream:true})).replaceAll('\r\n','\n');
          let end;
          while((end=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
            const type=block.split('\n').find((s)=>s.startsWith('event:'))?.slice(6).trim();
            if(type==='auth_revoked'){credential=null;await reader.cancel();throw new Error('Refresh Firebase stream credentials.');}
            if(type==='cancel')throw new Error('Firebase stream access denied.');
            if(type!=='put'&&type!=='patch')continue;
            const data=JSON.parse(block.split('\n').filter((s)=>s.startsWith('data:')).map((s)=>s.slice(5).trim()).join('\n'));
            const parts=data.path.split('/').filter(Boolean);
            if(type==='put')setAt(parts,data.data);else for(const [key,item]of Object.entries(data.data||{}))setAt([...parts,...key.split('/')],item);
            receive(copy(cache));
          }
        }
      }catch(error){if(!controller.signal.aborted)console.error('Firebase stream reconnecting.');}
      finally{await reader?.cancel().catch(()=>{});}
      if(!controller.signal.aborted){timer=setTimeout(connect,1500);timer.unref?.();}
    }
    connect();return ()=>{clearTimeout(timer);controller.abort();controllers.delete(controller);};
  }
  return {read,write,transaction,subscribe,async secure(){
    // Dedicated game namespace is private; the app exposes only public projections.
    const current=await read('.settings/rules');
    const rules={...(current?.rules||{}),'.read':false,'.write':false,upgrade:{'.read':false,'.write':false}};
    await write('.settings/rules',{rules});
  },close(){closed=true;for(const controller of controllers)controller.abort();}};
}
