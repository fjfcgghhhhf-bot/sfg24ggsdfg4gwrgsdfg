import { randomUUID } from 'node:crypto';

export function createBattles({catalog,sessions,resolve,snapshot,remember,saveRecord,recordUpgrade,random,now,changed,GameError}) {
  const battles=new Map(),duration=300_000,waitDuration=900_000;
  const cents=(price)=>Math.round(price*100);
  const fail=(message,code)=>{throw new GameError(message,code);};
  const save=(battle)=>{battles.set(battle.id,battle);changed('battle',battle.id,battle);return battle;};
  const total=(player)=>player.chains.reduce((sum,chain)=>sum+(chain.itemId?cents(catalog.get(chain.itemId).price):0),0);
  const activeFor=(id)=>[...battles.values()].find((battle)=>['waiting','active'].includes(battle.status)&&battle.players.some((p)=>p.id===id));
  const get=(id)=>{const battle=battles.get(id);if(!battle)throw new GameError('Батл не найден.','BATTLE_NOT_FOUND',404);return battle;};
  function credit(id,amount) {
    const record=sessions.get(id),state=structuredClone(record.state);
    state.balanceCents+=amount;state.revision++;remember(state);
  }
  function settle(battle,cancelled=false) {
    if(!['waiting','active'].includes(battle.status))return;
    battle=structuredClone(battle);
    const scores=battle.players.map(total);
    const tie=!cancelled&&scores[0]===scores[1];
    const winner=cancelled||tie ? null:battle.players[scores[0]>scores[1]?0:1].id;
    for(const player of battle.players) {
      const payout=cancelled||tie ? battle.depositCents:player.id===winner?battle.depositCents*2:0;
      if(payout)credit(player.id,payout);
      if(!cancelled) {
        const record=sessions.get(player.id),profile={...record.profile};
        profile.battlesPlayed++;if(player.id===winner)profile.battleWins++;
        saveRecord({...record,profile});
      }
      player.payout=payout/100;
    }
    battle.status=cancelled?'cancelled':'finished';battle.finishedAt=now();battle.winnerId=winner;battle.tie=tie;battle.revision++;
    save(battle);
  }
  function tick() {
    const time=now();
    for(const battle of battles.values()) {
      if(battle.status==='waiting'&&time>=battle.createdAt+waitDuration)settle(battle,true);
      else if(battle.status==='active'&&(time>=battle.endsAt||battle.players.every((p)=>p.stopped)))settle(battle);
    }
  }
  function view(battle) {
    return {...battle,deposit:battle.depositCents/100,bank:battle.depositCents*battle.players.length/100,serverNow:now(),waitEndsAt:battle.createdAt+waitDuration,
      players:battle.players.map((player)=>({...player,total:total(player)/100,chains:player.chains.map((chain)=>({...chain,item:chain.itemId?catalog.get(chain.itemId):null}))}))};
  }
  function response(token,battle) { return {...snapshot(resolve(token)),battle:view(get(battle.id))}; }
  function debit(token,amount) {
    const record=resolve(token,true);
    if(record.state.balanceCents<amount)fail('Недостаточно средств для взноса.','INSUFFICIENT_FUNDS');
    // Reserve enough headroom for any later payout before accepting an entry.
    if(!Number.isSafeInteger(record.state.balanceCents+amount*2))fail('Достигнут предел баланса.','BALANCE_LIMIT');
    const state=structuredClone(record.state);state.balanceCents-=amount;state.revision++;remember(state);
    return record.state.sid;
  }
  function participant(record,prices) {
    return {id:record.state.sid,nickname:record.state.nickname,stopped:false,attempts:0,nextSpinAt:0,
      chains:prices.map((price,index)=>({id:randomUUID(),index:index+1,itemId:`skin-${price/100}`,attempts:0}))};
  }
  return {
    tick,clear:()=>battles.clear(),hydrate:(id,data)=>battles.set(id,data),
    recent(){const all=[...battles.values()];return [...all.filter((b)=>['waiting','active'].includes(b.status)),...all.filter((b)=>!['waiting','active'].includes(b.status)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,30)].map(view);},
    assertCanReset(id) {tick();if(activeFor(id))fail('Сначала завершите батл или отмените ожидание соперника.','BATTLE_IN_PROGRESS');},
    list() {tick();return {serverNow:now(),battles:[...battles.values()].filter((b)=>b.status==='waiting'||b.status==='active').sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(view)};},
    state(token,id) {
      tick();const record=resolve(token);
      const battle=id?get(id):activeFor(record.state.sid)||[...battles.values()].filter((b)=>b.players.some((p)=>p.id===record.state.sid)).sort((a,b)=>b.createdAt-a.createdAt)[0];
      return {...snapshot(record),battle:battle?view(battle):null};
    },
    create(token,amount,count,targetPlayerId=null) {
      tick();const record=resolve(token,true);
      if(activeFor(record.state.sid))fail('У вас уже есть незавершённый батл.','BATTLE_IN_PROGRESS');
      if(targetPlayerId){
        const opponent=sessions.get(targetPlayerId);
        if(targetPlayerId===record.state.sid||!opponent||opponent.revoked)fail('Этот игрок недоступен.','INVALID_OPPONENT');
        if(activeFor(targetPlayerId))fail('Игрок уже участвует в батле.','OPPONENT_BUSY');
      }
      if(typeof amount!=='number'||!Number.isFinite(amount)||amount<10||amount>1_000_000||Math.abs(amount*100-cents(amount))>1e-7)fail('Взнос: от 10 до 1 000 000 ₽, не больше двух знаков после запятой.','INVALID_DEPOSIT');
      if(!Number.isInteger(count)||count<1||count>10)fail('Выберите от 1 до 10 цепочек.','INVALID_CHAINS');
      const depositCents=cents(amount),part=Math.floor(depositCents/count);
      const prices=Array.from({length:count},(_,i)=>part+(i<depositCents%count?1:0));
      if(prices.some((price)=>price<1000||price>37_499_999))fail('На каждый стартовый скин должно приходиться от 10 до 374 999,99 ₽.','INVALID_SPLIT');
      if([...battles.values()].filter((b)=>['waiting','active'].includes(b.status)).length>=100)fail('Сейчас слишком много открытых батлов. Присоединитесь к одному из них.','BATTLE_CAPACITY');
      debit(token,depositCents);
      const battle=save({id:randomUUID(),revision:0,status:'waiting',createdAt:now(),startedAt:null,endsAt:null,depositCents,count,prices,targetPlayerId,players:[participant(record,prices)]});
      return response(token,battle);
    },
    join(token,id) {
      tick();const record=resolve(token,true),original=get(id);
      if(original.players.some((p)=>p.id===record.state.sid))fail('Нельзя вступить в свой батл.','SELF_BATTLE');
      if(original.status!=='waiting')fail('Соперник уже найден или батл закрыт.','BATTLE_NOT_WAITING');
      if(original.targetPlayerId&&original.targetPlayerId!==record.state.sid)fail('Этот вызов предназначен другому игроку.','BATTLE_RESERVED');
      if(activeFor(record.state.sid))fail('Сначала завершите текущий батл.','BATTLE_IN_PROGRESS');
      const battle=structuredClone(original);
      debit(token,battle.depositCents);
      battle.players.push(participant(record,battle.prices));battle.status='active';battle.startedAt=now();battle.endsAt=now()+duration;battle.revision++;
      save(battle);return response(token,battle);
    },
    cancel(token,id) {
      tick();const record=resolve(token),battle=get(id);
      if(battle.status!=='waiting'||battle.players[0].id!==record.state.sid)fail('Отменить можно только свой батл в ожидании.','CANNOT_CANCEL_BATTLE');
      settle(battle,true);return response(token,battle);
    },
    decline(token,id) {
      tick();const record=resolve(token),battle=get(id);
      if(battle.targetPlayerId!==record.state.sid)fail('Этот вызов предназначен другому игроку.','BATTLE_RESERVED');
      if(battle.status==='waiting')settle(battle,true);
      return response(token,battle);
    },
    stop(token,id) {
      tick();const record=resolve(token),original=get(id);
      if(!original.players.some((p)=>p.id===record.state.sid))fail('Вы не участвуете в этом батле.','NOT_BATTLE_PLAYER');
      if(original.status!=='active')return response(token,original);
      const battle=structuredClone(original);battle.players.find((p)=>p.id===record.state.sid).stopped=true;battle.revision++;
      save(battle);tick();return response(token,battle);
    },
    upgrade(token,id,chainId,targetId,expectedAttempt,lucky,fast=false) {
      tick();const record=resolve(token),original=get(id);
      if(original.status!=='active')fail('Батл уже завершён или ещё не начался.','BATTLE_NOT_ACTIVE');
      const battle=structuredClone(original),player=battle.players.find((p)=>p.id===record.state.sid);
      if(!player)fail('Вы не участвуете в этом батле.','NOT_BATTLE_PLAYER');
      if(player.stopped)fail('Вы нажали «Стоп». Новые попытки недоступны.','BATTLE_STOPPED');
      if(lucky!==undefined&&lucky!==false)fail('777 в батлах отключён.','BATTLE_BOOSTER_DISABLED');
      if(now()<player.nextSpinAt)fail('Дождитесь остановки стрелки.','BATTLE_SPIN_PENDING');
      const chain=player.chains.find((c)=>c.id===chainId);
      if(!chain||!chain.itemId)fail('В этой цепочке больше нет скина.','CHAIN_EMPTY');
      if(!Number.isInteger(expectedAttempt)||expectedAttempt!==chain.attempts)fail('Попытка уже обработана. Обновляем батл.','STALE_BATTLE');
      const source=catalog.get(chain.itemId),target=catalog.get(targetId);
      if(target.id==='code')fail('Код доступен только в обычных апгрейдах.','BATTLE_GOAL_DISABLED');
      if(target.price<=source.price)fail('Выберите более дорогой скин.','TARGET_TOO_CHEAP');
      if(cents(source.price)*100>cents(target.price)*75)fail('Максимальный шанс — 75%.','CHANCE_TOO_HIGH');
      const chance=cents(source.price)/cents(target.price),draw=random();
      if(!Number.isFinite(draw)||draw<0||draw>=1)throw new Error('Random source out of range.');
      const angle=draw*360,won=angle>=180-180*chance&&angle<180+180*chance;
      const actualDuration=fast===true?867:1300,startedAt=now();
      chain.itemId=won?target.id:null;chain.attempts++;player.attempts++;player.nextSpinAt=startedAt+actualDuration;
      player.lastSpin={id:randomUUID(),startedAt,duration:actualDuration,angle,chance:chance*100,won,sourceId:source.id,targetId:target.id,chainId,turns:3};
      player.stopped=player.chains.every((c)=>!c.itemId||cents(catalog.get(c.itemId).price)*100>49_999_999*75);
      battle.revision++;save(battle);
      const result={won,chance:chance*100,angle,item:target,luckyUsed:false,mode:'battle',battleId:id};
      recordUpgrade(player.id,source,target,result,'battle',id);tick();
      return {...response(token,battle),result,spinDuration:actualDuration};
    },
  };
}
