export function createCommunityUI({$,document,window,getPlayer,getToken,api,toast,esc,money,showDialog,getPrefs,savePreferences,social,isBusy}){
  const defaults={start:'#ffdc00',end:'#ef3e25',pointer:'#ffe100',center:'#ffdc00'};
  let state={online:[],messages:[],battles:[]},stream=null,timer,started=false,identity=null,heartbeatPending=false,colorsDirty=false,challengeId=null,sending=false,messageKey='',peopleKey='',messageAttempt=null,unread=0,profileId=null;
  const valid=(style)=>style&&Object.keys(defaults).every((key)=>/^#[0-9a-f]{6}$/i.test(style[key]||''));
  const player=()=>getPlayer();
  function applyColors(style){
    if(!valid(style))style={...defaults};
    getPrefs().wheelStyle={...style};
    document.body.style.setProperty('--wheel-start',style.start);document.body.style.setProperty('--wheel-end',style.end);
    document.body.style.setProperty('--wheel-pointer',style.pointer);document.body.style.setProperty('--wheel-center',style.center);
    for(const key of Object.keys(defaults))$(`color-${key}`).value=style[key];
  }
  applyColors(getPrefs().wheelStyle);
  function online(id){return state.online.some((p)=>p.id===id);}
  function updateProfile(id=profileId){
    profileId=id;const status=$('profilePresence'),button=$('profileChallenge');
    if(status){status.textContent=online(id)?'В сети':'Не в сети';status.classList.toggle('is-online',online(id));}
    if(button)button.disabled=!online(id)||id===player()?.id||!player();
  }
  function render(){
    $('onlineCount').textContent=String(state.online.length);$('chatOnlineCount').textContent=`${state.online.length} в сети`;
    $('chatOnline').innerHTML=state.online.length?state.online.slice(0,60).map((p)=>`<div class="chat-person"><button data-action="profile" data-key="${esc(p.id)}"><span class="online-dot"></span>${esc(p.nickname)}${p.id===player()?.id?' <small>вы</small>':''}</button>${p.id!==player()?.id?`<button class="challenge-small" data-action="challenge" data-key="${esc(p.id)}" aria-label="Вызвать ${esc(p.nickname)} на батл" ${!player()?'disabled':''}>⚔</button>`:''}</div>`).join(''):'<p class="chat-empty">Пока никого нет в сети</p>';
    const key=state.messages.map((m)=>m.id).join(',');
    const currentPeople=state.online.map((p)=>p.id).sort().join(',');
    if(key!==messageKey||currentPeople!==peopleKey){
      const box=$('chatMessages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
      if(key!==messageKey&&messageKey&&$('chatDrawer').hidden){unread++;$('chatUnread').hidden=false;$('chatUnread').textContent=String(unread);}
      messageKey=key;peopleKey=currentPeople;
      box.innerHTML=state.messages.length?state.messages.map((m)=>`<article class="chat-message ${m.playerId===player()?.id?'own':''}"><header><button data-action="profile" data-key="${esc(m.playerId)}">${esc(m.nickname)}</button><time>${new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit'}).format(new Date(m.at))}</time>${m.playerId!==player()?.id&&online(m.playerId)?`<button class="challenge-small" data-action="challenge" data-key="${esc(m.playerId)}" aria-label="Вызвать ${esc(m.nickname)} на батл">⚔</button>`:''}</header><p>${esc(m.text)}</p></article>`).join(''):'<p class="chat-empty">Общий чат игроков.<br>Поздоровайтесь или найдите соперника.</p>';
      if(nearBottom)box.scrollTop=box.scrollHeight;
    }
    const invitations=state.battles.filter((b)=>b.status==='waiting'&&b.targetPlayerId===player()?.id&&b.waitEndsAt>state.serverNow);
    $('challengeInbox').hidden=!invitations.length;
    $('challengeInbox').innerHTML=invitations.slice(0,3).map((b)=>`<article><span>ВЫЗОВ НА БАТЛ</span><strong>${esc(b.players[0].nickname)}</strong><p>${money(b.deposit)} · ${b.count} цепочки · 5 минут</p><div><button class="button primary" data-action="accept-challenge" data-key="${b.id}">Принять</button><button class="button secondary" data-action="decline-challenge" data-key="${b.id}">Отклонить</button></div></article>`).join('');
    updateProfile();
  }
  function receive(event){try{
    const data=JSON.parse(event.data);if(!Array.isArray(data.online)||!Array.isArray(data.messages)||!Array.isArray(data.battles))return;
    state=data;render();for(const b of data.battles)social().receiveBattle({...b,serverNow:data.serverNow});
  }catch{ /* Reconnect snapshot repairs interrupted streams. */ }}
  async function heartbeat(){
    if(heartbeatPending||!getToken())return;heartbeatPending=true;
    const id=player()?.id,changed=identity!==id;identity=id;
    try{const data=await api('presence',{token:getToken()});
      if(changed&&player()?.id===id&&!colorsDirty){if(valid(data.style)){applyColors(data.style);savePreferences();}else if(valid(getPrefs().wheelStyle))await api('wheel-style',{token:getToken(),style:getPrefs().wheelStyle});}
      $('onlineBadge').title='Игроки на сайте';
    }catch{$('onlineBadge').title='Онлайн временно недоступен';identity=null;}finally{heartbeatPending=false;}
  }
  function start(){
    if(started)return;started=true;
    if(typeof EventSource!=='undefined'){stream=new EventSource('/api/community/stream');stream.addEventListener('community',receive);stream.addEventListener('error',()=>{$('onlineCount').textContent='—';});}
    async function ping(){if(!started)return;await heartbeat();timer=setTimeout(ping,20000);}ping();
  }
  function openChat(open){$('chatDrawer').hidden=!open;$('chatToggle').setAttribute('aria-expanded',String(open));if(open){unread=0;$('chatUnread').hidden=true;$('chatMessages').scrollTop=$('chatMessages').scrollHeight;$('chatInput').focus?.();}}
  function challenge(id){
    if(isBusy()){toast('Дождитесь завершения прокрутки.');return;}
    const person=state.online.find((p)=>p.id===id);
    if(!person||id===player()?.id){toast('Этот игрок сейчас недоступен.');return;}
    if(!player()){showDialog('welcomeDialog');return;}
    challengeId=id;$('challengeName').textContent=person.nickname;
    if($('profileDialog').open)$('profileDialog').close();showDialog('challengeDialog');
  }
  $('chatToggle').addEventListener('click',()=>openChat($('chatDrawer').hidden));$('chatClose').addEventListener('click',()=>openChat(false));
  $('chatForm').addEventListener('submit',async(event)=>{
    event.preventDefault();if(sending)return;if(!player()){showDialog('welcomeDialog');return;}
    const text=$('chatInput').value.trim();if(!text)return;sending=true;$('chatSend').disabled=true;
    if(messageAttempt?.text!==text||messageAttempt?.playerId!==player().id)messageAttempt={text,playerId:player().id,requestId:crypto.randomUUID()};
    try{await api('chat',{token:getToken(),text,requestId:messageAttempt.requestId});$('chatInput').value='';messageAttempt=null;}catch(error){toast(error.message);}finally{sending=false;$('chatSend').disabled=false;}
  });
  $('wheelColorsButton').addEventListener('click',()=>{applyColors(getPrefs().wheelStyle);showDialog('wheelColorsDialog');});
  for(const key of Object.keys(defaults))$(`color-${key}`).addEventListener('input',()=>{colorsDirty=true;applyColors(Object.fromEntries(Object.keys(defaults).map((k)=>[k,$(`color-${k}`).value])));});
  $('resetWheelColors').addEventListener('click',()=>{colorsDirty=true;applyColors(defaults);});
  $('wheelColorsForm').addEventListener('submit',async(event)=>{
    event.preventDefault();if(!getToken()){toast('Сначала начните сессию.');return;}
    $('saveWheelColors').disabled=true;
    try{const result=await api('wheel-style',{token:getToken(),style:getPrefs().wheelStyle});applyColors(result.style);colorsDirty=false;savePreferences();$('wheelColorsDialog').close();toast('Цвета сохранены.');}
    catch(error){toast(error.message);}finally{$('saveWheelColors').disabled=false;}
  });
  $('challengeForm').addEventListener('submit',async(event)=>{
    event.preventDefault();if(sending||isBusy())return;sending=true;$('sendChallenge').disabled=true;
    try{const data=await api('challenge',{token:getToken(),playerId:challengeId,amount:Number($('challengeAmount').value),count:Number($('challengeChains').value)});$('challengeDialog').close();social().showBattle(data);toast('Вызов отправлен. Ждём соперника.');}
    catch(error){toast(error.message);}finally{sending=false;$('sendChallenge').disabled=false;}
  });
  document.addEventListener('click',async(event)=>{
    const button=event.target.closest('[data-action]');if(!button)return;const {action,key}=button.dataset;
    if(action==='challenge')challenge(key);
    if(action==='accept-challenge'||action==='decline-challenge'){
      if(sending||isBusy()){toast('Дождитесь завершения текущего действия.');return;}sending=true;button.disabled=true;
      try{const data=await api(action==='accept-challenge'?'battle/join':'battle/decline',{token:getToken(),battleId:key});
        if(action==='accept-challenge')social().showBattle(data);else toast('Вызов отклонён.');
      }catch(error){toast(error.message);}finally{sending=false;button.disabled=false;}
    }
  });
  window.addEventListener('pagehide',()=>{started=false;clearTimeout(timer);stream?.close();stream=null;});window.addEventListener('pageshow',start);
  return {start,isOnline:online,updateProfile,identify(){if(started&&identity!==player()?.id)heartbeat();},applyColors};
}
