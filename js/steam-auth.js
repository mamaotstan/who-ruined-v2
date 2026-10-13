// Steam OAuth login
const STEAM_RETURN_URL = window.location.origin + '/';
const OPENDOTA_AUTH = 'https://api.opendota.com/api/auth/steam';

function initSteamAuth() {
  const params = new URLSearchParams(window.location.search);
  const accountId = params.get('account_id');
  
  if (accountId) {
    // User returned from Steam OAuth
    localStorage.setItem('steam_account_id', accountId);
    showLoggedIn(accountId);
    // Clean URL
    window.history.replaceState({}, document.title, '/');
  } else {
    // Check if already logged in
    const savedId = localStorage.getItem('steam_account_id');
    if (savedId) {
      showLoggedIn(savedId);
    }
  }
}

function loginSteam() {
  window.location.href = `${OPENDOTA_AUTH}?return_url=${encodeURIComponent(STEAM_RETURN_URL)}`;
}

function logoutSteam() {
  localStorage.removeItem('steam_account_id');
  location.reload();
}

async function showLoggedIn(accountId) {
  const loginBtn = $("steamLogin");
  const logoutBtn = $("steamLogout");
  const recentBtn = $("steamRecent");
  
  if (!loginBtn || !logoutBtn || !recentBtn) return;
  
  loginBtn.classList.add("hidden");
  logoutBtn.classList.remove("hidden");
  recentBtn.classList.remove("hidden");
  
  try {
    const res = await fetch(`${API}/players/${accountId}`);
    if (res.ok) {
      const player = await res.json();
      const name = player.profile?.personaname || `Player ${accountId}`;
      logoutBtn.textContent = `Выйти (${name})`;
    }
  } catch(e) {}
}

async function loadRecentMatches() {
  const accountId = localStorage.getItem('steam_account_id');
  if (!accountId) {
    alert('Сначала войди через Steam');
    return;
  }
  
  const box = $("profileBox");
  if (!box) return;
  
  try {
    box.innerHTML = 'Загружаем последние матчи…';
    const res = await fetch(`${API}/players/${accountId}/matches?limit=10`);
    if (!res.ok) throw Error('Не удалось загрузить матчи');
    
    const matches = await res.json();
    if (!matches || !matches.length) {
      box.innerHTML = 'Матчей не найдено.';
      return;
    }
    
    let w = 0, l = 0;
    const rows = matches.map(m => {
      const win = (m.radiant_win && m.player_slot < 128) || (!m.radiant_win && m.player_slot >= 128);
      win ? w++ : l++;
      const heroName = (HEROES[String(m.hero_id)] || {}).localized_name || `#${m.hero_id}`;
      return `<div class="pmRow ${win?'win':'lose'}" data-mid="${m.match_id}"><span>${win?'✅':'❌'}</span><b>${m.match_id}</b><span>${esc(heroName)}</span><span>${m.kills}/${m.deaths}/${m.assists}</span><span>${time(m.duration||0)}</span></div>`;
    }).join('');
    
    box.innerHTML = `<div class="pmHead"><b>Последние ${matches.length} матчей</b><span>${w}W–${l}L</span></div>${rows}<div class="hint">Клик по матчу — открыть разбор.</div>`;
    
    box.querySelectorAll('.pmRow').forEach(r => {
      r.onclick = () => {
        location.hash = 'match=' + r.dataset.mid;
        $("matchId").value = r.dataset.mid;
        $("form").dispatchEvent(new Event('submit'));
        window.scrollTo(0, 0);
      };
    });
    
  } catch(e) {
    box.innerHTML = 'Ошибка: ' + e.message;
  }
}

// Add to DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  initSteamAuth();
  
  const loginBtn = $("steamLogin");
  const logoutBtn = $("steamLogout");
  const recentBtn = $("steamRecent");
  
  if (loginBtn) loginBtn.onclick = loginSteam;
  if (logoutBtn) logoutBtn.onclick = logoutSteam;
  if (recentBtn) recentBtn.onclick = loadRecentMatches;
  
  renderHist();
  const nb = $("nickBtn");
  if (nb) nb.onclick = loadProfile;
  const hsh = (location.hash || '').match(/match=(\d+)/);
  if (hsh) {
    $("matchId").value = hsh[1];
    $("form").dispatchEvent(new Event('submit'));
  }
});
