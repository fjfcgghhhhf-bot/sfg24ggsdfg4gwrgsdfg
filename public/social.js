export function createSocial({$,document,window,getPlayer,getToken,isBusy,setBusy,saveSnapshot,api,toast,showDialog,esc,money,primeAudio,spinTick,sound,initialView}) {
  let view='upgrade',battle=null,selectedId=null,chainId=null,target=null,targetSequence=0,profileSequence=0,profileId=null,arenaVisible=true;
  let pending=false,spinning=false,refreshing=false,started=false,pollTimer,clockTimer,offset=0,rotation=180;
  const player=()=>getPlayer(),active=()=>battle?.status==='active',mine=()=>battle?.players.find((p)=>p.id===player()?.id);
  const chain=()=>mine()?.chains.find((c)=>c.id===chainId);
  const cents=(price)=>Math.round(price*100);
  const canUpgrade=(item)=>item&&cents(item.price)*100<=49_999_999*90;
  const date=(at)=>new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(at));
  const battleNow=()=>Date.now()+offset;
  const remaining=()=>battle?.endsAt ? Math.max(0,battle.endsAt-battleNow()):0;
  function notice(message) {$('battleNotice').textContent=message;}
  function apply(data) {
    if(data.player)saveSnapshot(data);
    if(data.battle && battle?.id===data.battle.id && data.battle.revision<battle.revision)return;
    battle=data.battle;offset=battle?battle.serverNow-Date.now():0;
    renderBattle();
  }
  async function profile(id,page=1) {
    if(isBusy()){toast('Дождитесь завершения прокрутки.');return;}
    profileId=id;const sequence=++profileSequence;
    $('profileTitle').textContent='Загрузка…';$('profileContent').innerHTML='<p class="social-empty">Загружаем профиль…</p>';
    if(!$('profileDialog').open)showDialog('profileDialog');
    try {
      const data=await api(`profile?id=${encodeURIComponent(id)}&page=${page}`);
      if(sequence!==profileSequence)return;
      $('profileTitle').textContent=data.nickname;
      const best=data.bestDrop;
      $('profileContent').innerHTML=`<div class="profile-stats"><div><span>Баланс</span><strong>${money(data.balance)}</strong></div><div><span>Успешные апгрейды</span><strong>${data.wins} <small>/ ${data.attempts}</small></strong></div><div><span>Победы в батлах</span><strong>${data.battleWins} <small>/ ${data.battlesPlayed}</small></strong></div></div>
        <div class="profile-best"><div><p class="eyebrow">САМЫЙ ДОРОГОЙ ДРОП</p><h3>${best?esc(best.item.name):'Первый дроп ещё впереди'}</h3><span>${best?`${esc(best.item.weapon)} · ${money(best.item.price)} · ${best.mode==='battle'?'Батл':'Апгрейд'}`:'Здесь появится лучший выигранный предмет'}</span></div>${best?`<img src="${esc(best.item.image)}" alt="${esc(best.item.name)}" width="150" height="100">`:''}</div>
        <div class="profile-history-heading"><h3>История апгрейдов</h3><span>Последние ${data.historyCount} из 200</span></div>
        <div class="profile-history">${data.history.length?data.history.map((entry)=>`<article class="profile-history-row"><span class="history-outcome ${entry.won?'won':'lost'}">${entry.won?'ПОБЕДА':'ПОРАЖЕНИЕ'}</span><div><span>${esc(entry.source.weapon)} · ${esc(entry.source.name)} <b>${money(entry.source.price)}</b></span><strong>→ ${esc(entry.target.name)} <b>${money(entry.target.price)}</b></strong></div><div class="history-meta"><span>${entry.chance.toLocaleString('ru-RU',{maximumFractionDigits:2})}% · ${entry.mode==='battle'?'Батл':entry.lucky?'777':'Апгрейд'}</span><time>${date(entry.at)}</time></div></article>`).join(''):'<p class="social-empty">Новых попыток пока нет. История записывается с появления профилей.</p>'}</div>
        <div class="profile-pager"><button class="button secondary" data-action="profile-page" data-key="${data.page-1}" ${data.page<=1?'disabled':''}>←</button><span>${data.page} / ${data.pages}</span><button class="button secondary" data-action="profile-page" data-key="${data.page+1}" ${data.page>=data.pages?'disabled':''}>→</button></div>`;
    } catch(error){if(sequence===profileSequence){$('profileTitle').textContent='Профиль';$('profileContent').innerHTML=`<p class="social-empty">${esc(error.message)}</p>`;}}
  }
  function open(next) {
    if(isBusy()){toast('Дождитесь завершения прокрутки.');return;}
    view=next;$('upgradeView').hidden=next!=='upgrade';$('battlesView').hidden=next!=='battles';
    $('upgradeNav').classList.toggle('active',next==='upgrade');$('battlesNav').classList.toggle('active',next==='battles');
    $('upgradeNav').setAttribute('aria-current',next==='upgrade'?'page':'false');$('battlesNav').setAttribute('aria-current',next==='battles'?'page':'false');
    if(next==='battles')refresh();
  }
  function renderList(data) {
    const current=data.battles.find((b)=>b.players.some((p)=>p.id===player()?.id));
    $('battleListCount').textContent=`${data.battles.length} сражений`;
    $('battleCreateButton').disabled=pending||!player()||Boolean(current);
    $('battleList').innerHTML=data.battles.length?data.battles.map((b)=>`<article class="battle-lobby-card"><div class="battle-versus"><button data-action="profile" data-key="${esc(b.players[0].id)}">${esc(b.players[0].nickname)}</button><span>VS</span><strong>${b.players[1]?esc(b.players[1].nickname):'Ждёт вас'}</strong></div><div class="battle-lobby-terms"><div><span>Взнос</span><strong>${money(b.deposit)}</strong></div><div><span>Цепочки</span><strong>${b.count}</strong></div><span class="battle-tag">${b.status==='waiting'?'ОТКРЫТ':'ИДЁТ БАТЛ'}</span></div><button class="button ${b.status==='waiting'?'primary':'secondary'}" data-action="${b.players.some((p)=>p.id===player()?.id)||b.status==='active'?'battle-view':'battle-join'}" data-key="${b.id}" ${pending||!player()?'disabled':''}>${b.players.some((p)=>p.id===player()?.id)?'Мой батл':b.status==='active'?'Смотреть':`Вступить · ${money(b.deposit)}`}</button></article>`).join(''):'<div class="social-empty"><strong>Пока нет открытых батлов</strong><span>Создайте первый и дождитесь соперника.</span></div>';
  }
  function playerPanel(p,self) {
    if(!p)return '<div class="battle-await"><strong>Ищем соперника</strong><span>Батл начнётся, когда второй игрок внесёт депозит. До этого взнос можно вернуть.</span></div>';
    return `<div class="battle-player-header"><div><span>${self?'ВАШИ ЦЕПОЧКИ':'СОПЕРНИК'}</span><button data-action="profile" data-key="${p.id}">${esc(p.nickname)}</button></div><strong>${money(p.total)}</strong></div><div class="battle-chain-grid">${p.chains.map((c)=>`<button class="battle-chain ${c.id===chainId&&self?'selected':''} ${!c.item?'chain-lost':''}" data-action="battle-chain" data-key="${c.id}" ${!self||!active()||p.stopped||!canUpgrade(c.item)||pending?'disabled':''}><span>#${c.index} · ${c.attempts} попыток</span>${c.item?`<img src="${esc(c.item.image)}" alt="${esc(c.item.name)}" width="110" height="70"><strong>${money(c.item.price)}</strong><small>${esc(c.item.name)}</small>`:'<div class="chain-cross">×</div><strong>Скин потерян</strong>'}</button>`).join('')}</div><p class="battle-player-status">${p.stopped?'Результат зафиксирован':battle.status==='waiting'?'Готов к старту':active()?'Продолжает апгрейды':'Батл завершён'} · ${p.attempts} попыток</p>`;
  }
  function renderBattle() {
    if(!battle){$('battleArena').hidden=true;$('battleLobby').hidden=false;return;}
    $('battleArena').hidden=!arenaVisible;$('battleLobby').hidden=arenaVisible;
    const me=mine(),other=battle.players.find((p)=>p.id!==player()?.id);
    if(!me?.chains.some((c)=>c.id===chainId&&canUpgrade(c.item))) {chainId=me?.chains.find((c)=>canUpgrade(c.item))?.id||null;target=null;}
    $('battleBank').textContent=money(battle.bank);
    $('battlePhase').textContent={waiting:'Поиск соперника',active:'Идёт батл',finished:'Завершён',cancelled:'Отменён'}[battle.status];
    $('battleSelf').innerHTML=playerPanel(me||battle.players[0],Boolean(me));
    $('battleOpponent').innerHTML=playerPanel(me?other:battle.players[1],false);
    $('battleControls').hidden=!active()||!me||me.stopped;
    $('battleCancelButton').hidden=battle.status!=='waiting'||!me;
    $('battleCancelButton').disabled=pending;
    $('battleStopButton').disabled=pending||!active()||!remaining();
    const ended=['finished','cancelled'].includes(battle.status);
    $('battleResult').hidden=!ended;
    if(ended){$('battleResult').textContent=battle.status==='cancelled'?'Батл отменён. Взнос возвращён.':battle.tie?'Ничья. Оба взноса возвращены.':`${battle.players.find((p)=>p.id===battle.winnerId)?.nickname} побеждает и получает ${money(battle.bank)}!`;}
    renderTarget();updateClock();
    if(active()&&me&&!me.stopped&&chain()&&!target&&!pending)chooseChance(Number($('battleChance').value)||50);
  }
  function renderTarget() {
    const source=chain()?.item,valid=source&&target&&cents(source.price)*100<=cents(target.price)*90;
    const chance=valid?source.price/target.price*100:0;
    $('battleTarget').innerHTML=target?`<img src="${esc(target.image)}" alt="${esc(target.name)}" width="170" height="100"><span>${esc(target.weapon)}</span><strong>${esc(target.name)}</strong><b>${money(target.price)}</b>`:'<p class="social-empty">Выберите доступную цепочку</p>';
    $('battleChanceValue').textContent=valid?`${chance.toLocaleString('ru-RU',{maximumFractionDigits:2})}%`:'—';
    if(!spinning){$('battleWinArc').setAttribute('stroke-dasharray',`${chance} ${100-chance}`);$('battleWinArc').setAttribute('stroke-dashoffset',String(-(50-chance/2)));}
    $('battleUpgradeButton').disabled=!valid||pending||!active()||!remaining()||mine()?.stopped||battleNow()<(mine()?.nextSpinAt||0);
  }
  function updateClock() {
    clearTimeout(clockTimer);
    if(!battle)return;
    const ms=battle.status==='waiting'?Math.max(0,battle.waitEndsAt-battleNow()):remaining(),seconds=Math.ceil(ms/1000);
    $('battleClock').textContent=['finished','cancelled'].includes(battle.status)?'—':`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    $('battleClockCaption').textContent=battle.status==='waiting'?'ОЖИДАНИЕ ДО ОТМЕНЫ':'ОСТАЛОСЬ';
    if(active()&&!remaining()){$('battleUpgradeButton').disabled=true;$('battleStopButton').disabled=true;}
    if(['waiting','active'].includes(battle.status))clockTimer=setTimeout(updateClock,250);
  }
  async function chooseChance(chance) {
    if(pending||!chain()?.item)return;
    if(!Number.isFinite(chance)||chance<=0||chance>90){toast('Шанс должен быть больше 0 и не выше 90%.');return;}
    const sequence=++targetSequence,source=chain().item,id=chainId;
    $('battleChance').value=String(chance);
    const price=Math.min(499999.99,Math.max(Math.ceil(cents(source.price)*100/90),Math.ceil(cents(source.price)*100/chance))/100);
    if(cents(source.price)*100>cents(price)*90){target=null;renderTarget();return;}
    target=null;$('battleUpgradeButton').disabled=true;
    try {const item=await api(`item?id=skin-${price}`);if(sequence!==targetSequence||chainId!==id||chain()?.item?.id!==source.id)return;target=item;renderTarget();}
    catch(error){if(sequence===targetSequence){target=null;renderTarget();toast(error.message);}}
  }
  async function refresh() {
    if(refreshing||isBusy()||pending)return;
    refreshing=true;
    try {
      if(getToken()) {
        const data=await api('battle/state',{token:getToken(),...(selectedId?{battleId:selectedId}:{})});
        if(!isBusy()&&!pending)apply(data);
      }
      if(view==='battles') {const list=await api('battles');if(!pending)renderList(list);}
      notice('');
    }catch(error){notice(error.message);}
    finally{refreshing=false;}
  }
  async function action(name,body={}) {
    if(pending||isBusy())return;
    if(!player()){showDialog('welcomeDialog');return;}
    pending=true;setBusy(true);renderBattle();notice('');
    try {
      const data=await api(`battle/${name}`,{token:getToken(),battleId:battle?.id,...body});
      selectedId=data.battle?.id||null;arenaVisible=true;target=null;apply(data);
    }catch(error){notice(error.message);toast(error.message);}
    finally{pending=false;setBusy(false);renderBattle();await refresh();}
  }
  async function animate(angle,duration) {
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start=rotation,end=start+360*(2+Math.floor(Math.random()*2))+((angle-start%360+360)%360),began=performance.now();
    let lastSector=Math.floor(rotation/24),lastTick=-100;
    return new Promise((resolve)=>{function frame(now){const t=reduced?1:Math.min(1,(now-began)/duration),progress=1-Math.pow(1-t,3);rotation=t===1?end:start+(end-start)*progress;$('battlePointer').setAttribute('transform',`rotate(${rotation} 200 200)`);const sector=Math.floor(rotation/24);if(t<1&&sector!==lastSector&&now-lastTick>35){spinTick();lastTick=now;lastSector=sector;}if(t<1)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});
  }
  async function spin() {
    if(pending||isBusy()||!chain()?.item||!target||!active()||!remaining()||mine().stopped)return;
    pending=true;spinning=true;setBusy(true);primeAudio();
    const selected=chain(),chosenTarget=target;renderBattle();$('battleSpinStatus').textContent='Круг вращается…';
    let message='';
    try {
      const data=await api('battle/upgrade',{token:getToken(),battleId:battle.id,chainId:selected.id,targetId:chosenTarget.id,attempt:selected.attempts,lucky:false});
      saveSnapshot(data,false);await animate(data.result.angle,data.spinDuration);sound(data.result.won);
      message=data.result.won?`Успех! ${data.result.item.name} · ${money(data.result.item.price)}`:'Скин потерян. Выберите другую цепочку.';
      target=null;apply(data);
    }catch(error){message=error.message;toast(error.message);}
    finally {spinning=false;pending=false;setBusy(false);renderBattle();$('battleSpinStatus').textContent=message;await refresh();}
  }
  function splitPreview() {
    const amount=Number($('battleDeposit').value),count=Number($('battleChains').value);
    $('battleSplitPreview').textContent=count>0&&amount>=count*10?`${count} скина · примерно по ${money(Math.floor(amount*100/count)/100)}`:'Минимум 10 ₽ на каждый скин';
  }
  $('upgradeNav').addEventListener('click',(event)=>{event.preventDefault();open('upgrade');});
  $('battlesNav').addEventListener('click',(event)=>{event.preventDefault();open('battles');});
  $('myProfileButton').addEventListener('click',()=>{if(player()?.id)profile(player().id);});
  $('battleDeposit').addEventListener('input',splitPreview);$('battleChains').addEventListener('input',splitPreview);
  $('battleCreateForm').addEventListener('submit',(event)=>{event.preventDefault();return action('create',{amount:Number($('battleDeposit').value),count:Number($('battleChains').value)});});
  $('battleChanceForm').addEventListener('submit',(event)=>{event.preventDefault();return chooseChance(Number($('battleChance').value));});
  $('battleUpgradeButton').addEventListener('click',spin);
  $('battleStopButton').addEventListener('click',()=>action('stop'));
  $('battleCancelButton').addEventListener('click',()=>action('cancel'));
  $('battleBackButton').addEventListener('click',()=>{if(pending)return;arenaVisible=false;$('battleArena').hidden=true;$('battleLobby').hidden=false;api('battles').then(renderList).catch((e)=>notice(e.message));});
  document.addEventListener('click',async(event)=>{
    const button=event.target.closest('[data-action]');if(!button)return;
    const {action:kind,key}=button.dataset;
    if(kind==='profile')profile(key);
    if(kind==='profile-page')profile(profileId,Number(key));
    if(kind==='battle-join')await action('join',{battleId:key});
    if(kind==='battle-view'){selectedId=key;arenaVisible=true;await refresh();}
    if(kind==='battle-chain'&&!pending){chainId=key;target=null;renderBattle();}
    if(kind==='battle-chance')await chooseChance(Number(key));
  });
  function start() {
    if(started)return;started=true;
    async function poll(){if(!started)return;if(view==='battles'||player())await refresh();pollTimer=setTimeout(poll,view==='battles'?2000:5000);}
    pollTimer=setTimeout(poll,1000);
  }
  window.addEventListener('pagehide',()=>{started=false;clearTimeout(pollTimer);clearTimeout(clockTimer);});
  window.addEventListener('pageshow',start);
  return {start,profile,open,refresh,spin,chooseChance,init(){start();if(initialView==='#battles')open('battles');}};
}
