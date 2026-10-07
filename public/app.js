const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'upgrade.session.v1';
const PREFS_KEY = 'upgrade.preferences.v1';
const money = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = {gold:'#d5a239',red:'#ec5c60',pink:'#c64cd9',purple:'#8a62df',blue:'#507bd2'};
const goal = {id:'code',name:'Зашифрованный код',weapon:'КОНЕЧНАЯ ЦЕЛЬ',price:500000,image:'/assets/code.svg',rarity:'gold'};
let player = null, token = null, source = null, target = null, mode = 'shop';
let busy = false, shopPage = 1, targetPage = 1, rotation = 180;
let shopSequence = 0, targetSequence = 0, selectionSequence = 0, toastTimer, audioContext;
let prefs = {sound:true,fast:false};
let pendingStorageValue;
const cache = new Map([['code',goal]]);
try { token = localStorage.getItem(SESSION_KEY); prefs = {...prefs,...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')}; } catch { /* Storage warning shown when saving. */ }

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500);
}
function saveSnapshot(data, render = true) {
  token = data.token; player = data.player;
  try { localStorage.setItem(SESSION_KEY, token); }
  catch { toast('Браузер не разрешает сохранение. Разрешите данные сайта, чтобы не потерять прогресс.'); }
  if (source) source = player.inventory.find((item) => item.inventoryId === source.inventoryId) || null;
  if (render) renderPlayer();
}
async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {method:body ? 'POST':'GET',headers:body ? {'Content-Type':'application/json'}:{},body:body ? JSON.stringify(body):undefined});
  } catch { throw new Error('Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.'); }
  const data = await response.json();
  if (!response.ok) {
    if (data.token && data.player) saveSnapshot(data);
    const error = new Error(data.error || 'Не удалось выполнить действие.');
    error.code = data.code; error.status = response.status;
    throw error;
  }
  return data;
}
function sound(won) {
  if (!prefs.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    [won ? 440:240,won ? 660:180,won ? 880:120].forEach((hz,i) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.frequency.value = hz; oscillator.type = 'sine';
      const start = audioContext.currentTime + i * .1;
      gain.gain.setValueAtTime(.06,start); gain.gain.exponentialRampToValueAtTime(.001,start+.18);
      oscillator.start(start); oscillator.stop(start+.2);
    });
  } catch { /* Audio is optional. */ }
}
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function setStatus(text) { $('statusLine').textContent = text; }
function flushOtherTab() {
  if(pendingStorageValue === undefined) return;
  if(pendingStorageValue === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY,pendingStorageValue);
  location.reload();
}
function card(item, action, selected = false) {
  const key = action === 'select-source' || action === 'sell' ? item.inventoryId:item.id;
  const disabled = busy || (action === 'buy' && (!player || player.balance < item.price));
  const actionText = {buy:'Купить',sell:'Продать','select-source':'Выбрать','select-target':item.id === 'code' ? 'Конечная цель':'Выбрать'}[action];
  const label = `${item.weapon} ${item.name}, ${money(item.price)}. ${actionText}`;
  return `<button type="button" class="item-card rarity-${Object.hasOwn(colors,item.rarity)?item.rarity:'gold'} ${item.id === 'code' ? 'code-card':''} ${selected ? 'selected':''}" data-action="${action}" data-key="${esc(key)}" aria-label="${esc(label)}" ${disabled ? 'disabled':''} aria-pressed="${selected}">
    <span class="item-price">${money(item.price)}</span><span class="item-wear">${item.id === 'code' ? 'LOCKED':({'Прямо с завода':'FN','Немного поношенное':'MW','После полевых испытаний':'FT','Поношенное':'WW','Закалённое в боях':'BS'}[item.wear] || 'FN')}</span>
    <img class="item-image" src="${esc(item.image)}" alt="${esc(`${item.weapon} | ${item.name}`)}" loading="lazy" width="220" height="150">
    <span class="item-type">${esc(item.weapon)}</span><span class="item-name">${esc(item.name)}</span>
    <span class="item-action">${selected ? 'Выбрано':actionText}${action === 'sell' ? ` · ${money(item.price)}`:''}</span>
  </button>`;
}
function empty(text, action = '') { return `<div class="grid-empty"><svg aria-hidden="true"><use href="#icon-bag"/></svg><strong>${esc(text)}</strong>${action}</div>`; }
function renderDisplay(id,item,isTarget) {
  const parent = $(id);
  if (!item) {
    const ghost = [...cache.values()].find((i) => i.id !== 'code');
    parent.innerHTML = `<div class="display-empty">${ghost ? `<img class="ghost-weapon" src="${esc(ghost.image)}" alt="">`:''}<svg class="empty-chevrons ${isTarget ? '':'down'}" aria-hidden="true"><use href="#icon-upgrade"/></svg></div><div class="display-caption">${isTarget ? 'Ваша следующая победа':'Начните с выбора скина'}</div>`;
  } else {
    parent.innerHTML = `<img class="display-image ${item.id === 'code' ? 'display-code':''}" src="${esc(item.image)}" alt="${esc(`${item.weapon} ${item.name}`)}"><div class="display-type">${esc(item.weapon)}</div><div class="display-name">${esc(item.name)}</div><div class="display-price">${money(item.price)}</div>${item.id === 'code' ? '<span class="encrypted-label">10 цифр · откроется после победы</span>':''}`;
  }
}
function arcPath(percent) {
  const sweep = Math.min(359.999,Math.max(.001,360*percent/100));
  const radius = 153;
  const point = (angle) => [200 + radius*Math.sin(angle*Math.PI/180),200-radius*Math.cos(angle*Math.PI/180)];
  const start = point(180-sweep/2), end = point(180+sweep/2);
  return `M ${start[0]} ${start[1]} A ${radius} ${radius} 0 ${sweep>180?1:0} 1 ${end[0]} ${end[1]}`;
}
function renderSelection() {
  renderDisplay('sourceDisplay',source,false); renderDisplay('targetDisplay',target,true);
  const valid = source && target && target.price > source.price;
  const chance = valid ? source.price/target.price*100:0;
  $('winArc').setAttribute('d',arcPath(valid ? chance:50));
  $('chanceValue').textContent = valid ? `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(chance)}%`:'—';
  $('upgradeButton').disabled = !valid || busy;
  $('upgradeButton').classList.toggle('spinning',busy);
  if (!busy) setStatus(!player ? 'Введите ник и получите 500 ₽ для старта':!source ? 'Купите скин в магазине и выберите его слева':!target ? 'Выберите предмет, который хотите получить':!valid ? 'Стоимость цели должна быть выше стоимости вашего скина':`Шанс ${chance.toFixed(2).replace('.',',')}% · ${money(source.price)} → ${money(target.price)}`);
}
function renderPlayer() {
  $('nickname').textContent = player?.nickname || 'Новая сессия';
  $('balance').textContent = money(player?.balance || 0);
  $('inventoryCount').textContent = player?.inventory.length || 0;
  $('inventoryButton').disabled = !player || busy;
  $('resetButton').disabled = !player || busy;
  renderSelection();
  if (mode === 'inventory') renderInventoryGrid();
  renderInventoryModal();
  if (player?.unlockedCode) document.body.classList.add('goal-unlocked');
}
function renderInventoryGrid() {
  if($('sourceCount')) $('sourceCount').textContent=`${player?.inventory.length || 0} предметов`;
  $('sourceGrid').innerHTML = player?.inventory.length ? player.inventory.filter((i) => i.id !== 'code').map((i) => card(i,'select-source',i.inventoryId===source?.inventoryId)).join('') : empty('В инвентаре пока нет скинов','<span>Купите первый скин за игровой баланс.</span><button class="button primary" data-action="open-shop">Открыть магазин</button>');
  if (player?.inventory.length && !player.inventory.some((i) => i.id !== 'code')) $('sourceGrid').innerHTML = empty('Код уже в вашем инвентаре!','<button class="button primary" data-action="open-shop">Открыть магазин</button>');
  $('sourcePager').innerHTML = '';
}
function renderInventoryModal() {
  if (!$('inventoryItems')) return;
  $('inventoryItems').innerHTML = player?.inventory.length ? player.inventory.map((i) => i.id === 'code' ? `<div class="unlocked-prize"><img src="/assets/code.svg" alt="Код"><strong>Цель достигнута</strong><code>${esc(player.unlockedCode || '••••••••••')}</code><button class="button primary" data-action="copy-code">Скопировать код</button></div>`:card(i,'sell')).join(''):empty('Ваш инвентарь пуст','<span>Предметы появятся здесь после покупки или удачного апгрейда.</span>');
  if ($('inventorySummary')) $('inventorySummary').textContent = `${player?.inventory.length || 0} предметов · Баланс ${money(player?.balance || 0)}`;
}
function pager(element,page,pages,total,side) {
  $(element).innerHTML = `<button type="button" data-action="page" data-side="${side}" data-page="${page-1}" ${page<=1?'disabled':''} aria-label="Предыдущая страница">←</button><span>${total ? `${page} / ${pages}`:'Нет предметов'}<small>${new Intl.NumberFormat('ru-RU').format(total)} предложений</small></span><button type="button" data-action="page" data-side="${side}" data-page="${page+1}" ${page>=pages?'disabled':''} aria-label="Следующая страница">→</button>`;
}
async function loadShop() {
  if (mode !== 'shop') return;
  const seq = ++shopSequence;
  const params = new URLSearchParams({min:$('shopMin').value || '10',max:$('shopMax').value || '499990',q:$('shopSearch').value,sort:'asc',page:shopPage,limit:20});
  try {
    const data = await api(`catalog?${params}`);
    if (seq !== shopSequence || mode !== 'shop') return;
    const items = data.items.filter((i)=>i.id !== 'code'); items.forEach((i)=>cache.set(i.id,i));
    if($('sourceCount')) $('sourceCount').textContent=`${new Intl.NumberFormat('ru-RU').format(data.total)} скинов`;
    $('sourceGrid').innerHTML = items.length ? items.map((i)=>card(i,'buy')).join(''):empty('Скинов с такими параметрами нет','<span>Попробуйте изменить поиск или цену.</span>');
    pager('sourcePager',data.page,data.pages,data.total,'shop'); renderSelection();
  } catch(error) { if(seq===shopSequence) $('sourceGrid').innerHTML = empty(error.message,'<button class="button" data-action="retry-shop">Повторить</button>'); }
}
async function loadTargets() {
  const seq = ++targetSequence;
  const params = new URLSearchParams({min:$('targetMin').value || '10',max:$('targetMax').value || '499990',q:$('targetSearch').value,sort:$('targetSort').value || 'desc',page:targetPage,limit:19});
  try {
    const data = await api(`catalog?${params}`);
    if (seq !== targetSequence) return;
    const items = data.items.filter((i)=>i.id!=='code'); items.forEach((i)=>cache.set(i.id,i));
    $('targetGrid').innerHTML = card(goal,'select-target',target?.id==='code') + (items.length ? items.map((i)=>card(i,'select-target',target?.id===i.id)).join(''):empty('По вашему запросу ничего не найдено'));
    pager('targetPager',data.page,data.pages,data.total,'target');
  } catch(error) { if(seq===targetSequence) $('targetGrid').innerHTML = empty(error.message,'<button class="button" data-action="retry-target">Повторить</button>'); }
}
function switchMode(next) {
  mode = next; shopSequence++;
  if ($('sourceTitle')) $('sourceTitle').textContent = mode==='shop' ? 'Магазин скинов':'Мой инвентарь';
  $('inventoryTab').classList.toggle('active',mode==='inventory'); $('shopTab').classList.toggle('active',mode==='shop');
  $('inventoryTab').setAttribute('aria-selected',mode==='inventory'); $('shopTab').setAttribute('aria-selected',mode==='shop');
  $('shopFilters').hidden = mode !== 'shop';
  if(mode==='shop') loadShop(); else renderInventoryGrid();
}
async function buy(itemId) {
  if(busy || !player) return;
  busy = true; renderPlayer();
  try {
    const previousIds = new Set(player.inventory.map((i)=>i.inventoryId));
    const data = await api('buy',{token,itemId}); saveSnapshot(data);
    source = player.inventory.find((i)=>!previousIds.has(i.inventoryId)) || source;
    toast(`${source?.name || 'Скин'} куплен. Теперь выберите цель справа.`);
    switchMode('inventory');
    await pickMultiplier(2,false);
  } catch(error) { toast(error.message); }
  finally { busy = false; renderPlayer(); if(mode==='shop') loadShop(); loadTargets(); flushOtherTab(); }
}
async function sell(inventoryId) {
  if(busy) return;
  busy = true; renderPlayer();
  try { const item=player.inventory.find((i)=>i.inventoryId===inventoryId); saveSnapshot(await api('sell',{token,inventoryId})); toast(`Продано за ${money(item.price)}`); }
  catch(error) { toast(error.message); }
  finally { busy=false; renderPlayer(); if(mode==='shop') loadShop(); flushOtherTab(); }
}
async function selectSource(id) {
  if(busy) return;
  selectionSequence++;
  source = player.inventory.find((i)=>i.inventoryId===id);
  renderPlayer();
  if(!target || target.price<=source.price) await pickMultiplier(2,false);
  renderInventoryGrid();
}
function selectTarget(id) {
  if(busy) return;
  selectionSequence++;
  target = cache.get(id); renderSelection();
  document.querySelectorAll('#targetGrid .item-card').forEach((el)=>{const chosen=el.dataset.key===id;el.classList.toggle('selected',chosen);el.setAttribute('aria-pressed',chosen);});
}
async function pickMultiplier(multiplier,notify=true) {
  if(!source) { if(notify) toast('Сначала выберите свой скин слева.'); return; }
  const seq = ++selectionSequence, sourceId = source.inventoryId;
  const price = Math.min(500000,Math.max(source.price+10,Math.round(source.price*multiplier/10)*10));
  try {
    const item = price===500000 ? goal:await api(`item?id=skin-${price}`);
    if(seq !== selectionSequence || source?.inventoryId !== sourceId) return;
    const resolved = item.item || item; cache.set(resolved.id,resolved); target=resolved;
    $('targetMin').value=Math.max(10,price-50); $('targetMax').value=Math.min(500000,price+130); $('targetSort').value='asc'; targetPage=1;
    renderSelection(); await loadTargets();
  } catch(error) { toast(error.message); }
}
async function animatePointer(angle) {
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0:prefs.fast ? 550:3600;
  const start = rotation;
  const normalized = ((rotation%360)+360)%360;
  const end = rotation + (prefs.fast ? 720:1800) + ((angle-normalized+360)%360);
  await new Promise((resolve)=>{
    const begins = performance.now();
    function frame(now) {
      const t = duration ? Math.min(1,(now-begins)/duration):1;
      rotation = start+(end-start)*(1-Math.pow(1-t,4));
      $('pointer').setAttribute('transform',`rotate(${rotation} 200 200)`);
      if(t<1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}
async function upgrade() {
  if(busy || !source || !target || target.price<=source.price) return;
  selectionSequence++;
  busy=true; renderPlayer(); setStatus('Круг вращается…');
  const previousSource = source;
  let finalStatus = '';
  try {
    const data = await api('upgrade',{token,inventoryId:source.inventoryId,targetId:target.id});
    // Persist before animation: refreshing cannot repeat or undo the result.
    saveSnapshot(data,false); source=previousSource;
    await animatePointer(data.result.angle);
    source=null; busy=false; renderPlayer(); switchMode('inventory'); sound(data.result.won);
    finalStatus = data.result.won ? 'Успех! Предмет добавлен в инвентарь.':'Неудача. Выбранный скин потерян.';
    setStatus(finalStatus);
    if(data.result.won) {
      const prize = data.result.item;
      $('resultContent').innerHTML = `<div class="result-badge">УСПЕШНЫЙ АПГРЕЙД</div><img class="result-image" src="${esc(prize.image)}" alt="${esc(prize.name)}"><h2>${prize.id==='code' ? 'Вы добрались до кода!':esc(prize.name)}</h2><p>${prize.id==='code' ? 'Все 10 цифр разблокированы. Ваш код:':`${esc(prize.weapon)} · ${money(prize.price)}`}</p>${prize.id==='code' ? `<code class="revealed-code">${esc(player.unlockedCode)}</code><button class="button primary" data-action="copy-code">Скопировать код</button>`:'<p>Предмет уже в вашем инвентаре. Продолжайте путь к коду.</p>'}<button class="button primary" data-close="resultDialog">Продолжить</button>`;
      showDialog('resultDialog');
    } else { toast(player.balance<10 && player.inventory.filter((i)=>i.id!=='code').length===0 ? 'Скины и баланс закончились. Начните заново кнопкой «Повторить сессию».':'Апгрейд не удался. Попробуйте другой скин.'); }
  } catch(error) {
    toast(error.message);
    // Recover an already committed response if the connection dropped after mutation.
    try { saveSnapshot(await api('resume',{token})); } catch { /* Leave stored token for next attempt. */ }
  } finally { busy=false; renderPlayer(); if(finalStatus)setStatus(finalStatus); loadTargets(); flushOtherTab(); }
}
function debounce(fn) { let timer; return () => {clearTimeout(timer);timer=setTimeout(fn,220);}; }
document.addEventListener('click',async(event)=>{
  const close = event.target.closest('[data-close]');
  if(close) { const dialog=$(close.dataset.close); if(dialog && dialog.id!=='welcomeDialog') dialog.close(); }
  const button = event.target.closest('[data-action]');
  if(!button) return;
  const action=button.dataset.action;
  if(action==='buy') buy(button.dataset.key);
  if(action==='sell') sell(button.dataset.key);
  if(action==='select-source') selectSource(button.dataset.key);
  if(action==='select-target') selectTarget(button.dataset.key);
  if(action==='open-shop') { switchMode('shop'); $('sourceGrid').scrollIntoView({behavior:'smooth',block:'center'}); }
  if(action==='retry-shop') loadShop();
  if(action==='retry-target') loadTargets();
  if(action==='page') { if(button.dataset.side==='shop') {shopPage=Number(button.dataset.page);loadShop();} else {targetPage=Number(button.dataset.page);loadTargets();} }
  if(action==='copy-code' && player?.unlockedCode) { try {await navigator.clipboard.writeText(player.unlockedCode);toast('Код скопирован.');} catch {toast('Выделите и скопируйте код вручную.');} }
});
$('inventoryTab').addEventListener('click',()=>switchMode('inventory'));
$('shopTab').addEventListener('click',()=>switchMode('shop'));
$('inventoryButton').addEventListener('click',()=>{renderInventoryModal();showDialog('inventoryDialog');});
$('resetButton').addEventListener('click',()=>showDialog('resetDialog'));
$('confirmReset').addEventListener('click',async()=>{
  if(busy) return;
  busy=true; $('confirmReset').disabled=true;
  try {await api('reset',{token});localStorage.removeItem(SESSION_KEY);location.reload();}
  catch(error) {toast(error.message);busy=false;$('confirmReset').disabled=false;}
});
$('welcomeDialog').addEventListener('cancel',(event)=>{if(!player)event.preventDefault();});
$('welcomeForm').addEventListener('submit',async(event)=>{
  event.preventDefault(); if(busy) return;
  const nickname=$('nicknameInput').value.trim();
  if(nickname.length<2) {$('welcomeError').textContent='Введите ник от 2 до 24 символов.';return;}
  busy=true;const submit=$('welcomeForm').querySelector('button[type="submit"]');submit.disabled=true;
  try {
    saveSnapshot(await api('session',{nickname}));$('welcomeDialog').close();$('shopMax').value='500';switchMode('shop');toast('Вам зачислено 500 ₽. Выберите первый скин!');
  } catch(error) {$('welcomeError').textContent=error.message;}
  finally {busy=false;submit.disabled=false;renderPlayer();loadShop();loadTargets();flushOtherTab();}
});
$('upgradeButton').addEventListener('click',upgrade);
for(const id of ['shopSearch','shopMin','shopMax']) $(id).addEventListener('input',debounce(()=>{shopPage=1;loadShop();}));
for(const id of ['targetSearch','targetMin','targetMax']) $(id).addEventListener('input',debounce(()=>{targetPage=1;loadTargets();}));
$('targetSort').addEventListener('change',()=>{targetPage=1;loadTargets();});
for(const button of document.querySelectorAll('[data-multiplier]')) button.addEventListener('click',()=>{if(!busy)pickMultiplier(Number(button.dataset.multiplier));});
$('findChanceButton')?.addEventListener('click',()=>{
  const chance=Number($('desiredChanceInput').value);
  if(!Number.isFinite(chance)||chance<=0||chance>=100){toast('Введите шанс больше 0 и меньше 100%.');return;}
  if(!busy)pickMultiplier(100/chance);
});
function renderPreferences() {
  $('soundToggle').classList.toggle('active',prefs.sound); $('soundToggle').setAttribute('aria-pressed',prefs.sound);
  $('fastToggle').classList.toggle('active',prefs.fast); $('fastToggle').setAttribute('aria-pressed',prefs.fast);
}
for(const [id,key] of [['soundToggle','sound'],['fastToggle','fast']]) $(id).addEventListener('click',()=>{prefs[key]=!prefs[key];renderPreferences();try{localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));}catch{}toast(key==='sound' ? `Звук ${prefs.sound?'включён':'выключен'}`:`Быстрая анимация ${prefs.fast?'включена':'выключена'}`);});
window.addEventListener('storage',async(event)=>{
  if(event.key!==SESSION_KEY) return;
  if(busy){pendingStorageValue=event.newValue;return;}
  if(!event.newValue){location.reload();return;}
  token=event.newValue;
  try{saveSnapshot(await api('resume',{token}));if(mode==='shop')loadShop();}catch(error){toast(error.message);}
});
async function init() {
  $('targetSort').value='desc';
  renderPreferences();
  if(token) {
    try {saveSnapshot(await api('resume',{token}));mode=player.inventory.some((i)=>i.id!=='code')?'inventory':'shop';}
    catch(error) {
      if(error.status===401 || error.status===410) {token=null;localStorage.removeItem(SESSION_KEY);}
      else {setStatus(error.message);toast('Сохранение на месте. Перезагрузите страницу после восстановления соединения.');return;}
    }
  }
  if(!player) showDialog('welcomeDialog');
  if(mode==='shop')$('shopMax').value=String(Math.max(500,player?.balance||500));
  renderPlayer();switchMode(mode);await loadTargets();
}
init();
