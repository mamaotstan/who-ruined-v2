// Полная симуляция логики из app.js
const https = require('node:https');

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

function inferRoles(team, duration) {
  const value = x => (x.net_worth || 0) * 0.55 + (x.gold_per_min || 0) * 0.25 + (x.last_hits || 0) * 0.12 + (x.xp_per_min || 0) * 0.08;
  const earlyValue = x => {
    const g10 = (x.gold_t && x.gold_t[10]) || 0;
    const xp10 = (x.xp_t && x.xp_t[10]) || 0;
    return g10 > 0 ? g10 * 0.6 + xp10 * 0.4 : value(x) * 0.7;
  };
  const lane = x => Number(x.lane_role || 0);
  const assigned = new Map();

  const calcConfidence = (hasLane, earlyMatch, finalMatch) => {
    let conf = 40;
    if (hasLane) conf += 30;
    if (earlyMatch) conf += 20;
    if (finalMatch) conf += 15;
    if (hasLane && earlyMatch && finalMatch) conf += 10;
    return Math.min(95, conf);
  };

  // Mid
  const midCandidates = team.filter(x => lane(x) === 2).sort((a, b) => earlyValue(b) - earlyValue(a));
  if (midCandidates.length) {
    const p = midCandidates[0];
    const teamEarlySorted = team.filter(x => lane(x) !== 2).sort((a, b) => earlyValue(b) - earlyValue(a));
    const isEarlyTop3 = earlyValue(p) >= earlyValue(teamEarlySorted[Math.min(2, teamEarlySorted.length - 1)] || {});
    const conf = calcConfidence(true, isEarlyTop3, true);
    assigned.set(p.player_slot, { position: 2, role: 'Pos 2 · Mid', confidence: conf });
  }

  // Safe lane
  const safe = team.filter(x => lane(x) === 1 && !assigned.has(x.player_slot)).sort((a, b) => value(b) - value(a));
  if (safe.length >= 2) {
    const p1 = safe[0], p5 = safe[1];
    assigned.set(p1.player_slot, { position: 1, role: 'Pos 1 · Carry', confidence: 85 });
    assigned.set(p5.player_slot, { position: 5, role: 'Pos 5 · Hard Support', confidence: 85 });
  }

  // Offlane
  const off = team.filter(x => lane(x) === 3 && !assigned.has(x.player_slot)).sort((a, b) => value(b) - value(a));
  if (off.length >= 2) {
    const p3 = off[0], p4 = off[1];
    assigned.set(p3.player_slot, { position: 3, role: 'Pos 3 · Offlane', confidence: 85 });
    assigned.set(p4.player_slot, { position: 4, role: 'Pos 4 · Soft Support', confidence: 85 });
  }

  // Fill missing
  const positions = [1, 2, 3, 4, 5];
  const used = new Set([...assigned.values()].map(x => x.position));
  const missing = positions.filter(x => !used.has(x));
  const remaining = team.filter(p => !assigned.has(p.player_slot)).sort((a, b) => value(b) - value(a));
  for (const pos of missing) {
    const p = remaining.shift();
    if (!p) break;
    const data = { 1: ['Pos 1 · Carry', 50], 2: ['Pos 2 · Mid', 55], 3: ['Pos 3 · Offlane', 50], 4: ['Pos 4 · Soft Support', 48], 5: ['Pos 5 · Hard Support', 48] }[pos];
    assigned.set(p.player_slot, { position: pos, role: data[0], confidence: data[1] });
  }

  return Object.fromEntries(team.map(p => [p.player_slot, assigned.get(p.player_slot) || { position: 5, role: 'Pos 5 · Hard Support', confidence: 40 }]));
}

function roleWeights(role, duration) {
  const pos = Number(String(role || '').match(/Pos (\d)/)?.[1] || 0);
  const base = {
    1: { farm: .26, fight: .23, error: .30, obj: .14, utility: .07 },
    2: { farm: .16, fight: .30, error: .29, obj: .18, utility: .07 },
    3: { farm: .11, fight: .30, error: .25, obj: .23, utility: .11 },
    4: { farm: .06, fight: .30, error: .23, obj: .20, utility: .21 },
    5: { farm: .04, fight: .27, error: .20, obj: .17, utility: .32 }
  }[pos] || { farm: .15, fight: .27, error: .27, obj: .20, utility: .11 };
  
  const dur = duration || 1800;
  if (dur > 40 * 60) { base.error *= 1.15; base.farm *= .85; base.fight *= 1.05; }
  else if (dur < 25 * 60) { base.farm *= 1.2; base.error *= .9; }
  
  const sum = Object.values(base).reduce((a, b) => a + b, 0);
  for (const k in base) base[k] /= sum;
  return base;
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function analyzeMatch(id) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ANALYZING MATCH ${id}`);
  console.log('='.repeat(60));
  
  const m = await fetchJson(`https://api.opendota.com/api/matches/${id}`);
  const losing = m.radiant_win ? 'Dire' : 'Radiant';
  const team = m.players.filter(p => (p.player_slot < 128 ? 'Radiant' : 'Dire') === losing);
  
  const roles = inferRoles(team, m.duration);
  const teamKills = team.reduce((a, p) => a + (p.kills || 0), 0);
  const teamDamage = team.reduce((a, p) => a + (p.hero_damage || 0), 0) || 1;
  
  const enriched = team.map(p => ({ ...p, roleInfo: roles[p.player_slot] }));
  
  const scored = enriched.map(p => {
    const role = p.roleInfo.role;
    const deaths = p.deaths || 0;
    const kp = teamKills ? 100 * ((p.kills || 0) + (p.assists || 0)) / teamKills : 0;
    const dmgShare = 100 * (p.hero_damage || 0) / teamDamage;
    const w = roleWeights(role, m.duration);
    
    const expectedGpm = { "Pos 1 · Carry": 520, "Pos 2 · Mid": 480, "Pos 3 · Offlane": 420, "Pos 4 · Soft Support": 330, "Pos 5 · Hard Support": 270 }[role] || 400;
    const expectedDamage = { "Pos 1 · Carry": .23, "Pos 2 · Mid": .22, "Pos 3 · Offlane": .18, "Pos 4 · Soft Support": .11, "Pos 5 · Hard Support": .09 }[role] || .17;
    const expectedKP = { "Pos 1 · Carry": 58, "Pos 2 · Mid": 62, "Pos 3 · Offlane": 62, "Pos 4 · Soft Support": 66, "Pos 5 · Hard Support": 68 }[role] || 60;
    
    const farmGap = clamp((expectedGpm - (p.gold_per_min || 0)) / 8, 0, 18);
    const damageGap = clamp((expectedDamage * 100 - dmgShare) * .65, 0, 15);
    const kpGap = clamp((expectedKP - kp) * .20, 0, 12);
    
    const lateFactor = m.duration > 45 * 60 ? 1.8 : m.duration > 35 * 60 ? 1.45 : m.duration > 25 * 60 ? 1.15 : .85;
    const errorPenalty = Math.min(24, deaths * 1.9 * lateFactor);
    
    const objectiveTarget = { "Pos 1 · Carry": 1100, "Pos 2 · Mid": 900, "Pos 3 · Offlane": 1200, "Pos 4 · Soft Support": 700, "Pos 5 · Hard Support": 500 }[role] || 900;
    const objectivePenalty = clamp((objectiveTarget - (p.tower_damage || 0)) / 110, 0, 11);
    
    const utilityCredit = 7.5; // simplified for unparsed
    const utilityNormalized = Math.max(0, (15 - utilityCredit) / 15);
    
    const fightPenalty = damageGap + kpGap;
    const raw = 100 * (w.farm * (farmGap / 18) + w.fight * (fightPenalty / 33) + w.error * (errorPenalty / 27) + w.obj * (objectivePenalty / 11) + w.utility * utilityNormalized);
    const score = clamp(raw, 0, 100);
    
    return { ...p, score: Math.round(score), role, kp, dmgShare, farmGap, damageGap, kpGap, errorPenalty, objectivePenalty };
  });
  
  scored.sort((a, b) => b.score - a.score);
  
  console.log(`\nDuration: ${Math.floor(m.duration / 60)}:${String(Math.floor(m.duration % 60)).padStart(2, '0')}`);
  console.log(`Losing team: ${losing}\n`);
  
  console.log('ROLE ASSIGNMENTS:');
  scored.forEach(p => {
    console.log(`  ${p.personaname || 'Unknown'}: ${p.role} (conf ${p.roleInfo.confidence}%)`);
  });
  
  console.log('\nSCORING RESULTS (sorted by blame):');
  scored.forEach((p, i) => {
    console.log(`\n${i + 1}. ${p.personaname || 'Unknown'} - SCORE: ${p.score}`);
    console.log(`   Role: ${p.role}`);
    console.log(`   KDA: ${p.kills}/${p.deaths}/${p.assists} | GPM: ${p.gold_per_min} | NW: ${p.net_worth}`);
    console.log(`   KP: ${p.kp.toFixed(1)}% | DMG Share: ${p.dmgShare.toFixed(1)}%`);
    console.log(`   Penalties: farm=${p.farmGap.toFixed(1)} dmg=${p.damageGap.toFixed(1)} kp=${p.kpGap.toFixed(1)} error=${p.errorPenalty.toFixed(1)} obj=${p.objectivePenalty.toFixed(1)}`);
  });
  
  console.log(`\n>>> RUINER: ${scored[0].personaname || 'Unknown'} (${scored[0].role}) with score ${scored[0].score}`);
}

(async () => {
  for (const id of ['9040430158', '9039969149']) {
    try {
      await analyzeMatch(id);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`Error:`, e.message);
    }
  }
})();
