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
const DEFAULT_MULTIPLIERS = [1.5,2,5,10];
let prefs = {sound:true,fast:false,multipliers:[...DEFAULT_MULTIPLIERS]};
let luckyArmed = false, targetLoading = false, activeMultiplier = 2;
let pendingStorageValue;
const cache = new Map([['code',goal]]);
const cart = new Map();
let shopItems = [];
try { token = localStorage.getItem(SESSION_KEY); prefs = {...prefs,...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')}; } catch { /* Storage warning shown when saving. */ }
if (!Array.isArray(prefs.multipliers) || prefs.multipliers.length!==4 || prefs.multipliers.some((x)=>!Number.isFinite(x)||x<1.01||x>50000)) prefs.multipliers=[...DEFAULT_MULTIPLIERS];
function savePreferences() { try {localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));} catch {} }
function primeAudio() {
  if(!prefs.sound) return null;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume().catch(()=>{});
    return audioContext;
  } catch { return null; }
}
function spinTick() {
  const context=primeAudio(); if(!context) return;
  try {
    const oscillator=context.createOscillator(),gain=context.createGain(),now=context.currentTime;
    oscillator.type='triangle'; oscillator.frequency.setValueAtTime(1600,now);
    oscillator.frequency.exponentialRampToValueAtTime(450,now+.035);
    gain.gain.setValueAtTime(.035,now);gain.gain.exponentialRampToValueAtTime(.0001,now+.035);
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.start(now);oscillator.stop(now+.04);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
  } catch { /* Optional sound must never interrupt a spin. */ }
}

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
  if (!primeAudio()) return;
  try {
    [won ? 440:240,won ? 660:180,won ? 880:120].forEach((hz,i) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.frequency.value = hz; oscillator.type = 'sine';
      const start = audioContext.currentTime + i * .1;
      gain.gain.setValueAtTime(.06,start); gain.gain.exponentialRampToValueAtTime(.001,start+.18);
      oscillator.start(start); oscillator.stop(start+.2);
      oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
    });
  } catch { /* Audio is optional. */ }
}
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function setStatus(text,kind='') { $('statusLine').textContent = text; $('statusLine').classList.toggle('success',kind==='success'); $('statusLine').classList.toggle('error',kind==='error'); }
function flushOtherTab() {
  if(pendingStorageValue === undefined) return;
  if(pendingStorageValue === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY,pendingStorageValue);
  location.reload();
}
function card(item, action, selected = false) {
  const key = action === 'select-source' || action === 'sell' ? item.inventoryId:item.id;
  const quantity = action === 'add-cart' ? cart.get(item.id) || 0 : 0;
  const disabled = busy || (action === 'add-cart' && !player);
  const actionText = {'add-cart':quantity ? `В корзине: ${quantity} · ещё +1`:'В корзину',sell:'Продать','select-source':'Выбрать','select-target':item.id === 'code' ? 'Конечная цель':'Выбрать'}[action];
  const label = `${item.weapon} ${item.name}, ${money(item.price)}. ${actionText}`;
  return `<button type="button" class="item-card rarity-${Object.hasOwn(colors,item.rarity)?item.rarity:'gold'} ${item.id === 'code' ? 'code-card':''} ${selected ? 'selected':''} ${quantity ? 'in-cart':''}" data-action="${action}" data-key="${esc(key)}" aria-label="${esc(label)}" ${disabled ? 'disabled':''} aria-pressed="${selected || quantity>0}">
    <span class="item-price">${money(item.price)}</span><span class="item-wear">${item.id === 'code' ? 'LOCKED':({'Прямо с завода':'FN','Немного поношенное':'MW','После полевых испытаний':'FT','Поношенное':'WW','Закалённое в боях':'BS'}[item.wear] || 'FN')}</span>
    <img class="item-image" src="${esc(item.image)}" alt="${esc(`${item.weapon} | ${item.name}`)}" loading="lazy" width="220" height="150">
    <span class="item-type">${esc(item.weapon)}</span><span class="item-name">${esc(item.name)}</span>
    ${quantity ? `<span class="cart-quantity-badge">×${quantity}</span>`:''}<span class="item-action">${selected ? 'Выбрано':actionText}${action === 'sell' ? ` · ${money(item.price)}`:''}</span>
  </button>`;
}
function empty(text, action = '') { return `<div class="grid-empty"><svg aria-hidden="true"><use href="#icon-bag"/></svg><strong>${esc(text)}</strong>${action}</div>`; }
function renderDisplay(id,item,isTarget) {
  const parent = $(id);
  if (!item) {
    const ghost = [...cache.values()].find((i) => i.id !== 'code');
    parent.innerHTML = `<div class="display-empty">${ghost ? `<img class="ghost-weapon" src="${esc(ghost.image)}" alt="">`:''}<svg class="empty-chevrons ${isTarget ? '':'down'}" aria-hidden="true"><use href="#icon-upgrade"/></svg></div><div class="display-caption">${isTarget ? 'Ваша следующая победа':'Начните с выбора скина'}</div>`;
  } else {
    parent.innerHTML = `<img class="display-image ${item.id === 'code' ? 'display-code':''}" src="${esc(item.image)}" alt="${esc(`${item.weapon} ${item.name}`)}"><div class="display-type">${esc(item.weapon)}</div><div class="display-name">${esc(item.name)}</div><div class="display-price">${money(item.price)}</div>${item.id === 'code' ? '<span class="encrypted-label">10 цифр · откроется после победы</span>':isTarget ? `<button class="find-in-shop" data-action="find-in-shop" data-key="${esc(item.id)}" ${busy?'disabled':''}>Найти в магазине <span>↗</span></button>`:''}`;
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
  renderBoosters(chance);
  $('upgradeButton').disabled = !valid || busy || targetLoading || (luckyArmed && chance<50);
  $('upgradeButton').classList.toggle('spinning',busy);
  renderMultiplierButtons();
  if (!busy) setStatus(targetLoading ? 'Подбираем цель…':!player ? 'Введите ник и получите 500 ₽ для старта':!source ? 'Купите скин в магазине и выберите его слева':!target ? 'Выберите предмет, который хотите получить':!valid ? 'Стоимость цели должна быть выше стоимости вашего скина':luckyArmed && chance<50 ? 'Для 777 нужен обычный шанс от 50%. Выберите более дешёвую цель.':luckyArmed ? `777: гарантированный успех · обычный шанс ${chance.toFixed(2).replace('.',',')}%`:`Шанс ${chance.toFixed(2).replace('.',',')}% · ${money(source.price)} → ${money(target.price)}`);
}
function renderBoosters(chance=0) {
  const remaining=player?.boosters?.luckyRemaining ?? 3;
  if(!busy && !remaining) luckyArmed=false;
  $('luckyCount').textContent=remaining;
  $('luckyToggle').disabled=busy||!player||remaining<=0;
  $('luckyToggle').classList.toggle('active',luckyArmed);
  $('luckyToggle').setAttribute('aria-pressed',String(luckyArmed));
  $('winArc').closest('svg').classList.toggle('lucky-mode',luckyArmed);
  $('boostHint').textContent=luckyArmed ? chance>=50 ? '777 · победа гарантирована':'777 · нужен обычный шанс от 50%':'777 · 3 гарантированные победы за сессию';
}
function multiplierPrice(price,multiplier) {
  const sourceCents=Math.round(price*100);
  const rawCents=sourceCents*multiplier;
  const targetCents=Math.round(rawCents+Number.EPSILON*Math.max(1,Math.abs(rawCents))*2);
  return Math.min(500000,Math.max(sourceCents+1,targetCents)/100);
}
function renderMultiplierButtons() {
  document.querySelectorAll('[data-multiplier]').forEach((button,index)=>{
    const multiplier=prefs.multipliers[index];
    button.dataset.multiplier=String(multiplier);
    const percent=source ? source.price/multiplierPrice(source.price,multiplier)*100:100/multiplier;
    const label=`×${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(multiplier)}`;
    button.innerHTML=`<span class="multiplier-value">${label}</span><span class="multiplier-chance">${percent.toFixed(2).replace('.',',')}%</span>`;
    button.disabled=busy;button.classList.toggle('active',activeMultiplier===multiplier);
    button.setAttribute('aria-label',`${label} · шанс ${percent.toFixed(2).replace('.',',')}%`);
    button.setAttribute('aria-pressed',String(activeMultiplier===multiplier));
  });
  $('multiplierSettings').disabled=busy;
  $('findChanceButton').disabled=busy;
}
function renderPlayer() {
  $('nickname').textContent = player?.nickname || 'Новая сессия';
  $('balance').textContent = money(player?.balance || 0);
  $('inventoryCount').textContent = player?.inventory.length || 0;
  $('inventoryButton').disabled = !player || busy;
  $('resetButton').disabled = !player || busy;
  renderSelection();
  if (mode === 'inventory') renderInventoryGrid();
  else renderShopGrid();
  renderInventoryModal();
  renderCart();
  document.body.classList.toggle('goal-unlocked',Boolean(player?.unlockedCode));
  $('goalReward').hidden=!player?.unlockedCode;
  $('goalCode').textContent=player?.unlockedCode || '';
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
  const sellable=player?.inventory.filter((item)=>item.id!=='code') || [];
  const total=sellable.reduce((sum,item)=>sum+Math.round(item.price*100),0)/100;
  for(const id of ['sellAllButton','sellAllInline']) {
    $(id).disabled=busy||!sellable.length;
    $(id).textContent='Продать всё';
    $(id).title=`Продать ${sellable.length} скинов за ${money(total)}`;
  }
  $('sellAllInline').hidden=mode!=='inventory';
}
function cartTotals() {
  let count=0,cents=0;
  for(const [id,quantity] of cart){count+=quantity;cents+=Math.round(cache.get(id).price*100)*quantity;}
  return {count,cents};
}
function renderShopGrid() {
  if(mode!=='shop')return;
  $('sourceGrid').innerHTML=shopItems.length ? shopItems.map((item)=>card(item,'add-cart')).join(''):empty('Скинов с такими параметрами нет','<span>Попробуйте изменить поиск или цену.</span>');
}
function renderCart() {
  const {count,cents}=cartTotals();
  const balance=Math.round((player?.balance || 0)*100);
  const full=(player?.inventory.length || 0)+count>200;
  $('shopCartBar').hidden=mode!=='shop';
  $('cartCount').textContent=count;
  $('cartButton').disabled=busy||!player;
  $('cartSummary').textContent=count ? `${count} шт. · ${money(cents/100)}`:'Добавляйте скины в корзину';
  $('cartTotal').textContent=money(cents/100);
  $('checkoutButton').disabled=busy||!player||!count||cents>balance||full;
  $('checkoutButton').textContent=busy ? 'Подождите…':`Купить${count ? ` · ${money(cents/100)}`:''}`;
  $('cartNotice').textContent=full ? 'В инвентаре помещается 200 предметов. Уменьшите корзину или продайте скины.':cents>balance ? `Не хватает ${money((cents-balance)/100)}. Уберите часть скинов из корзины.`:`На балансе: ${money(balance/100)}`;
  $('cartNotice').classList.toggle('error',full||cents>balance);
  $('cartItems').innerHTML=count ? [...cart].map(([id,quantity])=>{
    const item=cache.get(id);
    return `<div class="cart-row"><img src="${esc(item.image)}" alt="${esc(item.name)}" width="80" height="58"><div class="cart-item-info"><span>${esc(item.weapon)}</span><strong>${esc(item.name)}</strong><small>${money(item.price)} за шт.</small></div><div class="cart-stepper"><button type="button" data-action="cart-minus" data-key="${esc(id)}" aria-label="Уменьшить количество ${esc(item.name)}" ${busy?'disabled':''}>−</button><span>${quantity}</span><button type="button" data-action="add-cart" data-key="${esc(id)}" aria-label="Добавить ${esc(item.name)}" ${busy||count>=200?'disabled':''}>+</button></div><strong class="cart-line-total">${money(Math.round(item.price*100)*quantity/100)}</strong><button class="icon-button cart-remove" type="button" data-action="cart-remove" data-key="${esc(id)}" aria-label="Убрать ${esc(item.name)} из корзины" ${busy?'disabled':''}><svg class="icon"><use href="#icon-close"/></svg></button></div>`;
  }).join(''):empty('Корзина пуста','<span>Выберите скины в магазине. Можно добавить несколько одинаковых.</span>');
}
function changeCart(id,change) {
  if(busy||!player)return;
  const item=cache.get(id);if(!item||id==='code')return;
  if(change>0 && cartTotals().count>=200){toast('В корзине может быть не больше 200 скинов.');return;}
  const quantity=change===null ? 0:(cart.get(id)||0)+change;
  if(quantity>0)cart.set(id,quantity);else cart.delete(id);
  renderCart();renderShopGrid();
}
function pager(element,page,pages,total,side) {
  $(element).innerHTML = `<button type="button" data-action="page" data-side="${side}" data-page="${page-1}" ${page<=1?'disabled':''} aria-label="Предыдущая страница">←</button><span>${total ? `${page} / ${pages}`:'Нет предметов'}<small>${new Intl.NumberFormat('ru-RU').format(total)} предложений</small></span><button type="button" data-action="page" data-side="${side}" data-page="${page+1}" ${page>=pages?'disabled':''} aria-label="Следующая страница">→</button>`;
}
async function loadShop() {
  if (mode !== 'shop') return;
  const seq = ++shopSequence;
  const params = new URLSearchParams({min:$('shopMin').value || '10',max:$('shopMax').value || '499999.99',q:$('shopSearch').value,sort:$('shopSort').value || 'asc',page:shopPage,limit:20});
  try {
    const data = await api(`catalog?${params}`);
    if (seq !== shopSequence || mode !== 'shop') return;
    const items = data.items.filter((i)=>i.id !== 'code'); items.forEach((i)=>cache.set(i.id,i));
    shopItems=items;
    if($('sourceCount')) $('sourceCount').textContent=`${new Intl.NumberFormat('ru-RU').format(data.total)} скинов`;
    renderShopGrid();
    pager('sourcePager',data.page,data.pages,data.total,'shop'); renderSelection();
  } catch(error) { if(seq===shopSequence) $('sourceGrid').innerHTML = empty(error.message,'<button class="button" data-action="retry-shop">Повторить</button>'); }
}
async function loadTargets() {
  const seq = ++targetSequence;
  const params = new URLSearchParams({min:$('targetMin').value || '10',max:$('targetMax').value || '499999.99',q:$('targetSearch').value,sort:$('targetSort').value || 'desc',page:targetPage,limit:19});
  try {
    const data = await api(`catalog?${params}`);
    if (seq !== targetSequence) return;
    const items = data.items.filter((i)=>i.id!=='code'); items.forEach((i)=>cache.set(i.id,i));
    const selectedExtra=target && target.id!=='code' && !items.some((i)=>i.id===target.id) ? card(target,'select-target',true):'';
    $('targetGrid').innerHTML = card(goal,'select-target',target?.id==='code') + selectedExtra + (items.length ? items.map((i)=>card(i,'select-target',target?.id===i.id)).join(''):empty('По вашему запросу ничего не найдено'));
    pager('targetPager',data.page,data.pages,data.total,'target');
  } catch(error) { if(seq===targetSequence) $('targetGrid').innerHTML = empty(error.message,'<button class="button" data-action="retry-target">Повторить</button>'); }
}
function switchMode(next) {
  mode = next; shopSequence++;
  if ($('sourceTitle')) $('sourceTitle').textContent = mode==='shop' ? 'Магазин скинов':'Мой инвентарь';
  $('inventoryTab').classList.toggle('active',mode==='inventory'); $('shopTab').classList.toggle('active',mode==='shop');
  $('inventoryTab').setAttribute('aria-selected',mode==='inventory'); $('shopTab').setAttribute('aria-selected',mode==='shop');
  $('shopFilters').hidden = mode !== 'shop';
  $('sellAllInline').hidden=mode!=='inventory';renderCart();
  if(mode==='shop') loadShop(); else renderInventoryGrid();
}
async function checkout() {
  const {count,cents}=cartTotals();
  if(busy||!player||!count||cents>Math.round(player.balance*100)||player.inventory.length+count>200)return;
  const items=[...cart].map(([itemId,quantity])=>({itemId,quantity}));
  const previousIds=new Set(player.inventory.map((item)=>item.inventoryId));
  const complete=(data)=>{saveSnapshot(data);cart.clear();$('cartDialog').close();toast(`Куплено: ${count} шт. за ${money(cents/100)}. Скины в инвентаре.`);};
  busy=true;renderPlayer();
  try {
    complete(await api('buy-cart',{token,items}));
  } catch(error) {
    if(!error.status || error.code==='STALE_SESSION') {
      try {
        const latest=await api('resume',{token});
        const added=latest.player.inventory.filter((item)=>!previousIds.has(item.inventoryId));
        if(added.length===count && items.every((entry)=>added.filter((item)=>item.id===entry.itemId).length===entry.quantity)){complete(latest);return;}
        saveSnapshot(latest);
      } catch { /* Keep the cart for a later attempt if the server is unavailable. */ }
    }
    toast(error.message);
  } finally {busy=false;renderPlayer();flushOtherTab();}
}
async function sell(inventoryId) {
  if(busy) return;
  busy = true; renderPlayer();
  try { const item=player.inventory.find((i)=>i.inventoryId===inventoryId); saveSnapshot(await api('sell',{token,inventoryId})); toast(`Продано за ${money(item.price)}`); }
  catch(error) { toast(error.message); }
  finally { busy=false; renderPlayer(); if(mode==='shop') loadShop(); flushOtherTab(); }
}
async function sellAll() {
  if(busy||!player||!player.inventory.some((item)=>item.id!=='code'))return;
  busy=true;renderPlayer();
  try {
    const data=await api('sell-all',{token});saveSnapshot(data);
    toast(`Продано: ${data.sale.count} шт. за ${money(data.sale.total)}`);
  } catch(error) {
    toast(error.message);
    if(!error.status)try{saveSnapshot(await api('resume',{token}));}catch{}
  } finally {busy=false;renderPlayer();flushOtherTab();}
}
async function selectSource(id) {
  if(busy) return;
  selectionSequence++;targetLoading=false;
  source = player.inventory.find((i)=>i.inventoryId===id);
  if(!source) return;
  renderPlayer();
  if(activeMultiplier || !target || target.price<=source.price) await pickMultiplier(activeMultiplier || prefs.multipliers[0],false);
  renderInventoryGrid();
}
function selectTarget(id) {
  if(busy) return;
  selectionSequence++;
  targetLoading=false;activeMultiplier=null;
  target = cache.get(id); renderSelection();
  document.querySelectorAll('#targetGrid .item-card').forEach((el)=>{const chosen=el.dataset.key===id;el.classList.toggle('selected',chosen);el.setAttribute('aria-pressed',chosen);});
}
async function pickMultiplier(multiplier,notify=true) {
  if(!Number.isFinite(multiplier)||multiplier<=1) return;
  activeMultiplier=multiplier;
  if(!source) {renderMultiplierButtons();if(notify)toast('Множитель выбран. Теперь выберите свой скин слева.');return;}
  const seq = ++selectionSequence, sourceId = source.inventoryId;
  const price = multiplierPrice(source.price,multiplier);
  targetLoading=true;activeMultiplier=multiplier;renderSelection();
  try {
    const item = price===500000 ? goal:await api(`item?id=skin-${price}`);
    if(seq !== selectionSequence || source?.inventoryId !== sourceId) return;
    const resolved = item.item || item; cache.set(resolved.id,resolved); target=resolved;
    $('targetMin').value=Math.max(10,price-50); $('targetMax').value=Math.min(500000,price+130); $('targetSort').value='asc'; targetPage=1;
    targetLoading=false;renderSelection(); await loadTargets();
  } catch(error) { if(seq===selectionSequence){activeMultiplier=null;toast(error.message);} }
  finally {if(seq===selectionSequence){targetLoading=false;renderSelection();}}
}
async function animatePointer(angle) {
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0:prefs.fast ? 550:3600;
  const start = rotation;
  const normalized = ((rotation%360)+360)%360;
  const end = rotation + (prefs.fast ? 720:1800) + ((angle-normalized+360)%360);
  await new Promise((resolve)=>{
    const begins = performance.now();
    let lastTick = -1000, lastSector=Math.floor(start/24);
    function frame(now) {
      const t = duration ? Math.min(1,(now-begins)/duration):1;
      rotation = start+(end-start)*(1-Math.pow(1-t,4));
      $('pointer').setAttribute('transform',`rotate(${rotation} 200 200)`);
      const sector=Math.floor(rotation/24);
      if(duration && t<1 && sector!==lastSector && now-lastTick>=35){spinTick();lastTick=now;lastSector=sector;}
      if(t<1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}
async function upgrade() {
  if(busy || targetLoading || !source || !target || target.price<=source.price) return;
  if(luckyArmed && source.price/target.price<.5){toast('777 доступен только при обычном шансе от 50%.');return;}
  selectionSequence++;
  primeAudio();
  busy=true; renderPlayer(); setStatus('Круг вращается…');
  const previousSource = source;
  let finalStatus = '',finalKind='';
  try {
    const data = await api('upgrade',{token,inventoryId:source.inventoryId,targetId:target.id,lucky:luckyArmed});
    // Persist before animation: refreshing cannot repeat or undo the result.
    saveSnapshot(data,false); source=previousSource;
    await animatePointer(data.result.angle);
    source=null;
    if(data.result.luckyUsed) luckyArmed=false;
    busy=false; renderPlayer(); switchMode('inventory'); sound(data.result.won);
    finalStatus = data.result.won ? data.result.item.id==='code' ? 'Цель достигнута! Код открыт ниже и сохранён в инвентаре.':`${data.result.luckyUsed ? '777 · ':''}Успех! ${data.result.item.name} добавлен в инвентарь.`:'Неудача. Выбранный скин потерян.';
    finalKind=data.result.won ? 'success':'error';
    setStatus(finalStatus,finalKind);
    if(!data.result.won && player.balance<10 && !player.inventory.some((i)=>i.id!=='code')) finalStatus='Скины закончились. Нажмите «Повторить сессию», чтобы начать заново.';
  } catch(error) {
    toast(error.message);
    // Recover an already committed response if the connection dropped after mutation.
    try { saveSnapshot(await api('resume',{token})); } catch { /* Leave stored token for next attempt. */ }
  } finally { busy=false; renderPlayer(); if(finalStatus)setStatus(finalStatus,finalKind); loadTargets(); flushOtherTab(); }
}
function debounce(fn) { let timer; return () => {clearTimeout(timer);timer=setTimeout(fn,220);}; }
document.addEventListener('click',async(event)=>{
  const close = event.target.closest('[data-close]');
  if(close) { const dialog=$(close.dataset.close); if(dialog && dialog.id!=='welcomeDialog') dialog.close(); }
  const preset=event.target.closest('[data-multiplier]');
  if(preset && !busy){pickMultiplier(Number(preset.dataset.multiplier));return;}
  const button = event.target.closest('[data-action]');
  if(!button) return;
  const action=button.dataset.action;
  if(action==='add-cart') changeCart(button.dataset.key,1);
  if(action==='cart-minus') changeCart(button.dataset.key,-1);
  if(action==='cart-remove') changeCart(button.dataset.key,null);
  if(action==='sell') sell(button.dataset.key);
  if(action==='sell-all') sellAll();
  if(action==='select-source') selectSource(button.dataset.key);
  if(action==='select-target') selectTarget(button.dataset.key);
  if(action==='open-shop') { switchMode('shop'); $('sourceGrid').scrollIntoView({behavior:'smooth',block:'center'}); }
  if(action==='find-in-shop' && !busy) {
    const item=cache.get(button.dataset.key);if(!item || item.id==='code')return;
    $('shopSearch').value='';$('shopMin').value=String(item.price);$('shopMax').value=String(item.price);$('shopSort').value='asc';shopPage=1;
    switchMode('shop');$('sourceGrid').scrollIntoView({behavior:'smooth',block:'center'});
  }
  if(action==='retry-shop') loadShop();
  if(action==='retry-target') loadTargets();
  if(action==='page') { if(button.dataset.side==='shop') {shopPage=Number(button.dataset.page);loadShop();} else {targetPage=Number(button.dataset.page);loadTargets();} }
  if(action==='copy-code' && player?.unlockedCode) { try {await navigator.clipboard.writeText(player.unlockedCode);toast('Код скопирован.');} catch {toast('Выделите и скопируйте код вручную.');} }
});
$('inventoryTab').addEventListener('click',()=>switchMode('inventory'));
$('shopTab').addEventListener('click',()=>switchMode('shop'));
$('inventoryButton').addEventListener('click',()=>{renderInventoryModal();showDialog('inventoryDialog');});
$('cartButton').addEventListener('click',()=>{renderCart();showDialog('cartDialog');});
$('checkoutButton').addEventListener('click',checkout);
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
    saveSnapshot(await api('session',{nickname}));$('welcomeDialog').close();$('shopMax').value='';switchMode('shop');toast('Вам зачислено 500 ₽. Выберите первый скин!');
  } catch(error) {$('welcomeError').textContent=error.message;}
  finally {busy=false;submit.disabled=false;renderPlayer();loadShop();loadTargets();flushOtherTab();}
});
$('upgradeButton').addEventListener('click',upgrade);
for(const id of ['shopSearch','shopMin','shopMax']) $(id).addEventListener('input',debounce(()=>{shopPage=1;loadShop();}));
for(const id of ['targetSearch','targetMin','targetMax']) $(id).addEventListener('input',debounce(()=>{targetPage=1;loadTargets();}));
$('targetSort').addEventListener('change',()=>{targetPage=1;loadTargets();});
$('shopSort').addEventListener('change',()=>{shopPage=1;loadShop();});
$('shopAllButton').addEventListener('click',()=>{$('shopMin').value='';$('shopMax').value='';$('shopSearch').value='';shopPage=1;loadShop();});
$('multiplierSettings').addEventListener('click',()=>{
  if(busy)return;
  prefs.multipliers.forEach((value,i)=>{$(`multiplier${i}`).value=String(value);});
  $('multiplierError').textContent='';showDialog('multiplierDialog');
});
$('restoreMultipliers').addEventListener('click',()=>{DEFAULT_MULTIPLIERS.forEach((value,i)=>{$(`multiplier${i}`).value=String(value);});$('multiplierError').textContent='';});
$('multiplierForm').addEventListener('submit',async(event)=>{
  event.preventDefault();if(busy)return;
  const values=DEFAULT_MULTIPLIERS.map((_,i)=>Number($(`multiplier${i}`).value));
  if(values.some((value)=>!Number.isFinite(value)||value<1.01||value>50000||Math.abs(value*100-Math.round(value*100))>1e-7)){$('multiplierError').textContent='Введите значения от 1,01 до 50 000, не более двух знаков после запятой.';return;}
  const activeIndex=prefs.multipliers.indexOf(activeMultiplier);
  prefs.multipliers=values;savePreferences();$('multiplierDialog').close();
  if(activeIndex>=0)await pickMultiplier(values[activeIndex],false);
  renderMultiplierButtons();toast('Множители сохранены.');
});
$('luckyToggle').addEventListener('click',()=>{
  if(busy||!player||(player.boosters?.luckyRemaining??3)<=0)return;
  luckyArmed=!luckyArmed;renderSelection();
});
$('findChanceButton')?.addEventListener('click',()=>{
  const chance=Number($('desiredChanceInput').value);
  if(!Number.isFinite(chance)||chance<=0||chance>=100){toast('Введите шанс больше 0 и меньше 100%.');return;}
  if(!busy)pickMultiplier(100/chance);
});
function renderPreferences() {
  $('soundToggle').classList.toggle('active',prefs.sound); $('soundToggle').setAttribute('aria-pressed',prefs.sound);
  $('soundToggle').setAttribute('aria-label',prefs.sound ? 'Выключить звук':'Включить звук');
  $('fastToggle').classList.toggle('active',prefs.fast); $('fastToggle').setAttribute('aria-pressed',prefs.fast);
}
for(const [id,key] of [['soundToggle','sound'],['fastToggle','fast']]) $(id).addEventListener('click',()=>{prefs[key]=!prefs[key];renderPreferences();savePreferences();if(key==='sound' && prefs.sound)primeAudio();toast(key==='sound' ? `Звук ${prefs.sound?'включён':'выключен'}`:`Быстрая анимация ${prefs.fast?'включена':'выключена'}`);});
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
  $('shopMax').value='';
  renderPlayer();switchMode(mode);await loadTargets();
}
init();
