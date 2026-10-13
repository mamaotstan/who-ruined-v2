const API="https://api.opendota.com/api";
const CDN="https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react";
const $=id=>document.getElementById(id);
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const fmt=n=>(n||0).toLocaleString("ru-RU");
const time=s=>`${Math.floor((s||0)/60)}:${String(Math.floor((s||0)%60)).padStart(2,"0")}`;
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
let HEROES={},ITEMS={};

$("form").addEventListener("submit",async e=>{
 e.preventDefault(); const id=$("matchId").value.trim(); if(!/^\d+$/.test(id))return;
 $("status").textContent="Загружаем матч, героев и предметы…"; $("result").classList.add("hidden");
 try{
  const [mr,hr,ir]=await Promise.all([fetch(`${API}/matches/${id}`),fetch(`${API}/constants/heroes`),fetch(`${API}/constants/items`)]);
  if(!mr.ok)throw Error("Матч не найден");
  let m=await mr.json(); HEROES=hr.ok?await hr.json():{}; ITEMS=ir.ok?await ir.json():{};
  // Auto-parse: if match not parsed (no version/lane data), request parse and poll
  if(!m.version){
   $("status").innerHTML=`Матч не распарсен. <button id="parseBtn" type="button">Допарсить матч</button> <span id="parseProg"></span>`;
   $("parseBtn").onclick=()=>requestParse(id);
   await analyze(m); // show basic analysis meanwhile
   $("status").innerHTML+=`<br>Показан базовый разбор. Допарси для точных ролей и вардов. <button id="parseBtn2" type="button">Допарсить матч</button> <span id="parseProg"></span>`;
   const b2=$("parseBtn2"); if(b2)b2.onclick=()=>requestParse(id);
  } else {
   await await analyze(m); $("status").textContent=`Матч ${id} обработан`;
  }
  saveHist(id); location.hash='match='+id;
 }catch(err){$("status").textContent="Ошибка: "+err.message}
});

async function requestParse(id){
 const prog=$("parseProg")||$("status");
 try{
  prog.textContent="Отправляем запрос на парсинг…";
  const rr=await fetch(`${API}/request/${id}`,{method:"POST"});
  if(!rr.ok)throw Error("OpenDota отклонил запрос");
  const poll=async attempt=>{
   if(attempt>20){prog.textContent="Парсинг затянулся, попробуй ввести ID заново через пару минут";return;}
   prog.textContent=`Парсим реплей… (${attempt*15} сек)`;
   await new Promise(r=>setTimeout(r,15000));
   const mr=await fetch(`${API}/matches/${id}`);
   if(!mr.ok){poll(attempt+1);return;}
   const m=await mr.json();
   if(m.version){
    prog.textContent="Готово, обновляем разбор…";
    await analyze(m);
    $("status").textContent=`Матч ${id} допарсен и обработан`;
   } else poll(attempt+1);
  };
  poll(1);
 }catch(err){prog.textContent="Ошибка парсинга: "+err.message}
}

function heroData(p){return HEROES[String(p.hero_id)]||HEROES[p.hero_id]||{};}
function heroName(p){return heroData(p).localized_name||`Hero #${p.hero_id}`;}
function heroImg(p){const h=heroData(p); if(h.img)return `https://cdn.cloudflare.steamstatic.com${h.img}`; return `${CDN}/heroes/${String(h.localized_name||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.png`;}
function itemData(id){return ITEMS[String(id)]||ITEMS[id]||{};}
function itemImg(id){const it=itemData(id); if(it.img)return `https://cdn.cloudflare.steamstatic.com${it.img}`; return "";}
function itemName(id){return itemData(id).dname||itemData(id).localized_name||"Item";}
function rankName(t){const n=Number(t||0),m=Math.floor(n/10),stars=n%10; const name=({1:"Herald",2:"Guardian",3:"Crusader",4:"Archon",5:"Legend",6:"Ancient",7:"Divine",8:"Immortal"})[m]||"Unranked"; return stars?`${name} ${stars}`:name;}
function rankImg(t){const m=Math.floor(Number(t||0)/10);return m?`https://www.opendota.com/assets/images/dota2/rank_icons/rank_icon_${m}.png`:"";}
function itemsOf(p){return [0,1,2,3,4,5].map(k=>p[`item_${k}`]).concat([0,1,2].map(k=>p[`backpack_${k}`])).concat([p.item_neutral]).filter(Boolean);}

function inferRoles(team,duration){
  // Multi-signal role detection: lane + early economy + final resources
  // OpenDota lane_role is a lane category, not POS 1-5:
  // 1=safe, 2=mid, 3=offlane, 4=jungle/other. We cross-check with economy.
  const value=x=>(x.net_worth||0)*.55+(x.gold_per_min||0)*.25+(x.last_hits||0)*.12+(x.xp_per_min||0)*.08;
  const earlyValue=x=>{
    // Use 10-min economy if available (gold_t[10], xp_t[10])
    const g10 = (x.gold_t && x.gold_t[10]) || 0;
    const xp10 = (x.xp_t && x.xp_t[10]) || 0;
    return g10 > 0 ? g10 * 0.6 + xp10 * 0.4 : value(x) * 0.7;  // fallback to final if no early data
  };
  const lane=x=>Number(x.lane_role||0);
  const assigned=new Map();

  // Confidence calculation: lane + early + final agree = high, disagree = low
  const calcConfidence = (hasLane, earlyMatch, finalMatch) => {
    let conf = 40;
    if (hasLane) conf += 30;
    if (earlyMatch) conf += 20;
    if (finalMatch) conf += 15;
    if (hasLane && earlyMatch && finalMatch) conf += 10;  // bonus for full agreement
    return Math.min(95, conf);
  };

  // 1. Mid lane: lane_role === 2, verify with early economy
  const midCandidates = team.filter(x=>lane(x)===2).sort((a,b)=>earlyValue(b)-earlyValue(a));
  if(midCandidates.length) {
    const p = midCandidates[0];
    const teamEarlySorted = team.filter(x=>lane(x)!==2).sort((a,b)=>earlyValue(b)-earlyValue(a));
    const isEarlyTop3 = earlyValue(p) >= earlyValue(teamEarlySorted[Math.min(2, teamEarlySorted.length-1)] || {});
    const conf = calcConfidence(true, isEarlyTop3, true);
    assigned.set(p.player_slot,{position:2,role:'Pos 2 · Mid',confidence:conf,source:`lane + economy (${conf}% conf)`});
  } else {
    // No lane_role=2 found, pick highest early eco as fallback mid
    const sorted = team.filter(x=>!assigned.has(x.player_slot)).sort((a,b)=>earlyValue(b)-earlyValue(a));
    if (sorted.length) {
      const p = sorted[0];
      const conf = calcConfidence(false, true, true);
      assigned.set(p.player_slot,{position:2,role:'Pos 2 · Mid',confidence:conf,source:`early eco fallback (${conf}% conf)`});
    }
  }

  // 2. Safe lane: lane_role === 1, split by value
  const safe=team.filter(x=>lane(x)===1 && !assigned.has(x.player_slot)).sort((a,b)=>value(b)-value(a));
  if(safe.length>=2){
    const p1 = safe[0], p5 = safe[1];
    const conf1 = calcConfidence(true, true, true);
    const conf5 = calcConfidence(true, true, true);
    assigned.set(p1.player_slot,{position:1,role:'Pos 1 · Carry',confidence:conf1,source:`safe lane split (${conf1}%)`});
    assigned.set(p5.player_slot,{position:5,role:'Pos 5 · Hard Support',confidence:conf5,source:`safe lane split (${conf5}%)`});
  }else if(safe.length===1){
    const p=safe[0];
    const rank=team.filter(x=>lane(x)!==2 && !assigned.has(x.player_slot)).sort((a,b)=>value(b)-value(a));
    const isCore=value(p)>=value(rank[Math.min(2,rank.length-1)]||p);
    const conf = calcConfidence(true, isCore, isCore);
    assigned.set(p.player_slot,{position:isCore?1:5,role:isCore?'Pos 1 · Carry':'Pos 5 · Hard Support',confidence:conf,source:`safe lane single (${conf}%)`});
  }

  // 3. Offlane: lane_role === 3, split by value
  const off=team.filter(x=>lane(x)===3 && !assigned.has(x.player_slot)).sort((a,b)=>value(b)-value(a));
  if(off.length>=2){
    const p3 = off[0], p4 = off[1];
    const conf3 = calcConfidence(true, true, true);
    const conf4 = calcConfidence(true, true, true);
    assigned.set(p3.player_slot,{position:3,role:'Pos 3 · Offlane',confidence:conf3,source:`offlane split (${conf3}%)`});
    assigned.set(p4.player_slot,{position:4,role:'Pos 4 · Soft Support',confidence:conf4,source:`offlane split (${conf4}%)`});
  }else if(off.length===1){
    const p=off[0];
    const nonMid=team.filter(x=>lane(x)!==2 && !assigned.has(x.player_slot)).sort((a,b)=>value(b)-value(a));
    const isCore=value(p)>=value(nonMid[Math.min(1,nonMid.length-1)]||p);
    const conf = calcConfidence(true, isCore, isCore);
    assigned.set(p.player_slot,{position:isCore?3:4,role:isCore?'Pos 3 · Offlane':'Pos 4 · Soft Support',confidence:conf,source:`offlane single (${conf}%)`});
  }

  // 4. Fill missing positions with remaining players by value
  const positions=[1,2,3,4,5];
  const used=new Set([...assigned.values()].map(x=>x.position));
  const missing=positions.filter(x=>!used.has(x));
  const remaining=team.filter(p=>!assigned.has(p.player_slot)).sort((a,b)=>value(b)-value(a));
  for(const pos of missing){
    const p=remaining.shift(); if(!p)break;
    const data={
      1:['Pos 1 · Carry',50],2:['Pos 2 · Mid',55],3:['Pos 3 · Offlane',50],4:['Pos 4 · Soft Support',48],5:['Pos 5 · Hard Support',48]
    }[pos];
    assigned.set(p.player_slot,{position:pos,role:data[0],confidence:data[1],source:`value fallback (${data[1]}% conf)`});
  }

  // Return a role for every player
  return Object.fromEntries(team.map(p=>[p.player_slot,assigned.get(p.player_slot)||{position:5,role:'Pos 5 · Hard Support',confidence:40,source:'fallback'}]));
}

function inferRole(p,team,duration){
  return inferRoles(team,duration)[p.player_slot] || {position:5,role:'Pos 5 · Hard Support',confidence:40,source:'fallback'};
}
function roleWeights(role,duration){
 const pos=Number(String(role||'').match(/Pos (\d)/)?.[1]||0);
 const base=({
  1:{farm:.26,fight:.25,error:.28,obj:.14,utility:.07},
  2:{farm:.16,fight:.32,error:.27,obj:.18,utility:.07},
  3:{farm:.12,fight:.32,error:.22,obj:.22,utility:.12},
  4:{farm:.06,fight:.32,error:.21,obj:.20,utility:.21},
  5:{farm:.04,fight:.28,error:.19,obj:.17,utility:.32}
 })[pos]||{farm:.15,fight:.28,error:.25,obj:.20,utility:.12};
 // Dynamic by game length: late = deaths cost more, farm matters less
 const dur=duration||1800;
 if(dur>40*60){base.error*=1.12;base.farm*=.88;base.fight*=1.06;}
 else if(dur<25*60){base.farm*=1.18;base.error*=.92;}
 // Normalize so sum = 1
 const sum=Object.values(base).reduce((a,b)=>a+b,0);
 for(const k in base)base[k]/=sum;
 return base;
}

async function analyze(m){
 if(!m||!Array.isArray(m.players))throw Error("В ответе OpenDota нет данных игроков");
 const players=m.players.map((p,i)=>({...p,idx:i,team:p.player_slot<128?"Radiant":"Dire"}));
 const losing=m.radiant_win?"Dire":"Radiant";
 const team=players.filter(p=>p.team===losing), win=players.filter(p=>p.team!==losing);
 const teamKills=team.reduce((a,p)=>a+(p.kills||0),0), teamDamage=team.reduce((a,p)=>a+(p.hero_damage||0),0)||1;
 const duration=m.duration||1;
 const enriched=team.map(p=>({...p,roleInfo:inferRole(p,team,duration)}));
 let scored=enriched.map(p=>scorePlayer(p,{team:enriched,win,m,teamKills,teamDamage,duration}));
 // Team context: if whole team was stomped (low avg networth), reduce all blame
 const teamAvgNW=team.reduce((a,p)=>a+(p.net_worth||0),0)/Math.max(1,team.length);
 if(teamAvgNW<12000){
  for(const p of scored){
   p.score=Math.round(p.score*.85);
   p.reasons.unshift([`Командное поражение`,`Средний networth ${fmt(teamAvgNW)} — вся команда подавлена, blame снижен`]);
  }
 }
 // Rich-but-useless bonus: player 40%+ richer than teammates with low impact
 for(const p of scored){
  const role = p.role || '';
  const expectedDamageForRole = {"Pos 1 · Carry":.23,"Pos 2 · Mid":.22,"Pos 3 · Offlane":.18,"Pos 4 · Soft Support":.11,"Pos 5 · Hard Support":.09}[role]||.17;
  const teamSortedNW = team.map(x=>x.net_worth||0).sort((a,b)=>b-a);
  const isTop2NW = (p.net_worth||0) >= teamSortedNW[1];
  if(isTop2NW && (p.kp||0)<45 && (p.dmgShare||0)<expectedDamageForRole*70){
   p.score=Math.min(100,p.score+12);
   p.reasons.push([`Ресурсы не конвертированы в результат`,`Top-2 networth в команде, но низкий KP (${(p.kp||0).toFixed(0)}%) и DMG share (${(p.dmgShare||0).toFixed(1)}%)`]);
  }
 }
 scored.sort((a,b)=>b.score-a.score);
 const culprit=scored[0];
  const closeRuiner=scored[1]||null;
 if(culprit?.account_id){
   try{
     const rr=await fetch(`${API}/players/${culprit.account_id}`);
     if(rr.ok){
       const pp=await rr.json();
       culprit.rank_tier=culprit.rank_tier||pp.rank_tier;
       culprit.avatar=culprit.avatar||pp.profile?.avatarfull;
     }
   }catch(e){}
 }
 render(m,players,scored,culprit,closeRuiner);
 LAST_MATCH=m; LAST_ALL=players;
}

function scorePlayer(p,c){
 const deaths=p.deaths||0,kills=p.kills||0,assists=p.assists||0;
 const kp=c.teamKills?100*(kills+assists)/c.teamKills:0, dmgShare=100*(p.hero_damage||0)/c.teamDamage;
 const farm=p.gold_per_min||0, duration=c.duration||1, role=p.roleInfo?.role||'Unknown', w=roleWeights(role,duration);
 const fights=(c.m.teamfights||[]).filter(f=>f.players&&f.players[p.player_slot]);
 let fightEvents=0, lowFightEvents=0;
 for(const f of fights){const x=f.players[p.player_slot]; if((x.kills+x.assists+x.deaths)>0)fightEvents++; if(x.deaths>0&&x.damage<500)lowFightEvents++;}
 // Role-aware expectations: supports are not judged by core farm, cores are not rescued by high KDA alone.
 const expectedGpm={"Pos 1 · Carry":520,"Pos 2 · Mid":480,"Pos 3 · Offlane":420,"Pos 4 · Soft Support":330,"Pos 5 · Hard Support":270}[role]||400;
 const expectedDamage={"Pos 1 · Carry":.23,"Pos 2 · Mid":.22,"Pos 3 · Offlane":.18,"Pos 4 · Soft Support":.11,"Pos 5 · Hard Support":.09}[role]||.17;
 const expectedKP={"Pos 1 · Carry":58,"Pos 2 · Mid":62,"Pos 3 · Offlane":62,"Pos 4 · Soft Support":66,"Pos 5 · Hard Support":68}[role]||60;
 const farmGap=clamp((expectedGpm-farm)/8,0,18);
 const damageGap=clamp((expectedDamage*100-dmgShare)*.65,0,15);
 const kpGap=clamp((expectedKP-kp)*.20,0,12);
 const fightPenalty=damageGap+kpGap+Math.min(6,lowFightEvents*1.5);
 const lateFactor=duration>45*60?1.7:duration>35*60?1.4:duration>25*60?1.15:.85;
 let errorPenalty=Math.min(22,deaths*1.75*lateFactor);
 // Tactical feeder reduction: high deaths but tried to fight
 if(deaths>=10 && kp>65 && dmgShare>expectedDamage*80){
  errorPenalty=Math.round(errorPenalty*0.7); // reduce by 30%
 }
 if(duration>35*60 && deaths>=2 && !(p.buyback_log||[]).length) errorPenalty+=3;
 const objectiveTarget={"Pos 1 · Carry":1100,"Pos 2 · Mid":900,"Pos 3 · Offlane":1200,"Pos 4 · Soft Support":700,"Pos 5 · Hard Support":500}[role]||900;
 const objectivePenalty=clamp((objectiveTarget-(p.tower_damage||0))/110,0,11);
 
 // Enhanced utility calculation for supports
 const visionScore = 
   (p.obs_placed||0) * 1.2 +                    // observer wards
   (p.sen_placed||0) * 0.8 +                    // sentry wards
   (p.observer_kills||0) * 2.5 +                // dewarding obs (more valuable than placing)
   (p.sentry_kills||0) * 1.5;                   // dewarding sentries
 
 const supportScore = 
   ((p.hero_healing||0) / 500) +                // healing
   (p.camps_stacked||0) * 1.0 +                 // camp stacks
   (p.rune_pickups||0) * 0.3 +                  // rune control
   ((p.stuns||0) / duration * 60);              // stuns per minute
 
 const smokeScore = (c.m.objectives||[]).filter(o =>
   (o.type === 'smoke_of_deceit' || o.type === 'CHAT_MESSAGE_SMOKE') &&
   (o.player_slot === p.player_slot || o.slot === p.player_slot || o.key === p.player_slot)
 ).length * 2.0;

 // Fallback: smoke purchases from purchase_log
 const smokeBought = (p.purchase_log||[]).filter(x=>x.key==='smoke_of_deceit'&&x.time>=0).length;
 const smokeBonus = smokeBought * 1.5;
 const smokeTotal = smokeScore + smokeBonus;
 
 const roshanFights = (c.m.teamfights||[]).filter(f => {
   const roshanTimes = (c.m.objectives||[]).filter(o => 
     String(o.type).toLowerCase().includes('roshan')
   ).map(o => o.time||0);
   return roshanTimes.some(t => (f.start||0) >= t - 120 && (f.start||0) <= t) &&
          f.players && f.players[p.player_slot] && 
          (f.players[p.player_slot].damage||0) > 0;
 }).length;
 const roshanContribution = roshanFights * 3.0;
 
 // Unparsed matches have no ward/stun data (m.version is null) - don't punish
 const isParsed=!!c.m.version;
 // For unparsed: heuristic support credit if low GPM (likely buying wards)
 const unparsedSupport = (!isParsed && (role.includes('Pos 4')||role.includes('Pos 5')) && farm<350) ? 12 : 7.5;
 const utility = isParsed ? visionScore + supportScore + smokeTotal + roshanContribution : unparsedSupport;
 const utilityCredit = Math.min(25, utility);  // raised cap from 10 to 25
 
 // Impact efficiency: replace flat resourceWaste with scaled efficiency check
 const impactScore = 
   (p.hero_damage / 1000) * 1.0 +
   (p.tower_damage / 500) * 0.8 +
   (kills * 300) +
   (assists * 150);
 const resources = p.net_worth || 1;
 const efficiency = impactScore / resources;
 
 // Expected efficiency by role (impact per 1k networth)
 const expectedEfficiency = {"Pos 1 · Carry":0.12,"Pos 2 · Mid":0.15,"Pos 3 · Offlane":0.14,"Pos 4 · Soft Support":0.18,"Pos 5 · Hard Support":0.20}[role]||0.15;
 
 // Split-push detection: high tower damage, low hero damage = valid strategy
 const isSplitPusher = (p.tower_damage||0) > 2000 && dmgShare < 12;
 
 // Efficiency penalty only if <70% of expected AND not a split-pusher
 const efficiencyPenalty = (!isSplitPusher && efficiency < expectedEfficiency * 0.7) ? 5 : 0;

 // --- Parsed-match signals (only available after parse, m.version set) ---
 let lanePenalty = 0, tfPenalty = 0, bmPenalty = 0, feedPenalty = 0, roamPenalty = 0;
 let deadPenalty = 0, goldLossPenalty = 0, bbPenalty = 0, towerPenalty = 0, denyPenalty = 0, neutPenalty = 0, fbBonus = 0;
 let zeroImpactPenalty = 0, veryLowKpPenalty = 0;
 let laneTxt = '', tfTxt = '', bmTxt = '', feedTxt = '', deadTxt = '', goldLossTxt = '';
 if(isParsed){
  // 1. Lane efficiency: % of max possible gold in first 10 min
  const le = p.lane_efficiency || 0;
  if(le > 0 && le < 0.45 && (role.includes('Pos 1')||role.includes('Pos 2')||role.includes('Pos 3'))){
   lanePenalty = 4; laneTxt = `Lane efficiency ${(le*100).toFixed(0)}% — проиграл линию`;
  }
  // 2. Teamfight participation: skipped fights
  const tfp = p.teamfight_participation;
  if(tfp !== undefined && tfp !== null && tfp < 0.4 && (c.m.teamfights||[]).length >= 4){
   tfPenalty = 4; tfTxt = `Участие в тимфайтах ${(tfp*100).toFixed(0)}% при ${c.m.teamfights.length} драках — пропускал файты`;
  }
  // 3. Benchmarks: percentile vs same MMR bracket
  const bm = p.benchmarks || {};
  let lowBm = 0;
  for(const k of ['gold_per_min','xp_per_min','hero_damage_per_min','kills_per_min']){
   if(bm[k] && bm[k].pct !== undefined && bm[k].pct < 0.25) lowBm++;
  }
  if(lowBm >= 2){ bmPenalty = 3; bmTxt = `${lowBm} показателей в нижних 25% среди того же MMR (gold/xp/damage/kills)`; }
  // 4. Feeding one hero: >40% deaths from same killer
  const kb = p.killed_by || {};
  const topKiller = Object.entries(kb).sort((a,b)=>b[1]-a[1])[0];
  if(topKiller && deaths >= 5 && topKiller[1] / deaths > 0.4){
   const hn = topKiller[0].replace('npc_dota_hero_','');
   feedPenalty = 3; feedTxt = `${topKiller[1]} из ${deaths} смертей от ${hn} — фидил одного героя`;
  }
  // 5. Roaming without impact (supports with low wards + low KP)
  if((role.includes('Pos 4')||role.includes('Pos 5')) && p.is_roaming && kp < 50 && (p.obs_placed||0) < 5){
   roamPenalty = 2;
  }
  // 6. Dead time: % of match spent dead (life_state_dead / duration)
  const deadFrac = (p.life_state_dead||0) / Math.max(1,duration);
  if(deadFrac > 0.15 && deaths >= 5){ deadPenalty = 3; deadTxt = `${(deadFrac*100).toFixed(0)}% матча мертв (${time(p.life_state_dead||0)})`; }
  else if(deadFrac > 0.10 && deaths >= 5){ deadPenalty = 1; deadTxt = `${(deadFrac*100).toFixed(0)}% матча мертв`; }
  // 7. Gold lost to deaths (gold_reasons['1']) relative to networth
  const deathGold = Math.abs(Number((p.gold_reasons||{})['1']||0));
  if(deathGold > 2000 && deathGold > (p.net_worth||0)*0.12){
   goldLossPenalty = 2; goldLossTxt = `Потерял ${fmt(deathGold)} золота на смертях`;
  }
  // 8. Buyback discipline: late game deaths without buyback available/used
  if(duration > 35*60 && deaths >= 3 && !(p.buyback_log||[]).length && (p.buyback_count||0) === 0){
   bbPenalty = 2;
  }
  // 9. Tower kills contribution for cores (0 towers as pos 1/2/3 in 40+ min game)
  if(duration > 35*60 && (role.includes('Pos 1')||role.includes('Pos 2')||role.includes('Pos 3')) && (p.tower_kills||0) === 0 && (p.towers_killed||0) === 0){
   towerPenalty = 2;
  }
  // 10. Roshan participation handled in utility via roshanContribution; no penalty here
  // 11. Denies for mids/cores (lane dominance)
  if((role.includes('Pos 1')||role.includes('Pos 2')) && duration > 20*60 && (p.denies||0) < 3){
   denyPenalty = 1;
  }
  // 12. Neutral farm for farming cores (pos 1 with <30 neutrals in 35+ min = inefficient jungle use)
  if(role.includes('Pos 1') && duration > 35*60 && (p.neutral_kills||0) < 30){
   neutPenalty = 1;
  }
  // 13. First blood: small credit
  if(p.firstblood_claimed) fbBonus = -1;
 }
 // Zero impact penalty (0 kills AND low participation) - applies to all matches
 if(kills === 0 && !role.includes('Pos 5')){
  if(kp < 50 || dmgShare < 12){
   zeroImpactPenalty = 8;
  }
 }
 // Very low KP penalty (below 35%) - applies to all matches
 if(kp < 35 && kp > 0){
  veryLowKpPenalty = 5;
 }
 // Adjusted utility scaling: now 0-25 range, threshold raised to 15 for full credit
  const utilityNormalized = Math.max(0, (15 - utilityCredit) / 15);
  const raw=100*(w.farm*(farmGap/18)+w.fight*(fightPenalty/33)+w.error*(errorPenalty/22)+w.obj*(objectivePenalty/11)+w.utility*utilityNormalized);
  const parsedBonus=lanePenalty+tfPenalty+bmPenalty+feedPenalty+roamPenalty+deadPenalty+goldLossPenalty+bbPenalty+towerPenalty+denyPenalty+neutPenalty+fbBonus;
  const score=clamp(raw+efficiencyPenalty+parsedBonus+zeroImpactPenalty+veryLowKpPenalty,0,100);
 const confidence=clamp(55+(c.m.teamfights?12:0)+(c.m.objectives?8:0)+(p.gold_t?7:0)+(p.xp_t?5:0)+(p.roleInfo?.confidence||0)*.12,45,94);
 const reasons=[];
 if(farmGap>5) reasons.push([`Фарм ниже ожидания для ${role}`,`GPM ${farm}; ориентир модели ≈ ${expectedGpm}.`]);
 if(damageGap>5) reasons.push([`Низкий Fight Impact для ${role}`,`${fmt(p.hero_damage)} hero damage — ${dmgShare.toFixed(1)}% командного урона.`]);
 if(kpGap>5) reasons.push([`Низкое участие в убийствах`,`Kill Participation ${kp.toFixed(0)}%; ориентир модели ≈ ${expectedKP}%.`]);
 if(errorPenalty>7) reasons.push([`Цена смертей слишком высока`,`${deaths} смертей с повышенным весом поздней игры.`]);
 if(efficiencyPenalty>0) reasons.push([`Низкая конверсия ресурсов в результат`,`Efficiency ${(efficiency*100).toFixed(1)}% от ожидаемого для ${role}.`]);
 if(zeroImpactPenalty>0) reasons.push([`Нулевой результат по убийствам`,`0 kills при низком KP или DMG share — игрок не конвертировал время в результат.`]);
 if(veryLowKpPenalty>0) reasons.push([`Крайне низкое участие в игре`,`KP ${kp.toFixed(0)}% — игрок пропускал большинство командных действий.`]);
 if(lanePenalty>0) reasons.push([`Проигранная линия`,laneTxt]);
 if(tfPenalty>0) reasons.push([`Пропускал командные драки`,tfTxt]);
 if(bmPenalty>0) reasons.push([`Ниже уровня своего MMR`,bmTxt]);
 if(feedPenalty>0) reasons.push([`Фидил одного героя`,feedTxt]);
 if(roamPenalty>0) reasons.push([`Роаминг без импакта`,`is_roaming при низком KP и малом числе вардов.`]);
 if(deadPenalty>0) reasons.push([`Много времени мертв`,deadTxt]);
 if(goldLossPenalty>0) reasons.push([`Золото потеряно на смертях`,goldLossTxt]);
 if(bbPenalty>0) reasons.push([`Нет байбека в лейте`,`Смерти в лейте без выкупа.`]);
 if(towerPenalty>0) reasons.push([`Не сносил вышки`,`0 снесенных вышек у кора в долгой игре.`]);
 if(denyPenalty>0) reasons.push([`Мало денаев`,`Слабый контроль линии для ${role}.`]);
 if(neutPenalty>0) reasons.push([`Не фармил лес`,`Мало нейтралов для керри в долгой игре.`]);
 if(fbBonus<0) reasons.push([`Первая кровь`,`Взял FB — небольшой плюс.`]);
 if(objectivePenalty>5) reasons.push([`Слабое давление на объекты`,`${fmt(p.tower_damage)} урона по строениям для ${role}.`]);
 // Enhanced utility feedback
 if(utilityCredit>=15) reasons.push([`Отличный вклад поддержки`,`Vision score ${visionScore.toFixed(1)}, поддержка команды снижает blame.`]);
 else if(utilityCredit>=8 && (role.includes('Pos 4')||role.includes('Pos 5'))) reasons.push([`Приемлемая поддержка`,`Вижен и utility на уровне, но есть потенциал для улучшения.`]);
 else if(utilityCredit<5 && (role.includes('Pos 4')||role.includes('Pos 5'))) reasons.push([`Слабый utility вклад`,`Vision score ${visionScore.toFixed(1)} — мало вардов, девардов или стаков.`]);
 if(!reasons.length) reasons.push([`Нет одного доминирующего провала`,`Score собран из нескольких сигналов с учётом предполагаемой роли.`]);
 return {...p,score:Math.round(score),confidence:Math.round(confidence),reasons,kp,dmgShare,role,roleConfidence:p.roleInfo?.confidence||0};
}

function render(m,all,players,culprit,closeRuiner){
 $("result").classList.remove("hidden");
 $("culpritHero").src=heroImg(culprit); $("culpritRank").src=rankImg(culprit.rank_tier); $("culpritRankText").textContent=rankName(culprit.rank_tier);
 $("culpritName").textContent=culprit.personaname||`Игрок ${culprit.idx+1}`;
 $("culpritScore").textContent=impactLabel(culprit.score); $("culpritScore").className=`impactValue ${impactClass(culprit.score)}`; $("confidence").textContent=`Уверенность модели: ${culprit.confidence}%`;
 $("summary").innerHTML=verdictText(m,culprit,closeRuiner);
 $("nearRuiner").innerHTML=closeRuiner?nearRuinerHtml(closeRuiner):'<div class="nearEmpty">Второй игрок не набрал достаточно сигналов для отдельного сравнения.</div>';
 $("matchOverview").innerHTML=overview(m,all);
 const winningTeam=m.radiant_win?"Radiant":"Dire";
 const winningPlayers=all.filter(p=>p.team===winningTeam).map(p=>({...p,roleInfo:inferRole(p,all.filter(x=>x.team===winningTeam),m.duration||1)}));
 $("winnerTeamName").textContent=`${winningTeam} · ${m.radiant_win?fmt(m.radiant_score):fmt(m.dire_score)} : ${m.radiant_win?fmt(m.dire_score):fmt(m.radiant_score)}`;
 $("winnerTeam").innerHTML=winningPlayers.map(p=>winnerPlayerCard(p)).join("");
 $("players").innerHTML=players.map((p)=>playerCard(p,p===culprit)).join("");
 $("teamReport").innerHTML=teamReportHtml(players);
 $("ecoChart").innerHTML=ecoChartHtml(m,all);
 $("fightList").innerHTML=fightListHtml(m,all,players);
 $("itemTimings").innerHTML=itemTimingsHtml(m,all,players);
 $("visionMap").innerHTML=visionHtml(m,all,players);
 $("draftInfo").innerHTML=draftHtml(m,all);
 $("smokeInfo").innerHTML=smokeHtml(m,all,players);
 $("matchStory").innerHTML=matchStory(m,all,players,culprit);
 const events=buildEvents(m,culprit); $("events").innerHTML=events.length?events.map(e=>`<div class="event ${e.danger?'danger':''}"><div class="eventTop"><span class="eventTime">${e.t}</span><span class="eventTag ${e.danger?'bad':''}">${e.danger?'НЕГАТИВНЫЙ СИГНАЛ':'ПОЛОЖИТЕЛЬНЫЙ СИГНАЛ'}</span></div><div class="eventPlayer"><img src="${e.player?.img||''}" alt="" onerror="this.style.visibility='hidden'"><div><strong>${esc(e.player?.name||'Игрок')}</strong><span>${esc(e.player?.hero||'Герой')}</span></div></div><b>${esc(e.title)}</b><div class="eventWhat"><strong>Что произошло:</strong> ${esc(e.text)}</div><div class="eventWhy"><strong>Почему это важно:</strong> ${esc(e.why)}</div></div>`).join(""):`<div class="empty">Для этого матча parsed event data недостаточно.</div>`;
 $("reasons").innerHTML=culprit.reasons.map(r=>`<div class="reason"><strong>+ ${esc(r[0])}</strong><span>${esc(r[1])}</span></div>`).join("");
}
function adviceFor(title, p){
 const role=p.role||'';
 const T=title||'';
 if(T.includes('Фарм ниже')) return role.includes('Pos 2')?'Добивай пачки скиллами, не уходи с мида без руны или ганга с смоком.':'Добивай крипов, не уходи с линии без ТП, после проигранной линии фарми лес со стаками.';
 if(T.includes('Fight Impact')) return 'Приходи на драки вместе с командой, держи позицию за инициатором, жми все кнопки в один фокус.';
 if(T.includes('участие в убийствах')||T.includes('Пропускал')) return 'После 15-й минуты играй ближе к команде, всегда держи ТП, прилетай на первую же драку.';
 if(T.includes('Цена смертей')||T.includes('времени мертв')) return 'Не ходи один без вижена, смотри миникарту перед выходом, купи смок или вард.';
 if(T.includes('Фидил')) return 'Купи защиту именно от него: гост, форс, бкб или лотус. Не стой в его ренже без команды рядом.';
 if(T.includes('Золото потеряно')) return 'Не дерись в лейте без денег на байбек, отдай вышку вместо смерти.';
 if(T.includes('байбека')) return 'После 35-й минуты всегда держи золото на выкуп, не трать все в ноль.';
 if(T.includes('вышки')||T.includes('давление на объекты')) return 'После выигранной драки иди в пуш с командой, а не в лес. Бей здания, пока враг мертв.';
 if(T.includes('Проигранная линия')) return 'Смотри реплей первых 10 минут: харасс, денаи, контроль пачки, пуллы у саппортов.';
 if(T.includes('Ниже уровня')) return 'Подтяни базу: ластхит, позиционка в драке, тайминги предметов для своего MMR.';
 if(T.includes('utility')||T.includes('Роаминг')) return 'Ставь варды на точках, девардь смоками и сентрями, бери смок под ганг.';
 if(T.includes('денаев')) return 'Денай крипов, не отдавай врагу халявный фарм, держи линию у своей вышки.';
 if(T.includes('лес')) return 'Стакай лес саппортами и забирай стаки с АОЕ, не бегай по пустой карте.';
 if(T.includes('конверсия')) return 'С деньгами надо драться и пушить, а не фармить дальше. Купи слот под драку и иди к команде.';
 if(/Pos 1/.test(role)) return 'После ключевого предмета ищи окно для драки или объекта, а не продолжай фарм автоматически.';
 if(/Pos 2/.test(role)) return 'Превращай преимущество в драки и объекты, а не в дополнительный фарм.';
 if(/Pos 3/.test(role)) return 'Инициируй игру вокруг команды и объектов, не отдавай темп пассивным фармом.';
 return 'Ищи активное влияние на карту: драки, объекты, вижен и помощь core в правильный момент.';
}
function isPositiveReason(t){
 return /Отличный вклад|Приемлемая поддержка|Первая кровь|Положительный вклад|участвовал в драках|Смерти не были/.test(t||'');
}
function playerReportCard(p,i){
 const kd=`${p.kills||0}/${p.deaths||0}/${p.assists||0}`;
 const bad=p.reasons.filter(r=>!isPositiveReason(r[0]));
 const good=p.reasons.filter(r=>isPositiveReason(r[0]));
 const cls=p.score>=55?'very-high':p.score>=35?'high':p.score>=20?'moderate':'low';
 const medal=['🥇','🥈','🥉','4.','5.'][i]||`${i+1}.`;
 const mistakes=bad.length?bad.map(r=>`<li><b>${esc(r[0])}</b><span>${esc(r[1])}</span><em>→ ${esc(adviceFor(r[0],p))}</em></li>`).join(''):'<li class="ok"><b>Явных провалов нет</b><span>Ошибки распределены равномерно, матч проигран как команда.</span></li>';
 const positives=good.length?`<div class="repGood"><h4>Что было хорошо</h4><ul>${good.map(r=>`<li><b>${esc(r[0])}</b><span>${esc(r[1])}</span></li>`).join('')}</ul></div>`:'';
 return `<div class="repCard ${cls}"><div class="repHead"><span class="repRank">${medal}</span><img class="heroIcon" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div class="repTitle"><b>${esc(p.personaname||'Unknown')}</b><span>${esc(heroName(p))} · ${esc(p.role||'')}</span></div><div class="repScore"><div class="scoreBar"><i style="width:${p.score}%"></i></div><strong>${p.score}</strong><small>KDA ${kd} · GPM ${fmt(p.gold_per_min)} · KP ${(p.kp||0).toFixed(0)}%</small></div></div><div class="repBody"><div class="repBad"><h4>Ошибки</h4><ul>${mistakes}</ul></div>${positives}</div></div>`;
}
function metricLine(label,value,detail){return `<div class="vmetric"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></div>`;}
function teamReportHtml(players){
 return players.map((p,i)=>playerReportCard(p,i)).join('');
}
/* --- ECO CHART: gold/xp advantage over time, SVG --- */
function ecoChartHtml(m,all){
 const gold=m.radiant_gold_adv||[], xp=m.radiant_xp_adv||[];
 if(!gold.length) return '<div class="empty">Нет данных экономики. Допарси матч для графика.</div>';
 const loseTeam=m.radiant_win?'Dire':'Radiant';
 const W=560,H=200,P=30;
 const n=gold.length;
 const allV=gold.concat(xp.length?xp:[0]);
 const mx=Math.max(1000,...allV.map(Math.abs));
 const X=i=>P+(W-2*P)*i/Math.max(1,n-1);
 const Y=v=>H/2+14-(H/2-P*0.6)*v/mx;
 const line=(arr,color,fill)=>`<polygon fill="${color}" opacity="0.12" points="${P},${(H/2+14).toFixed(1)} ${arr.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ')} ${W-P},${(H/2+14).toFixed(1)}"/><polyline fill="none" stroke="${color}" stroke-width="2.5" points="${arr.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ')}"/>`;
 const marks=(m.teamfights||[]).map((f,fi)=>{
  const x=X((f.start||0)/60);
  return `<line x1="${x.toFixed(1)}" y1="24" x2="${x.toFixed(1)}" y2="${H-20}" stroke="#ff4545" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"/><text x="${x.toFixed(1)}" y="${H-6}" font-size="9" fill="#ff8a8a" text-anchor="middle">⚔${fi+1}</text>`;
 }).join('');
 const peak=Math.max(...gold), trough=Math.min(...gold), last=gold[n-1];
 const zone=`<text x="${W/2}" y="16" font-size="10" fill="#78d39a" text-anchor="middle">▲ выше нуля — ведет Radiant (${m.radiant_win?'победили':'проиграли'})</text><text x="${W/2}" y="${H-32}" font-size="10" fill="#ff8a8a" text-anchor="middle">▼ ниже нуля — ведет Dire (${!m.radiant_win?'победили':'проиграли'})</text>`;
 const verdict=m.throw?`Залили преимущество ${fmt(m.loss)} золота (throw ${m.throw}).`
  :(peak>5000&&last<peak*0.3)?`Radiant вели +${fmt(peak)}, к концу осталось ${fmt(last)} — камбэк Dire.`
  :(trough<-5000&&last>trough*0.3)?`Dire вели ${fmt(trough)}, к концу ${fmt(last)} — камбэк Radiant.`
  :`Без резкого камбэка. Финальная разница: ${fmt(last)} (${last>=0?'за Radiant':'за Dire'}).`;
 return `<div class="ecoWrap"><div class="ecoLegend"><span><i class="dot" style="background:#4b91f7"></i>Золото — разница Radiant минус Dire</span><span><i class="dot" style="background:#8a8e98"></i>Опыт — та же разница</span><span>⚔ — драки ниже</span></div><svg viewBox="0 0 ${W} ${H}" class="ecoSvg"><line x1="${P}" y1="${H/2+14}" x2="${W-P}" y2="${H/2+14}" stroke="#3a3f47" stroke-width="1"/>${line(gold,'#4b91f7')}${xp.length?line(xp,'#8a8e98'):''}${marks}${zone}<text x="${W-P}" y="30" font-size="9" fill="#8a8e98" text-anchor="end">пик ${fmt(peak)} / яма ${fmt(trough)}</text></svg><div class="ecoVerdict">${esc(verdict)}</div></div>`;
}
function impactLabel(score){ if(score>=75)return "Очень высокое"; if(score>=55)return "Высокое"; if(score>=35)return "Умеренное"; if(score>=20)return "Небольшое"; return "Низкое"; }
/* --- FIGHTS: per-teamfight breakdown --- */
function fightListHtml(m,all,losers){
 const tfs=m.teamfights||[];
 if(!tfs.length) return '<div class="empty">Нет данных о драках. Допарси матч.</div>';
 const loseTeam=m.radiant_win?'Dire':'Radiant';
 const slot2p={}; for(const p of all) slot2p[p.player_slot]=p;
 const order=[...all].sort((a,b)=>a.player_slot-b.player_slot);
 const intro='<div class="tfIntro">Каждая драка: сколько урона нанес игрок (число), ☠ — умер, ⚔ — убил, ББ — выкупился. Красная рамка — умер почти без урона (меньше 300). Строки проигравших подсвечены.</div>';
 return intro+tfs.map((f,fi)=>{
  // team totals for context
  let lDmg=0,wDmg=0,lDeaths=0,wDeaths=0;
  order.forEach((p,i)=>{
   const x=(f.players||[])[i]||{};
   if(p.team===loseTeam){lDmg+=x.damage||0;lDeaths+=x.deaths||0;}else{wDmg+=x.damage||0;wDeaths+=x.deaths||0;}
  });
  const rows=order.map((p,i)=>{
   const x=(f.players||[])[i]||{};
   const dmg=x.damage||0, d=x.deaths||0, k=Object.keys(x.killed||{}).length;
   const isLoser=p.team===loseTeam;
   const zeroF=d>0&&dmg<300;
   return `<div class="tfRow ${isLoser?'loser':''} ${zeroF?'zerof':''}"><span>${esc(slot2p[p.player_slot]?.personaname||'?')}</span><span>${esc(heroName(p))}</span><b>${fmt(dmg)} урона</b><span>${d?d+'☠ умер':''}${k?' '+k+'⚔ убил':''}${x.buybacks?' ББ':''}${!d&&!k&&dmg<300?' — мимо':''}</span></div>`;
  }).join('');
  return `<div class="tfCard"><div class="tfHead"><b>Драка ${fi+1} · ${time(f.start||0)}–${time(f.end||0)}</b><span>проигравшие: ${fmt(lDmg)} урона, ${lDeaths} смертей · победители: ${fmt(wDmg)} урона, ${wDeaths} смертей</span></div><div class="tfRows">${rows}</div></div>`;
 }).join('');
}
function impactClass(score){ if(score>=75)return "very-high"; if(score>=55)return "high"; if(score>=35)return "moderate"; if(score>=20)return "low"; return "minimal"; }
/* --- ITEMS: key timings, late BKB, detection --- */
function itemTimingsHtml(m,all,losers){
 if(!m.version) return '<div class="empty">Нет данных о предметах. Допарси матч.</div>';
 const KEY={'black_king_bar':'БКБ','gem':'Гем','ward_sentry':'Сентри','ward_observer':'Обс','smoke_of_deceit':'Смок','ghost':'Гост','force_staff':'Форс','lotus_orb':'Лотус','glimmer_cape':'Глиммер','pipe':'Пайпа','crimson_guard':'Кримсон','mekansm':'Мека','guardian_greaves':'Гривы','solar_crest':'Солар','heavens_halberd':'Алебарда','nullifier':'Нуллик','sheepstick':'Хекс','abyssal_blade':'Абиссал','butterfly':'Бабочка','satanic':'Сатаник','aghanims_shard':'Шард','ultimate_scepter':'Аганим','blink':'Блинк','travel_boots':'Травела','aghanims_scepter':'Аганим'};
 const intro='<div class="tfIntro">Время покупки ключевых предметов. БКБ после 25-й — поздно. Нет гемов и сентрей при инвизерах — нечем светить.</div>';
 const rows=[];
 for(const p of losers){
  const pt=p.purchase_time||{};
  const notes=[];
  if(pt.black_king_bar&&pt.black_king_bar>25*60) notes.push(`позднее БКБ ${time(pt.black_king_bar)} — драки до него игрались без защиты`);
  if(pt.gem===undefined&&pt.ward_sentry===undefined&&(p.sen_placed||0)<2) notes.push('нет детекшена — инвизеров нечем светить');
  if(!pt.smoke_of_deceit) notes.push('не покупал смок — не было внезапных гангов');
  const keys=Object.entries(pt).filter(([k,t])=>KEY[k]&&t>0).sort((a,b)=>a[1]-b[1]).slice(0,6).map(([k,t])=>`${KEY[k]} на ${time(t)}`).join(' · ');
  if(keys||notes.length) rows.push(`<div class="itRow"><img class="heroIcon sm" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div><b>${esc(p.personaname||'?')}</b><span>${esc(heroName(p))}</span><small>${esc(keys||'ключевых покупок нет')}</small>${notes.length?`<em>Вывод: ${esc(notes.join('; '))}</em>`:''}</div></div>`);
 }
 return intro+(rows.length?rows.join(''):'<div class="empty">Покупки не найдены.</div>');
}
/* --- VISION: wards/dewards scoreboard --- */
function visionHtml(m,all,losers){
 if(!m.version) return '<div class="empty">Нет данных вижена. Допарси матч.</div>';
 const rows=[...losers].sort((a,b)=>((b.obs_placed||0)+(b.sen_placed||0))-((a.obs_placed||0)+(a.sen_placed||0))).map(p=>
  `<div class="visRow"><img class="heroIcon sm" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div><b>${esc(p.personaname||'?')}</b><span>${esc(heroName(p))}</span></div><div class="visNums"><span title="обсы">👁 ${p.obs_placed||0}</span><span title="сентри">🔹 ${p.sen_placed||0}</span><span title="деварды">💥 ${(p.observer_kills||0)+(p.sentry_kills||0)}</span><span title="стаки">📦 ${p.camps_stacked||0}</span></div></div>`
 ).join('');
 const tot=losers.reduce((a,p)=>a+(p.obs_placed||0)+(p.sen_placed||0),0);
 const dews=losers.reduce((a,p)=>a+(p.observer_kills||0)+(p.sentry_kills||0),0);
 return `<div class="tfIntro">👁 — обсы, 🔹 — сентри, 💥 — снятые вражеские варды, 📦 — стаки. Деварды важнее постановки: снять чужой вижен ценнее, чем поставить свой.</div><div class="visTot">Вардов у проигравших: <b>${tot}</b> · сняли чужих: <b>${dews}</b></div>${rows}`;
}
/* --- DRAFT: picks/bans order --- */
function draftHtml(m,all){
 const pb=m.picks_bans||[];
 if(!pb.length) return '<div class="empty">Нет данных драфта.</div>';
 return `<div class="draftRows">${pb.map((x,i)=>{
  const h=x.hero_id?`<img title="${esc((HEROES[String(x.hero_id)]||{}).localized_name||'')}" src="https://cdn.cloudflare.steamstatic.com${(HEROES[String(x.hero_id)]||{}).img||''}" onerror="this.style.visibility='hidden'">`:'<span class="ban">бан</span>';
  return `<div class="draftCell ${x.is_pick?'pick':'ban'} ${x.team?'dire':'rad'}"><small>${i+1}</small>${h}</div>`;
 }).join('')}</div><div class="draftLegend"><span class="rad">■ Radiant</span> <span class="dire">■ Dire</span></div>`;
}
/* --- SMOKE/RUNES: bought vs kills, rune control --- */
function smokeHtml(m,all,losers){
 if(!m.version) return '<div class="empty">Нет данных. Допарси матч.</div>';
 const rows=losers.map(p=>{
  const bought=(p.purchase_log||[]).filter(x=>x.key==='smoke_of_deceit'&&x.time>=0);
  const kills=(p.kills_log||[]);
  const eff=bought.map(s=>{
   const k=kills.filter(k=>k.time>s.time&&k.time<s.time+90).length;
   return `${time(s.time)}${k?' ⚔x'+k:' · мимо'}`;
  }).join('; ');
  return `<div class="smRow"><img class="heroIcon sm" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div><b>${esc(p.personaname||'?')}</b><span>${esc(heroName(p))}</span><small>Смоки: ${bought.length?esc(eff):'не брал'} · Руны: ${p.rune_pickups||0} · Стаки: ${p.camps_stacked||0} · Курьеры убил: ${p.courier_kills||0}</small></div></div>`;
 }).join('');
 return rows;
}
function verdictText(m,p,r){
 const gap=r?Math.max(0,p.score-r.score):0;
 const lead= r && gap>=8 ? `Он заметно оторвался от следующего игрока по модели: ${gap} баллов.` : r ? `Разрыв с ближайшим по score игроком небольшой — всего ${gap} баллов, поэтому матч нельзя сводить к одной цифре.` : `Для сравнения доступен только основной результат модели.`;
 const deathText=(p.deaths||0)>=4?`${p.deaths} смертей — заметный источник потерь темпа, особенно с учётом длительности ${time(m.duration)}.`:(p.deaths||0)>=2?`${p.deaths} смертей добавили команде цену ошибок, но сами по себе не являются главным доказательством.`:`Смертей немного (${p.deaths||0}), поэтому итог не строится только на KDA.`;
 const farmText=`${fmt(p.gold_per_min)} GPM, ${fmt(p.net_worth)} net worth и ${fmt(p.last_hits)} last hits`;
 const fightText=`${p.kp.toFixed(0)}% KP и ${p.dmgShare.toFixed(1)}% командного hero damage`;
 const objText=`${fmt(p.tower_damage)} урона по строениям`;
 const reasons=p.reasons.slice(0,3).map(x=>`<li><b>${esc(x[0])}</b><span>${esc(x[1])}</span></li>`).join('');
 return `<div class="verdictCopy"><p><strong>${esc(p.personaname||'Этот игрок')}</strong> сыграл наиболее негативную роль в поражении. Модель сравнивает его показатели с ожидаемыми для <strong>его роли в игре</strong>, а затем проверяет, подтверждается ли провал несколькими независимыми сигналами.</p><p>${esc(lead)} Здесь важен контекст: ${esc(deathText)}</p><div class="vmetrics">${metricLine('Экономика',farmText,`ожидания роли учитываются отдельно`)}${metricLine('Влияние в драках',fightText,`урон + участие в убийствах`)}${metricLine('Объекты',objText,`давление на карту и здания`)}${metricLine('Влияние на поражение',impactLabel(p.score),`оценка модели · уверенность ${p.confidence}%`)}</div><div class="verdictReasons"><h3>Что сильнее всего повлияло</h3><ul>${reasons||'<li><b>Сигналы распределены равномерно</b><span>Нет одного показателя, который объясняет поражение целиком.</span></li>'}</ul></div></div>`;
}
function nearRuinerHtml(p){
 const rs=p.reasons.slice(0,3).map(x=>`<li><b>${esc(x[0])}</b><span>${esc(x[1])}</span></li>`).join('');
 return `<div class="nearHead"><img src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div><div class="nearLabel">БЛИЗКИЙ К РУИНУ ИГРОК</div><h3>${esc(p.personaname||'Unknown')}</h3><p>${esc(heroName(p))} · ${esc(p.role)}</p></div><strong>${p.score}</strong></div><div class="nearStats"><span>K/D/A <b>${p.kills||0}/${p.deaths||0}/${p.assists||0}</b></span><span>GPM <b>${fmt(p.gold_per_min)}</b></span><span>KP <b>${p.kp.toFixed(0)}%</b></span><span>Hero DMG <b>${fmt(p.hero_damage)}</b></span></div><ul class="nearReasons">${rs}</ul>`;
}

function teamPhaseStats(m,all,start,end,teamName){
 const team=all.filter(p=>p.team===teamName);
 const kills=team.reduce((a,p)=>a+(p.kills||0),0);
 const net=team.reduce((a,p)=>a+(p.net_worth||0),0);
 const dmg=team.reduce((a,p)=>a+(p.hero_damage||0),0);
 const events=(m.teamfights||[]).filter(f=>Number(f.start||0)>=start&&Number(f.start||0)<end);
 const objectives=(m.objectives||[]).filter(o=>Number(o.time||0)>=start&&Number(o.time||0)<end);
 return {kills,net,dmg,events:events.length,objectives:objectives.length};
}
function matchStory(m,all,players,culprit){
 const dur=m.duration||1, winTeam=m.radiant_win?'Radiant':'Dire', loseTeam=winTeam==='Radiant'?'Dire':'Radiant';
 const phases=[{name:'Лайнинг',start:0,end:Math.min(dur,12*60)},{name:'Мидгейм',start:12*60,end:Math.min(dur,25*60)},{name:'Лейт',start:25*60,end:dur}];
 const rows=phases.filter(x=>x.end>x.start).map(ph=>{
   const l=teamPhaseStats(m,all,ph.start,ph.end,loseTeam), w=teamPhaseStats(m,all,ph.start,ph.end,winTeam);
   const netGap=l.net-w.net, killGap=l.kills-w.kills;
   let tone='neutral', text='Команды были близки по доступным данным.';
   if(netGap<=-1800||killGap<=-3){tone='bad';text=`Соперник получил заметное преимущество: ${netGap<0?`${fmt(Math.abs(netGap))} net worth в пользу врага`:''}${netGap<0&&killGap<0?' и ':''}${killGap<0?`${Math.abs(killGap)} убийств разницы`:''}.`}
   else if(netGap>=1800||killGap>=3){tone='good';text=`У вашей команды был заметный перевес: ${netGap>0?`${fmt(netGap)} net worth`:''}${netGap>0&&killGap>0?' и ':''}${killGap>0?`${killGap} убийств`:''}.`}
   return `<div class="phase ${tone}"><div class="phaseHead"><b>${ph.name}</b><span>${time(ph.start)}–${time(ph.end)}</span></div><p>${text}</p><small>${l.events} teamfight · ${l.objectives} objective · net worth ${netGap>=0?'+':''}${fmt(netGap)}</small></div>`;
 }).join('');
 const turning=findTurningPoint(m,all,culprit,loseTeam,winTeam);
 const lesson=mainLesson(culprit,turning,m);
 const innocence=notTheirFault(culprit,m,all,loseTeam);
 return `<div class="storyGrid"><div class="phases">${rows}</div><div class="turning"><div class="storyLabel">⚡ МОМЕНТ ПЕРЕЛОМА</div><h3>${esc(turning.title)}</h3><div class="turnTime">${turning.t}</div><p>${esc(turning.text)}</p><b>${esc(turning.why)}</b></div><div class="lesson"><div class="storyLabel">🎯 ГЛАВНЫЙ УРОК</div><h3>${esc(lesson.title)}</h3><p>${esc(lesson.text)}</p><div class="nextGame"><span>В следующей игре</span><b>${esc(lesson.action)}</b></div></div><div class="innocence"><div class="storyLabel goodLabel">🟢 ЧТО НЕ БЫЛО ТВОЕЙ ОШИБКОЙ</div><h3>${esc(innocence.title)}</h3><p>${esc(innocence.text)}</p></div></div>`;
}
function findTurningPoint(m,all,p,loseTeam,winTeam){
 const fights=(m.teamfights||[]).map(f=>{
   const lp=all.filter(x=>x.team===loseTeam).reduce((a,x)=>{const z=f.players&&f.players[x.player_slot];return a+(z?(z.kills||0)*120+(z.assists||0)*45-(z.deaths||0)*150+(z.damage||0)*.08:0)},0);
   const wp=all.filter(x=>x.team===winTeam).reduce((a,x)=>{const z=f.players&&f.players[x.player_slot];return a+(z?(z.kills||0)*120+(z.assists||0)*45-(z.deaths||0)*150+(z.damage||0)*.08:0)},0);
   const cp=f.players&&f.players[p.player_slot];
   return {f,score:wp-lp,cp};
 }).sort((a,b)=>b.score-a.score);
 const best=fights.find(x=>x.cp&&(x.cp.deaths||0)>0)||fights[0];
 if(best){
   const x=best.cp||{}; return {t:time(best.f.start||0),title:(x.deaths||0)>0?`${p.personaname||'Игрок'} погиб в важной драке`:'Команда потеряла преимущество в драке',text:`${fmt(x.damage||0)} hero damage, ${x.kills||0} kills, ${x.assists||0} assists и ${x.deaths||0} death.`,why:(x.deaths||0)>0?'После этого эпизода соперник получил наиболее заметный перевес по результату этой драки.':'Это один из самых сильных переломных teamfight-эпизодов в доступных данных.'};
 }
 const late=p.deaths>=2?`${p.personaname||'Игрок'} потерял темп из-за нескольких смертей в поздней игре`:'Преимущество постепенно перешло к сопернику';
 return {t:'—',title:late,text:'В данных OpenDota нет достаточного количества событий, чтобы уверенно привязать перелом к одному моменту.',why:'Поэтому сервис не придумывает конкретную причину.'};
}
function mainLesson(p,turning,m){
 const r=p.reasons[0];
 if(r) return {title:r[0],text:r[1],action: lessonAction(p)};
 return {title:'Не один показатель решал исход',text:'Вклад игрока сформирован несколькими сигналами, поэтому исправлять нужно не одну цифру.',action:'Смотри на связку фарм → драка → объект, а не только на KDA.'};
}
function lessonAction(p){
 const role=p.role||'';
 if(/Pos 1/.test(role)) return 'После ключевого предмета искать окно для драки или объекта, а не продолжать фарм автоматически.';
 if(/Pos 2/.test(role)) return 'После получения преимущества превращать его в драки и объекты, а не только в дополнительный farm.';
 if(/Pos 3/.test(role)) return 'Инициировать игру вокруг своей команды и объектов, а не отдавать темп пассивным фармом.';
 return 'Искать активное влияние на карту: драки, объекты, вижен и помощь core в правильный момент.';
}
function notTheirFault(p,m,all,loseTeam){
 const death=(p.deaths||0), dmg=p.dmgShare||0, kp=p.kp||0;
 if(kp>=55 && dmg>=12) return {title:'Ты реально участвовал в драках',text:`${kp.toFixed(0)}% KP и ${dmg.toFixed(1)}% командного hero damage показывают, что низкий KDA сам по себе не описывает твою игру.`};
 if(death<=2) return {title:'Смерти не были главным источником проблем',text:`У тебя ${death} ${death===1?'смерть':'смертей'}. Итоговый вывод не строится только на количестве смертей.`};
 return {title:'Поражение было командным',text:'Даже при высоком негативном score одного игрока нельзя считать единственной причиной поражения: оценка учитывает его вклад относительно роли и контекста матча.'};
}

function overview(m,all){
 const rad=all.filter(p=>p.team==='Radiant'),dire=all.filter(p=>p.team==='Dire');
 const net=rad.reduce((a,p)=>a+(p.net_worth||0),0)-dire.reduce((a,p)=>a+(p.net_worth||0),0);
 return `<div class="ov"><div><span>Длительность</span><b>${time(m.duration)}</b></div><div><span>Победитель</span><b>${m.radiant_win?'Radiant':'Dire'}</b></div><div><span>Net Worth diff</span><b>${net>=0?'+':''}${fmt(net)}</b></div><div><span>Teamfights</span><b>${(m.teamfights||[]).length}</b></div><div><span>Objectives</span><b>${(m.objectives||[]).length}</b></div><div><span>Roshan</span><b>${(m.objectives||[]).filter(o=>String(o.type).toLowerCase().includes('roshan')).length}</b></div></div>`;
}
function winnerPlayerCard(p){
 const kd=`${p.kills||0}/${p.deaths||0}/${p.assists||0}`;
 const role=p.roleInfo?.role||inferRole(p,[],0).role;
 return `<div class="winnerPlayer"><img class="heroIcon" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div class="winnerPlayerMain"><b>${esc(p.personaname||`Игрок ${p.idx+1}`)}</b><span>${esc(heroName(p))} · ${esc(role)}</span><small>K/D/A ${kd} · GPM ${fmt(p.gold_per_min)} · XPM ${fmt(p.xp_per_min)} · Урон ${fmt(p.hero_damage)}</small></div><strong>${fmt(p.net_worth)} NW</strong></div>`;
}
function playerCard(p,isCulprit){
 const kd=`${p.kills||0}/${p.deaths||0}/${p.assists||0}`, items=itemsOf(p);
 const roleOpts=['Pos 1 · Carry','Pos 2 · Mid','Pos 3 · Offlane','Pos 4 · Soft Support','Pos 5 · Hard Support'].map(r=>`<option value="${r}"${r===p.role?' selected':''}>${r}</option>`).join('');
 return `<div class="playerCard ${isCulprit?'culprit':''}">
  <div class="playerHead"><img class="heroIcon" src="${heroImg(p)}" onerror="this.style.visibility='hidden'"><div><div class="pname">${esc(p.personaname||'Unknown')}</div><div class="heroName">${esc(heroName(p))} · <b>${esc(p.role||"Unknown")}</b> <small>(${p.roleConfidence}%)</small></div><select class="roleOverride" data-slot="${p.player_slot}" onchange="overrideRole(${p.player_slot},this.value)">${roleOpts}</select></div><div class="pScore">${p.score}</div></div>
  <div class="statgrid"><span>K/D/A <b>${kd}</b></span><span>GPM <b>${fmt(p.gold_per_min)}</b></span><span>XPM <b>${fmt(p.xp_per_min)}</b></span><span>Last Hits <b>${fmt(p.last_hits)}</b></span><span>Hero DMG <b>${fmt(p.hero_damage)}</b></span><span>DMG Share <b>${p.dmgShare.toFixed(1)}%</b></span><span>KP <b>${p.kp.toFixed(0)}%</b></span><span>Tower DMG <b>${fmt(p.tower_damage)}</b></span><span>Net Worth <b>${fmt(p.net_worth)}</b></span><span>Healing <b>${fmt(p.hero_healing)}</b></span><span>Wards <b>${fmt((p.obs_placed||0)+(p.sen_placed||0))}</b></span><span>Denies <b>${fmt(p.denies)}</b></span></div>
  <div class="build"><span>Сборка</span>${items.length?items.map(id=>`<img title="${esc(itemName(id))}" src="${itemImg(id)}" onerror="this.style.visibility='hidden'">`).join(''):'<em>нет данных</em>'}</div>
 </div>`;
}
// Manual role override: recalc scores with user-chosen role
let LAST_MATCH=null, LAST_ALL=null;
function overrideRole(slot,role){
 if(!LAST_MATCH||!LAST_ALL)return;
 const losing=LAST_MATCH.radiant_win?"Dire":"Radiant";
 const team=LAST_ALL.filter(p=>p.team===losing);
 const teamKills=team.reduce((a,p)=>a+(p.kills||0),0), teamDamage=team.reduce((a,p)=>a+(p.hero_damage||0),0)||1;
 const duration=LAST_MATCH.duration||1;
 const enriched=team.map(p=>p.player_slot===slot?{...p,roleInfo:{position:Number(role.match(/Pos (\d)/)?.[1]||0),role,confidence:100,source:'manual'}}:{...p,roleInfo:p.roleInfo});
 let scored=enriched.map(p=>scorePlayer(p,{team:enriched,win:LAST_ALL.filter(x=>x.team!==losing),m:LAST_MATCH,teamKills,teamDamage,duration}));
 scored.sort((a,b)=>b.score-a.score);
 const culprit=scored[0], closeRuiner=scored[1]||null;
 render(LAST_MATCH,LAST_ALL,scored,culprit,closeRuiner);
}
function buildEvents(m,p){
 const out=[],slot=p.player_slot;
 const playerLabel=`${p.personaname||'Игрок'} · ${heroName(p)}`;
 const eventPlayer={name:p.personaname||'Игрок',hero:heroName(p),img:heroImg(p)};

 // 1) Реальные teamfight events, если OpenDota их вернул.
 for(const f of (m.teamfights||[])){
   const x=f.players&&f.players[slot]; if(!x)continue;
   const dmg=x.damage||0, k=x.kills||0, a=x.assists||0, d=x.deaths||0;
   if(d>0){
     out.push({t:time(f.start||0),player:eventPlayer,title:`Смерть в командной драке`,text:`${fmt(dmg)} hero damage • ${k} kills • ${a} assists • ${d} death`,danger:dmg<500,why:dmg<500?"Смерть произошла при небольшом личном вкладе в драку.":"Смерть есть, но у игрока был заметный вклад уроном — поэтому эпизод не считается автоматической ошибкой."});
   } else if(dmg>1000 || k+a>=2){
     out.push({t:time(f.start||0),player:eventPlayer,title:`Заметный вклад в teamfight`,text:`${fmt(dmg)} hero damage • ${k} kills • ${a} assists`,danger:false,why:"Игрок конвертировал присутствие в драке в урон или убийства — это положительный сигнал."});
   }
 }

 // 2) Objective events, если они привязаны к player_slot.
 for(const o of (m.objectives||[])){
   if(o.player_slot!==slot||!o.type)continue;
   const type=String(o.type), subtype=o.subtype||"";
   out.push({t:time(o.time||0),player:eventPlayer,title:`Объект: ${type}`,text:subtype||"Событие найдено в данных матча.",danger:false,why:"Участие в objective учитывается как вклад в продвижение команды."});
 }

 const real=out.sort((a,b)=>a.t.localeCompare(b.t)).slice(0,10);
 if(real.length) return real;

 // 3) В некоторых матчах OpenDota не возвращает teamfights/objectives.
 // Не оставляем пользователя с пустым блоком: строим честные derived-сигналы
 // из тех данных, которые точно есть в player stats. Не придумываем время.
 const deaths=p.deaths||0, kp=p.kp||0, dmgShare=p.dmgShare||0, tower=p.tower_damage||0;
 const gpm=p.gold_per_min||0;
 const derived=[];
 if(deaths>=3){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Высокая цена смертей`,text:`${deaths} смертей за матч`,danger:true,why:"Без таймлайна нельзя утверждать, какая именно смерть стала переломной, но количество смертей заметно увеличивает цену ошибок."});
 }
 if(kp<45){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Низкое участие в убийствах`,text:`Kill Participation ${kp.toFixed(0)}%`,danger:true,why:"Игрок редко участвовал в результативных действиях команды; для оценки важно учитывать его роль и ожидания от неё."});
 } else if(kp>=65){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Активное участие в убийствах`,text:`Kill Participation ${kp.toFixed(0)}%`,danger:false,why:"Высокое участие в убийствах снижает вероятность того, что игрок полностью выпал из командной игры."});
 }
 if(dmgShare<10){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Небольшой вклад в hero damage`,text:`${dmgShare.toFixed(1)}% командного hero damage`,danger:true,why:"Доля урона низкая. Это не самостоятельное доказательство ошибки — показатель оценивается вместе с ролью, фармом и участием в игре."});
 } else if(dmgShare>=20){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Высокий вклад в hero damage`,text:`${dmgShare.toFixed(1)}% командного hero damage`,danger:false,why:"Игрок внёс заметную долю командного урона, поэтому его нельзя оценивать только по KDA или смертям."});
 }
 if(tower<500){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Ограниченное давление на объекты`,text:`${fmt(tower)} урона по строениям`,danger:true,why:"Урон по зданиям небольшой. Значимость этого сигнала зависит от роли и от того, насколько команда вообще имела окна для пуша."});
 }
 if(gpm>0 && derived.length<2){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Экономика матча`,text:`${fmt(gpm)} GPM • ${fmt(p.net_worth)} net worth • ${fmt(p.last_hits)} last hits`,danger:false,why:"Экономика используется как контекст: высокий или низкий фарм сам по себе не доказывает руин."});
 }
 if(!derived.length){
   derived.push({t:'По итогам матча',player:eventPlayer,title:`Недостаточно событий для точной временной привязки`,text:`OpenDota не передал подробный teamfight/objective timeline`,danger:false,why:"Сервис показывает только проверяемые сигналы из статистики и не придумывает конкретные минуты или события."});
 }
 return derived.slice(0,5);
}
/* --- PROFILE: last matches by nickname --- */
async function loadProfile(){
 const nick=($("nickInput").value||'').trim(); if(!nick)return;
 const box=$("profileBox");
 try{
  box.innerHTML='Ищем игрока…';
  const s=await fetch(`${API}/search?q=${encodeURIComponent(nick)}`);
  const arr=await s.json();
  if(!arr||!arr.length){box.innerHTML='Игрок не найден.';return;}
  const acc=arr[0];
  const mr=await fetch(`${API}/players/${acc.account_id}/matches?limit=8`);
  const matches=await mr.json();
  if(!matches||!matches.length){box.innerHTML='Матчей нет.';return;}
  let w=0,l=0,k=0,d=0,a=0,gpm=0;
  const rows=matches.map(mm=>{
   const win=(mm.radiant_win&&mm.player_slot<128)||(!mm.radiant_win&&mm.player_slot>=128);
   win?w++:l++;
   k+=mm.kills||0;d+=mm.deaths||0;a+=mm.assists||0;gpm+=mm.gold_per_min||0;
   return `<div class="pmRow ${win?'win':'lose'}" data-mid="${mm.match_id}"><span>${win?'✅':'❌'}</span><b>${mm.match_id}</b><span>${esc((HEROES[String(mm.hero_id)]||{}).localized_name||'#'+mm.hero_id)}</span><span>${mm.kills}/${mm.deaths}/${mm.assists}</span><span>${time(mm.duration||0)}</span></div>`;
  }).join('');
  const n=matches.length;
  box.innerHTML=`<div class="pmHead"><b>${esc(acc.personaname||nick)}</b><span>последние ${n}: ${w}W–${l}L · средний KDA ${(k/n).toFixed(1)}/${(d/n).toFixed(1)}/${(a/n).toFixed(1)} · GPM ${Math.round(gpm/n)}</span>${d/n>7?'<em>Стабильно много смертей — смотри позиционку и карту.</em>':''}${(k+a)/Math.max(1,d/n)<2?'<em>Низкий импакт на киллы — играй ближе к команде.</em>':''}</div>${rows}<div class="hint">Клик по матчу — открыть разбор.</div>`;
  box.querySelectorAll('.pmRow').forEach(r=>r.onclick=()=>{location.hash='match='+r.dataset.mid;$("matchId").value=r.dataset.mid;$("form").dispatchEvent(new Event('submit'));window.scrollTo(0,0);});
 }catch(e){box.innerHTML='Ошибка: '+e.message;}
}
function saveHist(id){
 try{
  let h=JSON.parse(localStorage.getItem('wr_hist')||'[]');
  h=[id,...h.filter(x=>x!==id)].slice(0,8);
  localStorage.setItem('wr_hist',JSON.stringify(h));
  renderHist();
 }catch(e){}
}
function renderHist(){
 const el=$("histRow"); if(!el)return;
 let h=[]; try{h=JSON.parse(localStorage.getItem('wr_hist')||'[]');}catch(e){}
 el.innerHTML=h.length?'Последние: '+h.map(id=>`<button type="button" data-mid="${id}">${id}</button>`).join(''):'';
 el.querySelectorAll('button').forEach(b=>b.onclick=()=>{$("matchId").value=b.dataset.mid;$("form").dispatchEvent(new Event('submit'));});
}
window.addEventListener('DOMContentLoaded',()=>{
 renderHist();
 const nb=$("nickBtn"); if(nb)nb.onclick=loadProfile;
 const hsh=(location.hash||'').match(/match=(\d+)/);
 if(hsh){$("matchId").value=hsh[1];$("form").dispatchEvent(new Event('submit'));}
});
