// Test improved formulas
const https = require('node:https');
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

function inferRoles(team, duration) {
  const value = x => (x.net_worth || 0) * 0.55 + (x.gold_per_min || 0) * 0.25 + (x.last_hits || 0) * 0.12 + (x.xp_per_min || 0) * 0.08;
  const lane = x => Number(x.lane_role || 0);
  const assigned = new Map();
  const midCandidates = team.filter(x => lane(x) === 2);
  if (midCandidates.length) assigned.set(midCandidates[0].player_slot, { position: 2, role: 'Pos 2 · Mid', confidence: 85 });
  const safe = team.filter(x => lane(x) === 1 && !assigned.has(x.player_slot)).sort((a, b) => value(b) - value(a));
  if (safe.length >= 2) {
    assigned.set(safe[0].player_slot, { position: 1, role: 'Pos 1 · Carry', confidence: 85 });
    assigned.set(safe[1].player_slot, { position: 5, role: 'Pos 5 · Hard Support', confidence: 85 });
  }
  const off = team.filter(x => lane(x) === 3 && !assigned.has(x.player_slot)).sort((a, b) => value(b) - value(a));
  if (off.length >= 2) {
    assigned.set(off[0].player_slot, { position: 3, role: 'Pos 3 · Offlane', confidence: 85 });
    assigned.set(off[1].player_slot, { position: 4, role: 'Pos 4 · Soft Support', confidence: 85 });
  }
  return Object.fromEntries(team.map(p => [p.player_slot, assigned.get(p.player_slot) || { position: 5, role: 'Pos 5 · Hard Support', confidence: 40 }]));
}

function roleWeights(role, duration) {
  const pos = Number(String(role || '').match(/Pos (\d)/)?.[1] || 0);
  const base = {
    1: { farm: .26, fight: .25, error: .28 },
    2: { farm: .16, fight: .32, error: .27 },
    3: { farm: .12, fight: .32, error: .22 },
    4: { farm: .06, fight: .32, error: .21 },
    5: { farm: .04, fight: .28, error: .19 }
  }[pos] || { farm: .15, fight: .28, error: .25 };
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
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MATCH ${id} — IMPROVED`);
  console.log('='.repeat(70));
  
  const m = await fetchJson(`https://api.opendota.com/api/matches/${id}`);
  const losing = m.radiant_win ? 'Dire' : 'Radiant';
  const team = m.players.filter(p => (p.player_slot < 128 ? 'Radiant' : 'Dire') === losing);
  const roles = inferRoles(team, m.duration);
  const teamKills = team.reduce((a, p) => a + (p.kills || 0), 0);
  const teamDamage = team.reduce((a, p) => a + (p.hero_damage || 0), 0) || 1;
  
  const scored = team.map(p => {
    const role = roles[p.player_slot].role;
    const deaths = p.deaths || 0, kills = p.kills || 0, farm = p.gold_per_min || 0;
    const kp = teamKills ? 100 * ((p.kills || 0) + (p.assists || 0)) / teamKills : 0;
    const dmgShare = 100 * (p.hero_damage || 0) / teamDamage;
    const w = roleWeights(role, m.duration);
    
    const expectedGpm = { "Pos 1 · Carry": 520, "Pos 2 · Mid": 480, "Pos 3 · Offlane": 420, "Pos 4 · Soft Support": 330, "Pos 5 · Hard Support": 270 }[role] || 400;
    const expectedKP = { "Pos 1 · Carry": 58, "Pos 2 · Mid": 62, "Pos 3 · Offlane": 62, "Pos 4 · Soft Support": 66, "Pos 5 · Hard Support": 68 }[role] || 60;
    const expectedDamage = { "Pos 1 · Carry": .23, "Pos 2 · Mid": .22, "Pos 3 · Offlane": .18, "Pos 4 · Soft Support": .11, "Pos 5 · Hard Support": .09 }[role] || .17;
    
    const farmGap = clamp((expectedGpm - farm) / 8, 0, 18);
    const kpGap = clamp((expectedKP - kp) * .20, 0, 12);
    const damageGap = clamp((expectedDamage * 100 - dmgShare) * .65, 0, 15);
    
    const lateFactor = m.duration > 45 * 60 ? 1.7 : m.duration > 35 * 60 ? 1.4 : 1.15;
    let errorPenalty = Math.min(22, deaths * 1.75 * lateFactor);
    if (deaths >= 10 && kp > 65 && dmgShare > expectedDamage * 80) errorPenalty = Math.round(errorPenalty * 0.7);
    
    let zeroImpactPenalty = 0;
    if (kills === 0 && !role.includes('Pos 5') && (kp < 50 || dmgShare < 12)) zeroImpactPenalty = 8;
    
    let veryLowKpPenalty = 0;
    if (kp < 35 && kp > 0) veryLowKpPenalty = 5;
    
    const fightPenalty = damageGap + kpGap;
    const raw = 100 * (w.farm * (farmGap / 18) + w.fight * (fightPenalty / 33) + w.error * (errorPenalty / 22));
    let score = clamp(raw + zeroImpactPenalty + veryLowKpPenalty, 0, 100);
    
    return { ...p, role, score: Math.round(score), kp, dmgShare, errorPenalty, zeroImpactPenalty, veryLowKpPenalty };
  });
  
  const teamSortedNW = team.map(x => x.net_worth || 0).sort((a, b) => b - a);
  for (const p of scored) {
    const isTop2NW = (p.net_worth || 0) >= teamSortedNW[1];
    const expectedDamage = { "Pos 1 · Carry": .23, "Pos 2 · Mid": .22, "Pos 3 · Offlane": .18 }[p.role] || .17;
    if (isTop2NW && p.kp < 45 && p.dmgShare < expectedDamage * 70) {
      p.score = Math.min(100, p.score + 12);
      p.richButUseless = true;
    }
  }
  
  scored.sort((a, b) => b.score - a.score);
  
  console.log(`Duration: ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}`);
  console.log(`Losing: ${losing}\n`);
  
  scored.forEach((p, i) => {
    const flags = [];
    if (p.zeroImpactPenalty > 0) flags.push('ZERO IMPACT +8');
    if (p.veryLowKpPenalty > 0) flags.push('LOW KP +5');
    if (p.richButUseless) flags.push('RICH USELESS +12');
    if (p.errorPenalty < 15 && p.deaths >= 10) flags.push('TACTICAL -30%');
    
    console.log(`${i + 1}. ${(p.personaname || 'Unknown').substring(0,18).padEnd(18)} ${p.role.padEnd(22)} ${p.score}`);
    console.log(`   ${p.kills}/${p.deaths}/${p.assists} GPM:${p.gold_per_min} KP:${p.kp.toFixed(0)}% DMG:${p.dmgShare.toFixed(1)}%`);
    if (flags.length) console.log(`   >>> ${flags.join(', ')}`);
  });
  
  console.log(`\n>>> RUINER: ${scored[0].personaname} (${scored[0].role}) ${scored[0].score}`);
}

(async () => {
  for (const id of ['9040430158', '9039969149']) {
    try {
      await analyzeMatch(id);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(e.message);
    }
  }
})();
