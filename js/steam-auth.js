// Steam link: static hosting cannot do Steam OpenID (needs a server).
// User pastes SteamID64 / profile URL / nickname, we resolve to account_id via OpenDota API.
async function resolveSteam(input) {
  const s = (input || '').trim();
  if (!s) return null;
  // 1. direct numeric account_id or steam64
  const digits = s.match(/(\d{5,})/);
  if (digits) {
    let id = digits[1];
    // steam64 (17 digits starting with 7656) -> account_id = steam64 - 76561197960265728
    if (id.length >= 16 && id.startsWith('7656')) {
      try { id = String(BigInt(id) - BigInt('76561197960265728')); } catch (e) {}
    }
    // verify via players endpoint
    try {
      const r = await fetch(`${API}/players/${id}`);
      if (r.ok) {
        const p = await r.json();
        if (p && (p.profile || p.mmr_estimate)) return { id, name: p.profile?.personaname || ('Player ' + id) };
      }
    } catch (e) {}
  }
  // 2. nickname search
  try {
    const r = await fetch(`${API}/search?q=${encodeURIComponent(s)}`);
    if (r.ok) {
      const arr = await r.json();
      if (arr && arr.length) return { id: String(arr[0].account_id), name: arr[0].personaname || s };
    }
  } catch (e) {}
  return null;
}

function showSteamState() {
  const out = $("steamLoggedOut"), inn = $("steamLoggedIn");
  if (!out || !inn) return;
  const saved = localStorage.getItem('steam_account_id');
  const savedName = localStorage.getItem('steam_account_name');
  if (saved) {
    out.classList.add("hidden");
    inn.classList.remove("hidden");
    const nm = $("steamName");
    if (nm) nm.textContent = '🎮 ' + (savedName || ('Player ' + saved));
  } else {
    out.classList.remove("hidden");
    inn.classList.add("hidden");
  }
}

async function bindSteam() {
  const inp = $("steamInput"), st = $("steamStatus");
  const v = inp ? inp.value : '';
  if (st) st.textContent = 'Ищем профиль…';
  const found = await resolveSteam(v);
  if (found) {
    localStorage.setItem('steam_account_id', found.id);
    localStorage.setItem('steam_account_name', found.name);
    showSteamState();
    if (st) st.textContent = 'Привязан: ' + found.name;
  } else {
    if (st) st.textContent = 'Не нашли. Вставь SteamID64 (цифры из ссылки на профиль) или точный ник.';
  }
}

function unbindSteam() {
  localStorage.removeItem('steam_account_id');
  localStorage.removeItem('steam_account_name');
  showSteamState();
  const st = $("steamStatus");
  if (st) st.textContent = '';
}

async function showLoggedIn() { showSteamState(); }

async function loadRecentMatches() {
  const accountId = localStorage.getItem('steam_account_id');
  if (!accountId) {
    const st = $("steamStatus");
    if (st) st.textContent = 'Сначала привяжи Steam выше.';
    return;
  }
  const box = $("profileBox");
  if (!box) return;
  try {
    box.innerHTML = 'Загружаем последние матчи…';
    const res = await fetch(`${API}/players/${accountId}/matches?limit=10`);
    if (!res.ok) throw Error('Не удалось загрузить матчи');
    const matches = await res.json();
    if (!matches || !matches.length) { box.innerHTML = 'Матчей не найдено.'; return; }
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
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) { box.innerHTML = 'Ошибка: ' + e.message; }
}

// single DOMContentLoaded owner is app.js; expose init called from there
function initSteamBox() {
  showSteamState();
  const sv = $("steamSave"); if (sv) sv.onclick = bindSteam;
  const lo = $("steamLogout"); if (lo) lo.onclick = unbindSteam;
  const rc = $("steamRecent"); if (rc) rc.onclick = loadRecentMatches;
  const inp = $("steamInput");
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); bindSteam(); } });
}
