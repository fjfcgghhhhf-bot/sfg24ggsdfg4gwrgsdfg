import {GameError} from './game.mjs';

export const DEFAULT_WHEEL_STYLE={start:'#ffdc00',end:'#ef3e25',pointer:'#ffe100',center:'#ffdc00'};
export function validateWheelStyle(value){
  if(!value||Object.keys(DEFAULT_WHEEL_STYLE).some((key)=>!/^#[0-9a-f]{6}$/i.test(value[key]||'')))throw new GameError('Выберите корректные цвета.','INVALID_COLORS');
  return Object.fromEntries(Object.keys(DEFAULT_WHEEL_STYLE).map((key)=>[key,value[key].toLowerCase()]));
}
export async function createCommunity({database,now=Date.now,root='upgrade/social'}){
  let cache=await database.read(root)||{},closed=false;
  const clients=new Set();
  const online=()=>Object.values(cache.presence||{}).filter((p)=>p.until>now()).map(({id,nickname})=>({id,nickname}));
  const snapshot=()=>({serverNow:now(),online:online(),messages:Object.values(cache.messages||{}).sort((a,b)=>a.at-b.at).slice(-100),battles:Object.values(cache.battles||{}).filter((b)=>b.status==='waiting'||b.status==='active'||now()-(b.publishedAt||0)<600000)});
  function send(client,data){if(client.destroyed||client.writableEnded)return;if(!client.write(`event: community\ndata: ${JSON.stringify(data)}\n\n`))client.destroy();}
  function broadcast(){if(closed)return;const data=snapshot();for(const client of clients)send(client,data);}
  const unsubscribe=database.subscribe(root,(data)=>{cache=data||{};broadcast();});
  const timer=setInterval(broadcast,15000);timer.unref?.();
  async function write(path,value){await database.write(`${root}/${path}`,value);const [kind,id]=path.split('/');cache[kind]||={};cache[kind][id]=value;broadcast();}
  return {
    snapshot,online,style:(id)=>cache.styles?.[id]||{...DEFAULT_WHEEL_STYLE},
    isOnline:(id)=>Boolean(cache.presence?.[id]?.until>now()),
    async heartbeat(player){
      await write(`presence/${player.id}`,{id:player.id,nickname:player.nickname,until:now()+65000});
      const stale=Object.entries(cache.presence||{}).filter(([,p])=>p.until<now()-300000);
      for(const [id]of stale.slice(0,10)){await database.write(`${root}/presence/${id}`,null);delete cache.presence[id];}
      return {serverNow:now(),style:cache.styles?.[player.id]||null};
    },
    async retire(id){await database.write(`${root}/presence/${id}`,null);delete cache.presence?.[id];broadcast();},
    async saveStyle(player,value){const style=validateWheelStyle(value);await write(`styles/${player.id}`,style);return {style};},
    async message(player,value,requestId){
      if(typeof value!=='string'||!value.trim()||value.trim().length>300||/[\p{Cc}\p{Cf}]/u.test(value))throw new GameError('Сообщение: от 1 до 300 символов, без управляющих знаков.','INVALID_MESSAGE');
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{16,64}$/.test(requestId))throw new GameError('Некорректный идентификатор сообщения.','INVALID_MESSAGE_ID');
      const entry={id:requestId,playerId:player.id,nickname:player.nickname,text:value.trim(),at:now()};
      const messages=await database.transaction(`${root}/messages`,(old)=>{
        const all=Object.values(old||{}),same=all.find((m)=>m.id===requestId);
        if(same){if(same.playerId!==player.id||same.text!==entry.text)throw new GameError('Идентификатор сообщения уже занят.','MESSAGE_CONFLICT');return old;}
        if(all.some((m)=>m.playerId===player.id&&now()-m.at<3000))throw new GameError('Между сообщениями нужно подождать 3 секунды.','CHAT_RATE_LIMIT',429);
        return Object.fromEntries([...all,entry].sort((a,b)=>a.at-b.at).slice(-100).map((m)=>[m.id,m]));
      });
      cache.messages=messages||{};broadcast();return {message:cache.messages[requestId]};
    },
    async publishBattle(battle){
      if(!battle)return;
      const publicBattle={...battle,publishedAt:now(),players:battle.players.map((p)=>({...p,style:cache.styles?.[p.id]||{...DEFAULT_WHEEL_STYLE}}))};
      const battles=await database.transaction(`${root}/battles`,(old)=>{
        const all={...(old||{})};
        if(!all[battle.id]||all[battle.id].revision<=battle.revision)all[battle.id]=publicBattle;
        const closedBattles=Object.values(all).filter((b)=>!['waiting','active'].includes(b.status)).sort((a,b)=>b.publishedAt-a.publishedAt);
        for(const b of closedBattles.slice(30))delete all[b.id];return all;
      });cache.battles=battles||{};broadcast();
    },
    connect(response){
      if(clients.size>=1000){response.writeHead(503);response.end();return;}
      response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
      response.write('retry: 3000\n\n');clients.add(response);response.on('close',()=>clients.delete(response));send(response,snapshot());
    },
    close(){closed=true;clearInterval(timer);unsubscribe();for(const client of clients)client.destroy();clients.clear();database.close?.();},
  };
}
