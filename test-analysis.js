// Тест формул на реальных данных
const fetch = require('node:https').get;

const matchIds = ['9040430158', '9039969149'];

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    require('node:https').get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function analyzeMatch(id) {
  console.log(`\n=== ANALYZING MATCH ${id} ===`);
  const m = await fetchJson(`https://api.opendota.com/api/matches/${id}`);
  
  const losing = m.radiant_win ? 'Dire' : 'Radiant';
  const team = m.players.filter(p => (p.player_slot < 128 ? 'Radiant' : 'Dire') === losing);
  
  console.log(`Duration: ${Math.floor(m.duration/60)}:${String(Math.floor(m.duration%60)).padStart(2,'0')}`);
  console.log(`Losing team: ${losing}`);
  console.log(`\nPlayers:`);
  
  team.forEach((p, i) => {
    const kda = `${p.kills}/${p.deaths}/${p.assists}`;
    const lane = p.lane_role || 0;
    const laneStr = {1:'safe', 2:'mid', 3:'off', 4:'jungle'}[lane] || 'unknown';
    console.log(`${i+1}. ${p.personaname || 'Unknown'} - lane:${laneStr} KDA:${kda} GPM:${p.gold_per_min} NW:${p.net_worth} DMG:${p.hero_damage} Tower:${p.tower_damage}`);
  });
  
  // Check role detection
  console.log(`\n--- Role Detection Issues ---`);
  const roles = team.map(p => p.lane_role || 0);
  const midCount = roles.filter(r => r === 2).length;
  const safeCount = roles.filter(r => r === 1).length;
  const offCount = roles.filter(r => r === 3).length;
  
  console.log(`Mid markers: ${midCount} (expect 1)`);
  console.log(`Safe markers: ${safeCount} (expect 2)`);
  console.log(`Off markers: ${offCount} (expect 2)`);
  
  if (midCount !== 1) console.log(`⚠️ Mid detection issue!`);
  if (safeCount < 1) console.log(`⚠️ Safe lane detection issue!`);
  if (offCount < 1) console.log(`⚠️ Offlane detection issue!`);
  
  // Check for potential ruiners
  console.log(`\n--- Potential Issues ---`);
  team.forEach(p => {
    const issues = [];
    if (p.deaths >= 10) issues.push(`MANY DEATHS (${p.deaths})`);
    if (p.gold_per_min < 300) issues.push(`LOW GPM (${p.gold_per_min})`);
    const teamDmg = team.reduce((a,x)=>a+(x.hero_damage||0),0);
    const dmgShare = teamDmg > 0 ? (p.hero_damage/teamDmg*100) : 0;
    if (dmgShare < 8) issues.push(`LOW DMG SHARE (${dmgShare.toFixed(1)}%)`);
    const teamKills = team.reduce((a,x)=>a+(x.kills||0),0);
    const kp = teamKills > 0 ? ((p.kills + p.assists)/teamKills*100) : 0;
    if (kp < 40) issues.push(`LOW KP (${kp.toFixed(0)}%)`);
    if (p.net_worth > 15000 && dmgShare < 12 && kp < 45) issues.push(`RICH BUT USELESS (${p.net_worth} NW, low impact)`);
    
    if (issues.length) {
      console.log(`${p.personaname || 'Unknown'}: ${issues.join(', ')}`);
    }
  });
}

(async () => {
  for (const id of matchIds) {
    try {
      await analyzeMatch(id);
    } catch (e) {
      console.error(`Error analyzing ${id}:`, e.message);
    }
  }
})();
