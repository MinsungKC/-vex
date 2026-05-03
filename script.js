const API_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIzIiwianRpIjoiYTRhZWJlYmU2ZTdhM2Y1ZDA2OWNhYjNiNjc0ZmUwNGYwYTJlNzkzM2QxNjI0MTg5ODY5ZjJjM2RiZmM3MzYwMzY3NzYyYTMwMDYwMDk5YWYiLCJpYXQiOjE3NzY5MDQxOTAuNTgzMzIzLCJuYmYiOjE3NzY5MDQxOTAuNTgzMzI0OSwiZXhwIjoyNzIzNjc1MzkwLjU3MzA3MzksInN1YiI6IjE0NTI5MCIsInNjb3BlcyI6W119.fyQ5Rlf3Ql4r7UlPLrTzTkAf1uwdWlirx2LML1yXSvf7d0IPPnPsOq9FFbdrD3qgTMpF8WFAB_I9oQgIPGPv-GgaHW-0NbyoeS4hXmj6kzz3pesLUPn9i02iePdi0A8BMroRdhljwXW9AjMDYEdebc5K6vz0zeKrXhliYa8wyEmsCm59LSA8CKGVgQ71gqXexzJftezM4ZlMP0l6WW8_xjCsQzoN2GI4gqPVCEVr7Py8HjUzy19vWX2diYTvWJoc87OLEdXRC17VzfjzmostPrjbwiIuVhoJUmi4GAEQHJe61tHGUbNGbeylNSXTEgCJXo7sxuSWA24EWpKSJ4Ud6QDgypxWI3vqf9-V2ZEfVddxRR6Tuw3oiFz5_F1Tbxrv2t45Qsc-Db-tRv_90tsMr_ABt-V_AxMalvXpVivHGHj1ePGlDjqifKNQvsMQ5uxT0oM__XseOWUeSw6ES2270Il1iqnPaCuM686nkcQnVRwU-Lw3u9ECJ68gfAyQaeD_slunNhdYfqsEymlJR3Yth77ZKIciv1cMCk-urRTTxkb1Ykc1CC8vr3WaTLBqXn-KSZjMQrhWugHLDVDjIBIgdQl3Yl2914diNrZXosEKQ_S_AouEhDUu0-oUwBm2vX0XhHBlVsguD4t0X4sNp6HpxGV_JFkwQqj8_dSyVkzjUNA';
const BASE = 'https://www.robotevents.com/api/v2';

const ROUND_NAMES = { 1: 'Practice', 2: 'Qualifications', 3: 'Quarterfinals', 4: 'Semifinals', 5: 'Finals', 6: 'Round of 16' };

// RobotEvents uses score = -1 as a sentinel for "not yet played" — treat anything < 0 as unscored
function isScored(score) { return typeof score === 'number' && score >= 0; }
// Returns true when a match has been played and both alliances have real scores.
// Checks m.started (set by the API when a match begins) as a stronger guard than score alone,
// since some events pre-populate alliance scores with 0 before a match is played.
function matchIsScored(m) {
  const alliances = m.alliances || [];
  if (alliances.length < 2) return false;
  // If the API provides a started timestamp, require it to be non-null
  if ('started' in m && m.started == null) return false;
  return alliances.every(a => isScored(a.score));
}

// ── State ─────────────────────────────────────────────────────────────────
let currentTeam        = null;
let loadedSeasons      = [];
let loadedEvents       = [];
let currentEvent       = null;
let activeDiv          = null;
let activeEventTab     = 'rankings';
let cachedEventMatches  = []; // all matches for current event+division
let cachedOPR           = {}; // { teamName: { opr, dpr, ccwm } }
let cachedSeasonOPR     = {}; // { teamName: { opr, ccwm } } — from prior events this season
let cachedEventRankings   = {}; // { teamName: { rank, wins, losses, ties, winRate, wp } }
let cachedEventSkills     = {}; // { teamName: { driver, prog, combined, normalized } }
let cachedAwardsData      = []; // raw awards from /events/{id}/awards
let cachedPriorAwardScores = null; // null = not loaded; {} = loaded (teamName → score)
let cachedPriorExcellenceSet = null; // Set of team numbers who won Excellence at qualifying events
let currentTeamAtEvent  = null;
let pendingHighlightTeam = null; // team number to highlight after rankings load
let predWeights         = JSON.parse(localStorage.getItem('predWeights') || 'null') || { opr: 50, ranking: 25, skills: 25 };
const PRED_TUNING_DEFAULTS = { wOPR: 1.0, wCCWM: 0.3, wDPR: 0.2, wWR: 0.3, wSkills: 0.1, wConsist: 0.1, wForm: 0.2, tanhScale: 0.22, noise: 0.05 };
// Always merge with defaults so adding new keys never breaks on old localStorage values.
let predTuning = Object.assign({}, PRED_TUNING_DEFAULTS, (() => {
  const stored = JSON.parse(localStorage.getItem('predTuning') || 'null') || {};
  // Drop any legacy keys (e.g. old ccwmW) that no longer exist in defaults
  return Object.fromEntries(Object.entries(stored).filter(([k]) => k in PRED_TUNING_DEFAULTS));
})());
let _predStatCache = null; // invalidated when event data changes
let showMatchPredictions = JSON.parse(localStorage.getItem('showMatchPredictions') || 'false');

// ── Watchlist ──────────────────────────────────────────────────────────────
// watchlist: { teams: { [number]: { name, program } }, events: { [id]: { name, sku } } }
// snapshots: { teams: { [number]: { lastRank, lastAwards, ts } }, events: { [id]: { lastAwards, lastMatches, ts } } }
// notifications: [ { id, ts, text, link, type } ]

function getWatchlist() {
  try { return JSON.parse(localStorage.getItem('watchlist') || 'null') || { teams: {}, events: {} }; } catch (_) { return { teams: {}, events: {} }; }
}
function saveWatchlist(wl) { localStorage.setItem('watchlist', JSON.stringify(wl)); }
function getSnapshots() {
  try { return JSON.parse(localStorage.getItem('wl_snapshots') || 'null') || { teams: {}, events: {} }; } catch (_) { return { teams: {}, events: {} }; }
}
function saveSnapshots(s) { localStorage.setItem('wl_snapshots', JSON.stringify(s)); }
function getNotifications() {
  try { return JSON.parse(localStorage.getItem('wl_notifications') || '[]'); } catch (_) { return []; }
}
function saveNotifications(ns) { localStorage.setItem('wl_notifications', JSON.stringify(ns.slice(0, 50))); }
function addNotification(text, type = 'info') {
  const ns = getNotifications();
  ns.unshift({ id: Date.now() + Math.random(), ts: Date.now(), text, type });
  saveNotifications(ns);
  updateNotifBadge();
}

function followTeam(number, name, program) {
  const wl = getWatchlist();
  wl.teams[number] = { name, program };
  saveWatchlist(wl);
  updateFollowButtons();
}
function unfollowTeam(number) {
  const wl = getWatchlist();
  delete wl.teams[number];
  saveWatchlist(wl);
  updateFollowButtons();
}
function isFollowingTeam(number) { return !!getWatchlist().teams[number]; }

function followEvent(id, name, sku) {
  const wl = getWatchlist();
  wl.events[id] = { name, sku };
  saveWatchlist(wl);
  updateFollowButtons();
}
function unfollowEvent(id) {
  const wl = getWatchlist();
  delete wl.events[id];
  saveWatchlist(wl);
  updateFollowButtons();
}
function isFollowingEvent(id) { return !!getWatchlist().events[String(id)]; }

function updateFollowButtons() {
  document.querySelectorAll('.follow-team-btn[data-num]').forEach(btn => {
    const following = isFollowingTeam(btn.dataset.num);
    btn.textContent = following ? 'Following ★' : 'Follow ☆';
    btn.classList.toggle('following', following);
  });
  document.querySelectorAll('.follow-event-btn[data-eid]').forEach(btn => {
    const following = isFollowingEvent(btn.dataset.eid);
    btn.textContent = following ? 'Following ★' : 'Follow ☆';
    btn.classList.toggle('following', following);
  });
}

function updateNotifBadge() {
  const ns = getNotifications();
  const lastSeen = +localStorage.getItem('notif_last_seen') || 0;
  const unseen = ns.filter(n => n.ts > lastSeen).length;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    badge.textContent = unseen > 0 ? (unseen > 9 ? '9+' : unseen) : '';
    badge.style.display = unseen > 0 ? '' : 'none';
  }
}

function openNotifPanel() {
  localStorage.setItem('notif_last_seen', Date.now());
  updateNotifBadge();
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  const wl = getWatchlist();
  const ns = getNotifications();
  const teamEntries = Object.entries(wl.teams);
  const eventEntries = Object.entries(wl.events);

  panel.innerHTML = `
    <div class="notif-panel-inner">
      <div class="notif-header">
        <span class="notif-title">Notifications</span>
        <button class="notif-clear-btn" id="notif-clear">Clear all</button>
        <button class="notif-close-btn" id="notif-close">✕</button>
      </div>
      ${ns.length === 0 ? '<div class="notif-empty">No notifications yet.</div>' :
        ns.map(n => `
          <div class="notif-item notif-${n.type}">
            <span class="notif-text">${esc(n.text)}</span>
            <span class="notif-ts">${timeAgo(n.ts)}</span>
          </div>`).join('')}
      <div class="notif-section-title">Watchlist</div>
      ${teamEntries.length === 0 && eventEntries.length === 0 ? '<div class="notif-empty">No followed teams or events.</div>' : ''}
      ${teamEntries.map(([num, t]) => `
        <div class="notif-wl-item">
          <span>Team <strong>${esc(num)}</strong> — ${esc(t.name||'')}</span>
          <button class="notif-unfollow" data-type="team" data-id="${esc(num)}">Unfollow</button>
        </div>`).join('')}
      ${eventEntries.map(([id, ev]) => `
        <div class="notif-wl-item">
          <span>Event <strong>${esc(ev.sku||id)}</strong> — ${esc(ev.name||'')}</span>
          <button class="notif-unfollow" data-type="event" data-id="${esc(id)}">Unfollow</button>
        </div>`).join('')}
    </div>`;

  panel.classList.remove('hidden');
  document.getElementById('notif-close')?.addEventListener('click', () => panel.classList.add('hidden'));
  document.getElementById('notif-clear')?.addEventListener('click', () => {
    saveNotifications([]);
    localStorage.setItem('notif_last_seen', Date.now());
    updateNotifBadge();
    openNotifPanel();
  });
  panel.querySelectorAll('.notif-unfollow').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === 'team') unfollowTeam(btn.dataset.id);
      else unfollowEvent(btn.dataset.id);
      openNotifPanel();
    });
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// Check watched teams/events for updates on startup (fire and forget)
async function checkWatchlistUpdates() {
  const wl = getWatchlist();
  const snap = getSnapshots();
  const teamNums = Object.keys(wl.teams);
  const eventIds = Object.keys(wl.events);
  if (!teamNums.length && !eventIds.length) return;

  // Check teams: look for ranking/awards changes
  for (const num of teamNums) {
    try {
      const teamData = await apiFetch(`/teams?number[]=${encodeURIComponent(num)}&per_page=1`);
      const team = teamData.data?.[0];
      if (!team) continue;
      const awards = await apiFetch(`/teams/${team.id}/awards?per_page=10`);
      const awardNames = (awards.data || []).map(a => a.title).sort().join('|');
      const prev = snap.teams[num];
      if (prev) {
        if (prev.lastAwards && prev.lastAwards !== awardNames) {
          addNotification(`Team ${num} has new award activity!`, 'award');
        }
      }
      snap.teams[num] = { lastAwards: awardNames, ts: Date.now() };
    } catch (_) { /* ignore API errors during background check */ }
  }

  // Check events: look for new match results or awards
  for (const eid of eventIds) {
    try {
      await apiFetch(`/events/${eid}?per_page=1`);
      const matchData = await apiFetch(`/events/${eid}/matches?per_page=50`);
      const scoredCount = (matchData.data || []).filter(matchIsScored).length;
      const awards = await apiFetch(`/events/${eid}/awards?per_page=10`);
      const awardCount = (awards.data || []).length;
      const prev = snap.events[eid];
      if (prev) {
        if (scoredCount > (prev.scoredCount || 0)) {
          addNotification(`${wl.events[eid].name || 'Event'}: ${scoredCount - prev.scoredCount} new match result(s) posted`, 'match');
        }
        if (awardCount > (prev.awardCount || 0)) {
          addNotification(`${wl.events[eid].name || 'Event'}: awards updated!`, 'award');
        }
      }
      snap.events[eid] = { scoredCount, awardCount, ts: Date.now() };
    } catch (_) { /* ignore */ }
  }

  saveSnapshots(snap);
  updateNotifBadge();
}

// ── Dark / light theme ────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved ? saved === 'dark' : prefersDark;
  if (isDark) document.documentElement.dataset.theme = 'dark';
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.checked = isDark;
      toggle.addEventListener('change', () => {
        const dark = toggle.checked;
        document.documentElement.dataset.theme = dark ? 'dark' : '';
        localStorage.setItem('theme', dark ? 'dark' : 'light');
      });
    }

    // Notification bell
    const bell = document.getElementById('notif-bell');
    const panel = document.getElementById('notif-panel');
    if (bell) {
      updateNotifBadge();
      bell.addEventListener('click', e => {
        e.stopPropagation();
        if (panel.classList.contains('hidden')) openNotifPanel();
        else panel.classList.add('hidden');
      });
    }
    document.addEventListener('click', e => {
      if (panel && !panel.contains(e.target) && e.target !== bell) {
        panel.classList.add('hidden');
      }
    });

    // Background watchlist update check (fire and forget)
    setTimeout(() => checkWatchlistUpdates(), 2000);
  });
})();

// ── UI mode (simple / complex) + Glass mode ───────────────────────────────
(function initUIMode() {
  const uiMode   = localStorage.getItem('uiMode')   || 'simple';
  const glassOn  = localStorage.getItem('glassMode') === 'true';

  document.documentElement.dataset.uiMode = uiMode;
  if (glassOn) document.body.classList.add('glass-mode');

  document.addEventListener('DOMContentLoaded', () => {
    const modeBtn  = document.getElementById('mode-toggle');
    const glassBtn = document.getElementById('glass-toggle');

    function syncModeBtn() {
      const mode = document.documentElement.dataset.uiMode;
      modeBtn.textContent = mode === 'simple' ? 'Simple' : 'Complex';
      modeBtn.classList.toggle('mode-active', mode === 'complex');
    }
    function syncGlassBtn() {
      glassBtn.classList.toggle('glass-active', document.body.classList.contains('glass-mode'));
    }

    syncModeBtn();
    syncGlassBtn();

    modeBtn.addEventListener('click', () => {
      const next = document.documentElement.dataset.uiMode === 'simple' ? 'complex' : 'simple';
      document.documentElement.dataset.uiMode = next;
      localStorage.setItem('uiMode', next);
      syncModeBtn();
    });

    glassBtn.addEventListener('click', () => {
      const on = document.body.classList.toggle('glass-mode');
      localStorage.setItem('glassMode', String(on));
      syncGlassBtn();
    });
  });
})();

// ── Loading bar ────────────────────────────────────────────────────────────
let _fetchCount = 0;
function _showLoader() {
  const el = document.getElementById('global-loader');
  if (el) el.classList.add('active');
}
function _hideLoader() {
  const el = document.getElementById('global-loader');
  if (el) el.classList.remove('active');
}

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch(path) {
  _fetchCount++;
  if (_fetchCount === 1) _showLoader();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(BASE + path, {
        headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' }
      });
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '0', 10) * 1000
                     || Math.min(4000 * Math.pow(2, attempt), 64000);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      return await res.json();
    }
  } finally {
    _fetchCount--;
    if (_fetchCount === 0) _hideLoader();
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run `tasks` (array of async functions) with at most `concurrency` running simultaneously.
async function promisePool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function fetchAllPages(path) {
  const all = [];
  let page = 1;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const json = await apiFetch(`${path}${sep}page=${page}&per_page=250`);
    if (!json.data) break;
    all.push(...json.data);
    if (!json.meta || page >= json.meta.last_page) break;
    page++;
  }
  return all;
}

// ── View routing ───────────────────────────────────────────────────────────
const VIEWS = ['view-search', 'view-event', 'view-seasons', 'view-stats', 'view-team-event', 'view-map', 'view-standings', 'view-compare', 'view-live', 'view-h2h'];
function showView(id) {
  VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
  if (id !== 'view-live') stopLivePolling();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    if (which === 'map') { openMapView(); return; }
    if (which === 'standings') { openStandingsView(); return; }
    if (which === 'compare') { openCompareView(); return; }
    if (which === 'live') { openLiveView(); return; }
    if (which === 'h2h') { openH2HView(); return; }
    document.getElementById('panel-team').classList.toggle('hidden', which !== 'team');
    document.getElementById('panel-event').classList.toggle('hidden', which !== 'event');
    if (which === 'event') onEventTabActivated();
    else clearSearch();
  });
});

// ── Back buttons ───────────────────────────────────────────────────────────
document.getElementById('back-to-events').addEventListener('click', () => showView('view-search'));
document.getElementById('back-to-search').addEventListener('click', () => showView('view-search'));
document.getElementById('back-to-seasons').addEventListener('click', () => {
  if (currentTeam) openSeasonsView(currentTeam);
});
document.getElementById('back-to-event-from-team').addEventListener('click', async () => {
  pendingHighlightTeam = currentTeamAtEvent;
  activeEventTab = 'rankings';
  showView('view-event');
  document.querySelectorAll('.detail-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'rankings'));
  await loadEventTabContent();
});
document.getElementById('back-from-map').addEventListener('click', () => showView(mapState.sourceView));
document.getElementById('back-from-standings').addEventListener('click', () => {
  showView('view-search');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="team"]')?.classList.add('active');
  document.getElementById('panel-team').classList.remove('hidden');
  document.getElementById('panel-event').classList.add('hidden');
});
document.getElementById('back-from-compare').addEventListener('click', () => {
  showView('view-search');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="team"]')?.classList.add('active');
  document.getElementById('panel-team').classList.remove('hidden');
  document.getElementById('panel-event').classList.add('hidden');
});
document.getElementById('back-from-live').addEventListener('click', () => {
  showView('view-search');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="team"]')?.classList.add('active');
  document.getElementById('panel-team').classList.remove('hidden');
  document.getElementById('panel-event').classList.add('hidden');
});
document.getElementById('back-from-h2h').addEventListener('click', () => {
  showView('view-search');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="team"]')?.classList.add('active');
  document.getElementById('panel-team').classList.remove('hidden');
  document.getElementById('panel-event').classList.add('hidden');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEAM SEARCH
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('teamSearchBtn').addEventListener('click', () => {
  const num = document.getElementById('teamNumber').value.trim();
  if (!num) { setStatus('search', 'Please enter a team number.', 'warn'); return; }
  searchByTeam(num);
});
document.getElementById('teamNumber').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('teamSearchBtn').click();
});

// Navigate directly to a team's seasons view — used from standings where we know the program.
// Filters by program ID so e.g. "1234A" in V5RC doesn't match a VIQRC team with the same number.
async function goToTeam(number, programId) {
  try {
    const json = await apiFetch(
      `/teams?number[]=${encodeURIComponent(number)}&program[]=${programId}&myTeams=false`
    );
    const team = json.data?.[0];
    if (team) { openSeasonsView(team); return; }
    // Fallback: search without program filter if nothing found
    const fallback = await apiFetch(`/teams?number[]=${encodeURIComponent(number)}&myTeams=false`);
    if (fallback.data?.[0]) { openSeasonsView(fallback.data[0]); return; }
    setStatus('search', `Team ${esc(number)} not found.`, 'error');
    showView('view-search');
  } catch (err) {
    setStatus('search', `Error: ${err.message}`, 'error');
    showView('view-search');
  }
}

async function searchByTeam(number) {
  clearSearch();
  setStatus('search', 'Looking up team…');
  try {
    const json  = await apiFetch(`/teams?number[]=${encodeURIComponent(number)}&myTeams=false`);
    const teams = json.data || [];
    if (!teams.length) { setStatus('search', `No team found for "${esc(number)}".`, 'error'); return; }
    clearStatus('search');
    renderSearchTeams(teams);
  } catch (err) {
    setStatus('search', `Error: ${err.message}`, 'error');
  }
}

function renderSearchTeams(teams) {
  const el = document.getElementById('search-results');
  const note = teams.length > 1
    ? `<p style="margin-bottom:14px;color:var(--text-muted);font-size:.85rem">${teams.length} results — click a card to view season history.</p>`
    : `<p style="margin-bottom:14px;color:var(--text-muted);font-size:.85rem">Click to explore season history.</p>`;
  el.innerHTML = note + teams.map(t => teamHeroHTML(t, true)).join('');
  el.querySelectorAll('.team-hero.clickable').forEach((card, i) => {
    card.addEventListener('click', () => openSeasonsView(teams[i]));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT BROWSE
// ═══════════════════════════════════════════════════════════════════════════

async function onEventTabActivated() {
  clearStatus('search');
  if (loadedEvents.length > 0) {
    filterAndRenderEvents(document.getElementById('eventFilter')?.value || '');
    return;
  }
  if (loadedSeasons.length === 0) await initEventTab();
}

async function initEventTab() {
  setStatus('search', 'Loading seasons…');
  try {
    const [s1, s4, s41] = await Promise.all([
      apiFetch('/seasons?program[]=1&per_page=250'),
      apiFetch('/seasons?program[]=4&per_page=250'),
      apiFetch('/seasons?program[]=41&per_page=250'),
    ]);
    const byProgram = {
      'V5RC':  (s1.data  || []).sort((a, b) => b.id - a.id),
      'VEXU':  (s4.data  || []).sort((a, b) => b.id - a.id),
      'VIQRC': (s41.data || []).sort((a, b) => b.id - a.id),
    };
    const sel = document.getElementById('seasonSelect');
    sel.innerHTML = Object.entries(byProgram).map(([prog, seasons]) =>
      `<optgroup label="${prog}">` +
      seasons.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('') +
      '</optgroup>'
    ).join('');
    sel.addEventListener('change', () => loadEventsForSeason(+sel.value));
    loadedSeasons = [...(s1.data || []), ...(s4.data || []), ...(s41.data || [])];
    clearStatus('search');
    if (sel.options.length > 0) await loadEventsForSeason(+sel.value);
  } catch (err) {
    setStatus('search', `Error loading seasons: ${err.message}`, 'error');
  }
}

async function loadEventsForSeason(seasonId) {
  document.getElementById('search-results').innerHTML = '';
  setStatus('search', 'Loading events…');
  try {
    loadedEvents = await fetchAllPages(`/events?season[]=${seasonId}`);
    clearStatus('search');
    const filterEl = document.getElementById('eventFilter');
    filterEl.value = '';
    filterEl.oninput = () => filterAndRenderEvents(filterEl.value);
    filterAndRenderEvents('');
  } catch (err) {
    setStatus('search', `Error: ${err.message}`, 'error');
  }
}

function filterAndRenderEvents(q) {
  const lower = q.toLowerCase();
  const filtered = lower
    ? loadedEvents.filter(ev =>
        ev.name.toLowerCase().includes(lower) ||
        (ev.location?.city   || '').toLowerCase().includes(lower) ||
        (ev.location?.region || '').toLowerCase().includes(lower) ||
        ev.sku.toLowerCase().includes(lower)
      )
    : loadedEvents;
  renderEventList([...filtered].sort((a, b) => new Date(b.start) - new Date(a.start)));
}

function renderEventList(events) {
  const el = document.getElementById('search-results');
  if (!events.length) { el.innerHTML = '<p class="empty">No events match your filter.</p>'; return; }
  el.innerHTML = `<div class="event-list">${events.map((ev, i) => eventCardHTML(ev, i)).join('')}</div>`;
  el.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openEventDetail(events[+card.dataset.idx]));
  });
}

function eventCardHTML(ev, idx) {
  const date     = ev.start ? new Date(ev.start).toLocaleDateString() : '—';
  const loc      = [ev.location?.city, ev.location?.region].filter(Boolean).join(', ') || '—';
  const divCount = ev.divisions?.length || 0;
  return `
    <div class="event-card" data-idx="${idx}">
      <div class="event-card-body">
        <div class="event-card-name">${esc(ev.name)}</div>
        <div class="event-card-meta"><span>${date}</span><span>${esc(loc)}</span></div>
        <div class="event-card-pills">
          ${ev.program?.name ? `<span class="pill">${esc(ev.program.name)}</span>` : ''}
          ${ev.level         ? `<span class="pill">${esc(ev.level)}</span>`         : ''}
          ${divCount > 1     ? `<span class="pill">${divCount} Divisions</span>`    : ''}
        </div>
      </div>
      <span class="event-card-arrow">›</span>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT DETAIL
// ═══════════════════════════════════════════════════════════════════════════

async function openEventDetail(ev) {
  currentEvent        = ev;
  activeDiv           = ev.divisions?.[0]?.id ?? null;
  activeEventTab      = 'rankings';
  cachedEventMatches     = [];
  cachedOPR              = {};
  cachedSeasonOPR        = {};
  _predStatCache         = null;
  cachedEventRankings    = {};
  cachedEventSkills      = {};
  cachedAwardsData       = [];
  cachedPriorAwardScores = null;
  cachedPriorExcellenceSet = null;

  showView('view-event');
  renderEventHero(ev);
  renderDivisionSelector(ev.divisions || []);
  renderDetailTabBar();
  await loadEventTabContent();
}

function renderEventHero(ev) {
  const start = ev.start ? new Date(ev.start).toLocaleDateString() : '—';
  const end   = ev.end   ? new Date(ev.end).toLocaleDateString()   : '—';
  const date  = start === end ? start : `${start} – ${end}`;
  const loc   = [ev.location?.venue, ev.location?.city, ev.location?.region, ev.location?.country]
    .filter(Boolean).join(', ') || '—';
  const following = isFollowingEvent(ev.id);
  const heroEl = document.getElementById('event-detail-hero');
  heroEl.innerHTML = `
    <div class="event-hero">
      <div class="event-hero-name">${esc(ev.name)}</div>
      <div class="event-hero-meta">
        ${mf('Date', date)} ${mf('Location', loc)} ${mf('Program', ev.program?.name || '—')}
        ${mf('Season', ev.season?.name || '—')} ${mf('Level', ev.level || '—')} ${mf('Code', ev.sku || '—')}
      </div>
      <button class="follow-event-btn ${following ? 'following' : ''}" data-eid="${ev.id}" data-name="${esc(ev.name)}" data-sku="${esc(ev.sku||'')}">
        ${following ? 'Following ★' : 'Follow ☆'}
      </button>
    </div>`;
  heroEl.querySelector('.follow-event-btn')?.addEventListener('click', () => {
    if (isFollowingEvent(ev.id)) {
      unfollowEvent(ev.id);
    } else {
      followEvent(ev.id, ev.name, ev.sku || '');
      addNotification(`Now following ${ev.name}`, 'info');
    }
    updateFollowButtons();
  });
}

function renderDivisionSelector(divisions) {
  const el = document.getElementById('division-selector');
  if (divisions.length <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="division-pills">
      <span class="division-label">Division:</span>
      ${divisions.map(d => `
        <button class="div-pill ${d.id === activeDiv ? 'active' : ''}" data-id="${d.id}">
          ${esc(d.name)}
        </button>`).join('')}
    </div>`;
  el.querySelectorAll('.div-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeDiv = +btn.dataset.id;
      el.querySelectorAll('.div-pill').forEach(b => b.classList.toggle('active', +b.dataset.id === activeDiv));
      cachedEventMatches     = [];
      cachedOPR              = {};
      _predStatCache         = null;
      cachedSeasonOPR        = {};
      cachedEventRankings    = {};
      cachedEventSkills      = {};
      cachedAwardsData       = [];
      cachedPriorAwardScores = null;
      cachedPriorExcellenceSet = null;
      await loadEventTabContent();
    });
  });
}

function renderDetailTabBar() {
  const tabs = [
    { id: 'rankings', label: 'Rankings' },
    { id: 'matches',  label: 'Matches'  },
    { id: 'bracket',  label: 'Bracket'  },
    { id: 'simulate', label: 'Sim',        complex: true },
    { id: 'picklist', label: 'Pick List',  complex: true },
    { id: 'draft',    label: 'Draft Sim',  complex: true },
    { id: 'awards',   label: 'Awards'   },
    { id: 'skills',   label: 'Skills'   },
    { id: 'teams',    label: 'Teams',      complex: true },
    { id: 'map',      label: 'Map',        complex: true },
  ];
  document.getElementById('event-tabs-bar').innerHTML = `
    <div class="detail-tabs">
      ${tabs.map(t => `
        <button class="detail-tab${t.id === activeEventTab ? ' active' : ''}${t.complex ? ' complex-only' : ''}" data-tab="${t.id}">
          ${t.label}
        </button>`).join('')}
    </div>`;
  document.querySelectorAll('.detail-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeEventTab = btn.dataset.tab;
      document.querySelectorAll('.detail-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === activeEventTab));
      await loadEventTabContent();
    });
  });
}

function reRenderMatchContainer(el) {
  const container = el.querySelector('#matches-table-container');
  if (!container) return;
  container.innerHTML = renderMatches(cachedEventMatches);
  container.querySelectorAll('.match-row').forEach(row => row.addEventListener('click', () => toggleMatchDetail(row)));
  container.querySelectorAll('.team-link[data-num]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const num = btn.dataset.num;
      if (num && num !== 'undefined') openTeamEventView(num);
    });
  });
}

function attachWeightListeners(el, onUpdate) {
  const wToggle = el.querySelector('#pred-weights-toggle');
  const wBody   = el.querySelector('#pred-weights-body');
  if (wToggle && wBody) {
    wToggle.addEventListener('click', () => {
      const hidden = wBody.classList.toggle('hidden');
      wToggle.querySelector('.pred-chevron').textContent = hidden ? '▼' : '▲';
    });
  }
  el.querySelectorAll('.weight-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.key;
      predWeights[key] = +slider.value;
      el.querySelectorAll('.weight-val[data-key="' + key + '"]').forEach(s => s.textContent = slider.value);
      localStorage.setItem('predWeights', JSON.stringify(predWeights));
      onUpdate();
    });
  });
}

// Grid-search over (ccwmW, tanhScale) to maximise win-direction accuracy
// on completed matches. Returns { ccwmW, tanhScale, accuracy, curve }.
// Coordinate-descent optimizer for all 8 prediction parameters.
// Builds the stat cache once, then tunes weights to maximise winner accuracy.
function autoTunePredictions() {
  const played = cachedEventMatches.filter(m => m.round === 2 && matchIsScored(m));
  if (played.length < 5) return null;

  // Build stat cache once — normalized values don't depend on weights
  const cache = buildTeamStatCache();
  if (!Object.keys(cache).length) return null;

  // Helper: count fraction of winner predictions that match actual outcome
  function evalAccuracy(params) {
    const saved = { ...predTuning };
    Object.assign(predTuning, params);
    let correct = 0, total = 0;
    for (const m of played) {
      const pred = predictMatch(m, cache);
      if (!pred) continue;
      const all = m.alliances || [];
      const red  = all.find(a => a.color === 'red');
      const blue = all.find(a => a.color === 'blue');
      if (!red || !blue || red.score == null || blue.score == null) continue;
      const actual = red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie';
      if (pred.winner === actual) correct++;
      total++;
    }
    Object.assign(predTuning, saved);
    return total > 0 ? correct / total : 0;
  }

  // Search grid per parameter (fine-grained around typical useful ranges)
  const PARAM_GRIDS = {
    wOPR:     [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
    wCCWM:    [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25, 1.5],
    wDPR:     [0, 0.2, 0.4, 0.6, 0.8, 1.0],
    wWR:      [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25],
    wSkills:  [0, 0.15, 0.3, 0.5, 0.75, 1.0],
    wConsist: [0, 0.1, 0.2, 0.35, 0.5],
    wForm:    [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25],
    tanhScale:[0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50],
    noise:    [0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30],
  };

  // Naive OPR-only baseline for comparison
  const naiveParams = { wOPR: 1, wCCWM: 0, wDPR: 0, wWR: 0, wSkills: 0, wConsist: 0, wForm: 0, tanhScale: 0.22, noise: 0.05 };
  const naiveAcc    = evalAccuracy(naiveParams);

  // Coordinate descent: 4 passes over all params
  const best = { ...predTuning };
  let bestAcc = evalAccuracy(best);

  for (let pass = 0; pass < 4; pass++) {
    for (const key of Object.keys(PARAM_GRIDS)) {
      let bestVal = best[key];
      for (const v of PARAM_GRIDS[key]) {
        const candidate = { ...best, [key]: v };
        const acc = evalAccuracy(candidate);
        if (acc > bestAcc + 1e-9) { bestAcc = acc; bestVal = v; best[key] = v; }
      }
      best[key] = bestVal;
    }
  }

  // Per-weight importance: drop each to 0, measure accuracy fall
  const importance = {};
  for (const key of ['wOPR', 'wCCWM', 'wDPR', 'wWR', 'wSkills', 'wConsist', 'wForm']) {
    const withoutKey = { ...best, [key]: 0 };
    const accWithout = evalAccuracy(withoutKey);
    importance[key] = Math.max(0, bestAcc - accWithout); // how much this stat contributes
  }

  Object.assign(predTuning, best);
  _predStatCache = cache; // use the freshly-built cache going forward
  localStorage.setItem('predTuning', JSON.stringify(predTuning));
  return {
    params: best,
    accuracy: Math.round(bestAcc * 100),
    naiveAcc: Math.round(naiveAcc * 100),
    matchCount: played.length,
    importance,
  };
}

function attachMatchTabListeners(el) {
  // Show/hide predictions toggle
  const showToggle = el.querySelector('#pred-show-toggle');
  if (showToggle) {
    showToggle.addEventListener('click', () => {
      showMatchPredictions = !showMatchPredictions;
      showToggle.classList.toggle('active', showMatchPredictions);
      localStorage.setItem('showMatchPredictions', JSON.stringify(showMatchPredictions));
      reRenderMatchContainer(el);
    });
  }

  // Old fallback-weight sliders (OPR/ranking/skills proxy)
  attachWeightListeners(el, () => reRenderMatchContainer(el));

  // Weights panel toggle
  const wToggle = el.querySelector('#pred-weights-toggle');
  const wBody   = el.querySelector('#pred-weights-body');
  if (wToggle && wBody) {
    wToggle.addEventListener('click', () => {
      const hidden = wBody.classList.toggle('hidden');
      wToggle.querySelector('.pred-chevron').textContent = hidden ? '▼' : '▲';
    });
  }

  // Helper: refresh the live accuracy badge in the toggle button + inline header
  function refreshLiveAcc() {
    const acc = computeLiveAccuracy();
    const badge  = el.querySelector('#tune-live-acc');
    const inline = el.querySelector('#tune-live-inline');
    if (acc) {
      if (badge)  { badge.textContent = acc.pct + '% on ' + acc.n + ' matches'; badge.style.display = ''; }
      if (inline) inline.textContent = acc.pct + '% accuracy (' + acc.n + ' played)';
    }
  }

  // Tuning sliders — update predTuning, invalidate cache, refresh accuracy live
  el.querySelectorAll('.tune-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.tunekey;
      const val = +slider.value;
      predTuning[key] = val;
      _predStatCache = null; // form/consist in cache depend on match weights indirectly
      localStorage.setItem('predTuning', JSON.stringify(predTuning));
      // Update displayed value + fill bar
      const valEl  = el.querySelector('#tuneval-' + key);
      const fillEl = el.querySelector('#tunefill-' + key);
      if (valEl)  valEl.textContent = val.toFixed(2);
      if (fillEl) fillEl.style.width = Math.round((val / +slider.dataset.max) * 100) + '%';
      refreshLiveAcc();
      reRenderMatchContainer(el);
    });
  });

  // Reset to defaults
  el.querySelector('#pred-reset-btn')?.addEventListener('click', () => {
    Object.assign(predTuning, PRED_TUNING_DEFAULTS);
    _predStatCache = null;
    localStorage.setItem('predTuning', JSON.stringify(predTuning));
    // Re-render entire panel so sliders snap to defaults
    const container = el.querySelector('#matches-table-container');
    const panelEl   = container ? container.previousElementSibling : null;
    if (panelEl) panelEl.outerHTML = renderPredWeightsPanel();
    attachMatchTabListeners(el);
    reRenderMatchContainer(el);
  });

  // Auto-tune
  const autoTuneBtn = el.querySelector('#pred-autotune-btn');
  if (autoTuneBtn) {
    autoTuneBtn.addEventListener('click', () => {
      autoTuneBtn.textContent = '🧪 Tuning…';
      autoTuneBtn.disabled = true;
      setTimeout(() => {
        const result = autoTunePredictions();
        const resultEl = el.querySelector('#autotune-result');
        if (!result) {
          if (resultEl) resultEl.innerHTML = '<p class="tune-msg">Need ≥5 played matches to tune.</p>';
          autoTuneBtn.textContent = '🧪 Auto-Tune';
          autoTuneBtn.disabled = false;
          return;
        }
        // Sync sliders to newly-tuned values
        el.querySelectorAll('.tune-slider').forEach(s => {
          const key = s.dataset.tunekey;
          if (predTuning[key] !== undefined) {
            s.value = predTuning[key];
            const valEl  = el.querySelector('#tuneval-' + key);
            const fillEl = el.querySelector('#tunefill-' + key);
            if (valEl)  valEl.textContent  = predTuning[key].toFixed(2);
            if (fillEl) fillEl.style.width = Math.round((predTuning[key] / +s.dataset.max) * 100) + '%';
          }
        });
        // Importance bars
        const STAT_LABELS = { wOPR:'OPR', wCCWM:'CCWM', wDPR:'Defence', wWR:'Win Rate', wSkills:'Skills', wConsist:'Consistency', wForm:'Form' };
        const maxImp  = Math.max(...Object.values(result.importance), 0.001);
        const impBars = Object.entries(STAT_LABELS).map(([key, label]) => {
          const imp = result.importance[key] ?? 0;
          const pct = Math.round((imp / maxImp) * 100);
          return '<div class="tune-imp-row">' +
            '<span class="tune-imp-label">' + label + '</span>' +
            '<div class="tune-imp-bar-bg"><div class="tune-imp-bar' + (imp >= maxImp - 1e-9 ? ' tune-bar-best' : '') + '" style="width:' + pct + '%"></div></div>' +
            '<span class="tune-imp-val">w=' + result.params[key].toFixed(2) + '</span>' +
            '</div>';
        }).join('');
        const gain = result.accuracy - result.naiveAcc;
        if (resultEl) resultEl.innerHTML =
          '<div class="tune-result">' +
          '<div class="tune-summary"><strong>' + result.accuracy + '%</strong> on ' + result.matchCount + ' matches' +
          ' · OPR-only: ' + result.naiveAcc + '% · gain: <span class="' + (gain >= 0 ? 'tune-gain' : 'tune-loss') + '">' +
          (gain >= 0 ? '+' : '') + gain + '%</span></div>' +
          '<div class="tune-imp-title">Stat importance (accuracy drop when zeroed):</div>' +
          impBars + '</div>';
        if (wBody) wBody.classList.remove('hidden');
        autoTuneBtn.textContent = '🧪 Auto-Tune ✓';
        autoTuneBtn.disabled = false;
        refreshLiveAcc();
        reRenderMatchContainer(el);
      }, 0);
    });
  }

  // Team links
  el.querySelectorAll('.team-link[data-num]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const num = btn.dataset.num;
      if (!num || num === 'undefined') return;
      openTeamEventView(num);
    });
  });
  // Match row expand
  el.querySelectorAll('.match-row').forEach(row => {
    row.addEventListener('click', () => toggleMatchDetail(row));
  });

  // Award history cache bust
  el.querySelector('#award-cache-bust')?.addEventListener('click', () => {
    const key = priorAwardsCacheKey(currentEvent?.program?.id, currentEvent?.season?.id);
    localStorage.removeItem(key);
    cachedPriorAwardScores = null;
    cachedPriorExcellenceSet = null;
    loadEventTabContent();
  });

  // Sim tab controls
  let simN = 100;
  el.querySelectorAll('.sim-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.sim-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      simN = +btn.dataset.n;
    });
  });
  const slider = el.querySelector('#sim-start-slider');
  const sliderLabel = el.querySelector('#sim-slider-label');
  if (slider && sliderLabel) {
    slider.addEventListener('input', () => {
      const v = +slider.value;
      sliderLabel.textContent = v > +slider.max - 1 ? 'End (current)' : 'Q-' + v;
    });
  }

  const runBtn = el.querySelector('#sim-run-btn');
  if (runBtn) {
    runBtn.addEventListener('click', () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      // If slider is at the sentinel "End" position, pass null (no rewind, simulate remaining only)
      const sliderVal = slider ? +slider.value : null;
      const fromMatch = (sliderVal != null && sliderVal <= +slider?.max - 1) ? sliderVal : null;
      setTimeout(() => {
        const results = runRankingSimulation(simN, fromMatch);
        const resultsEl = el.querySelector('#sim-results');
        if (resultsEl) {
          resultsEl.innerHTML = renderSimResults(results);
          resultsEl.querySelectorAll('.team-link[data-num]').forEach(btn => {
            btn.addEventListener('click', e => {
              e.stopPropagation();
              const num = btn.dataset.num;
              if (num && num !== 'undefined') openTeamEventView(num);
            });
          });
        }
        runBtn.disabled = false;
        runBtn.textContent = 'Run Simulation';
      }, 0);
    });
  }
}

const PRIOR_AWARDS_TTL = 12 * 60 * 60 * 1000; // 12 h — award results don't change after an event ends
const priorAwardsCacheKey = (pid, sid) => `priorAwards-${pid}-${sid}`;

// Fetches qualifying events for the season and reads each event's awards via
// GET /events/{id}/awards. Results are cached in localStorage (12 h TTL) so
// the hundreds of API calls only happen once per session.
// Returns { teamName: avgWeightedScore } and populates cachedPriorExcellenceSet.
async function loadPriorAwardData() {
  if (!currentEvent?.season?.id || !currentEvent?.program?.id) return {};
  const seasonId  = currentEvent.season.id;
  const programId = currentEvent.program.id;
  const eventId   = currentEvent.id;

  // ── 1. Try localStorage cache first ────────────────────────────────────────
  const cacheKey = priorAwardsCacheKey(programId, seasonId);
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && Date.now() - cached.ts < PRIOR_AWARDS_TTL) {
      cachedPriorExcellenceSet = new Set(cached.excellence || []);
      return cached.scores || {};
    }
  } catch (_) {}

  // ── 2. Fetch only past qualifying events (status=past cuts out future events) ─
  const allEvents = await fetchAllPages(
    `/events?season[]=${seasonId}&program[]=${programId}&status=past&per_page=250`
  );
  const qualEvents = allEvents.filter(e => {
    if (e.id === eventId) return false;
    const lvl = (e.level || '').toLowerCase();
    const nm  = (e.name  || '').toLowerCase();
    return !(lvl === 'world' || nm.includes('world championship') || nm.includes('vex worlds'));
  });

  const excellenceWinners = new Set();
  const teamData = {}; // teamName → { totalWeight, eventsSeen: Set<eventId> }

  // ── 3. Fetch GET /events/{id}/awards for each event (3 concurrent to avoid rate-limit) ─
  await promisePool(qualEvents.map(ev => async () => {
    try {
      const awards = await fetchAllPages(`/events/${ev.id}/awards`);
      for (const award of awards) {
        const classified = classifyAward(award.title);
        const weight = PRIOR_AWARD_WEIGHTS[classified] || 0;

        // Winners come from two fields the API may return:
        //   award.teams   → [{ team: { name }, division }]  (structured)
        //   award.winners → ["8838E", "PersonName", ...]    (flat strings)
        const names = new Set();
        for (const t of (award.teamWinners || [])) {
          if (t.team?.name) names.add(t.team.name);
        }

        for (const name of names) {
          if (classified === 'excellence') excellenceWinners.add(name);
          if (weight > 0) {
            if (!teamData[name]) teamData[name] = { totalWeight: 0, eventsSeen: new Set() };
            teamData[name].totalWeight += weight;
            teamData[name].eventsSeen.add(ev.id);
          }
        }
      }
    } catch (_) {}
  }), 3);

  const scores = {};
  for (const [name, d] of Object.entries(teamData)) {
    scores[name] = d.eventsSeen.size > 0 ? d.totalWeight / d.eventsSeen.size : 0;
  }

  // ── 4. Persist to localStorage so repeated opens don't re-fetch ────────────
  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      ts:        Date.now(),
      excellence: [...excellenceWinners],
      scores,
    }));
  } catch (_) {} // ignore if storage is full

  cachedPriorExcellenceSet = excellenceWinners;
  return scores;
}

// True when this is a multi-division championship where Excellence is given at a
// closing/Dome ceremony for the whole event rather than inside each division.
function isWorldsStyleEvent() {
  const level = (currentEvent?.level || '').toLowerCase();
  const name  = (currentEvent?.name  || '').toLowerCase();
  return level === 'world' ||
    name.includes('world championship') ||
    name.includes('vex worlds');
}

// True when the current division is the Dome/finale ceremony division at Worlds,
// where Excellence, TC, and TF are awarded for the full event.
function isDomeDivision() {
  if (!isWorldsStyleEvent()) return false;
  const divName = (currentEvent?.divisions?.find(d => d.id === activeDiv)?.name || '').toLowerCase();
  return divName.includes('dome') || divName.includes('closing') ||
    divName.includes('high school') || divName.includes('middle school') ||
    divName.includes('hs') || divName.includes('ms') || divName.includes(' hs ') ||
    divName.includes('excellence') || divName.includes('championship') ||
    divName.includes('college');
}

async function loadEventTabContent() {
  const el = document.getElementById('event-tab-content');
  el.innerHTML = '';
  setStatus('event-tab', 'Loading…');

  try {
    let html = '';
    const eid = currentEvent.id;
    const did = activeDiv;

    switch (activeEventTab) {
      case 'rankings': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        const data = await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`);
        buildRankingsCache(data);
        html = renderEventRankings(data);
        break;
      }
      case 'matches': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
        cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
        // Load season OPR in background if current event has no scored quals yet
        if (!Object.keys(cachedOPR).length && !Object.keys(cachedSeasonOPR).length) {
          loadSeasonOPR().catch(() => {}); // fire-and-forget; predictions re-render lazily
        }
        if (!Object.keys(cachedEventRankings).length) {
          try { buildRankingsCache(await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`)); } catch (_) {}
        }
        if (!Object.keys(cachedEventSkills).length) {
          try { buildSkillsCache(await fetchAllPages(`/events/${eid}/skills`)); } catch (_) {}
        }
        html = renderPredWeightsPanel() +
               '<div id="matches-table-container">' + renderMatches(cachedEventMatches) + '</div>' +
               renderPredictionAccuracy(cachedEventMatches);
        break;
      }
      case 'bracket': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        if (!cachedEventMatches.length) {
          cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
          cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
        }
        if (!Object.keys(cachedEventRankings).length) {
          try { buildRankingsCache(await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`)); } catch (_) {}
        }
        const rawAlliances = await fetchAllPages(`/events/${eid}/divisions/${did}/alliances`).catch(() => []);
        html = renderBracketTab(rawAlliances, cachedEventMatches);
        break;
      }
      case 'simulate': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        if (!cachedEventMatches.length) {
          cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
          cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
        }
        if (!Object.keys(cachedEventRankings).length) {
          try { buildRankingsCache(await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`)); } catch (_) {}
        }
        if (!Object.keys(cachedEventSkills).length) {
          try { buildSkillsCache(await fetchAllPages(`/events/${eid}/skills`)); } catch (_) {}
        }
        html = renderSimTab();
        break;
      }
      case 'picklist': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        if (!cachedEventMatches.length) {
          cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
          cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
        }
        if (!Object.keys(cachedEventRankings).length) {
          try { buildRankingsCache(await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`)); } catch (_) {}
        }
        if (!Object.keys(cachedEventSkills).length) {
          try { buildSkillsCache(await fetchAllPages(`/events/${eid}/skills`)); } catch (_) {}
        }
        clearStatus('event-tab');
        el.innerHTML = renderPickList(eid);
        wirePickList(el, eid);
        return;
      }
      case 'draft': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        if (!cachedEventMatches.length) {
          cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
          cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
        }
        if (!Object.keys(cachedEventRankings).length) {
          try { buildRankingsCache(await fetchAllPages(`/events/${eid}/divisions/${did}/rankings`)); } catch (_) {}
        }
        if (!Object.keys(cachedEventSkills).length) {
          try { buildSkillsCache(await fetchAllPages(`/events/${eid}/skills`)); } catch (_) {}
        }
        clearStatus('event-tab');
        el.innerHTML = renderDraftSetup();
        wireDraftSetup(el);
        return;
      }
      case 'awards': {
        // Awards predictions need rankings + skills data — fetch if not already loaded
        const [awardsData, rankData, skillsData] = await Promise.all([
          fetchAllPages(`/events/${eid}/awards`),
          (!did || Object.keys(cachedEventRankings).length)
            ? Promise.resolve(null)
            : fetchAllPages(`/events/${eid}/divisions/${did}/rankings`).catch(() => null),
          Object.keys(cachedEventSkills).length
            ? Promise.resolve(null)
            : fetchAllPages(`/events/${eid}/skills`).catch(() => null),
        ]);
        if (rankData)   buildRankingsCache(rankData);
        if (skillsData) buildSkillsCache(skillsData);
        cachedAwardsData = awardsData;
        clearStatus('event-tab');
        el.innerHTML = renderEventAwards(awardsData);
        attachMatchTabListeners(el);
        // Prior award history disabled (caused API timeouts)
        return; // skip the standard el.innerHTML = html below
      }
      case 'skills': {
        const data = await fetchAllPages(`/events/${eid}/skills`);
        buildSkillsCache(data);
        html = renderEventSkills(data);
        break;
      }
      case 'teams': {
        const data = await fetchAllPages(`/events/${eid}/teams`);
        html = renderEventTeams(data);
        break;
      }
      case 'map': {
        clearStatus('event-tab');
        el.innerHTML = '';
        openMapView(eid);
        return;
      }
    }

    clearStatus('event-tab');
    el.innerHTML = html;

    attachMatchTabListeners(el);

    // Highlight a specific team after rankings load (e.g. navigating from team stats page)
    if (pendingHighlightTeam && activeEventTab === 'rankings') {
      const teamNum = pendingHighlightTeam;
      pendingHighlightTeam = null;
      requestAnimationFrame(() => {
        const row = el.querySelector(`tr[data-num="${CSS.escape(teamNum)}"]`);
        if (row) {
          row.classList.add('row-highlight');
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => row.classList.remove('row-highlight'), 2500);
        }
      });
    }

  } catch (err) {
    setStatus('event-tab', `Error: ${err.message}`, 'error');
  }
}

// ── Event Rankings ─────────────────────────────────────────────────────────
function renderEventRankings(rankings) {
  if (!rankings.length) return '<p class="empty">No rankings available yet.</p>';
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank);
  const rows = sorted.map(r => {
    const cls = r.rank === 1 ? 'gold' : r.rank === 2 ? 'silver' : r.rank === 3 ? 'bronze' : '';
    const pts = [
      r.wp != null ? `WP ${r.wp}` : '',
      r.ap != null ? `AP ${r.ap}` : '',
      r.sp != null ? `SP ${r.sp}` : '',
    ].filter(Boolean).join(' · ');
    return `<tr data-num="${esc(r.team?.name)}">
      <td><span class="rank-badge ${cls}">#${r.rank}</span></td>
      <td><button class="team-link" data-num="${esc(r.team?.name)}">${esc(r.team?.name)}</button>${hasScoutNote(r.team?.name) ? '<span class="scout-dot" title="Has scouting notes">●</span>' : ''}</td>
      <td>${r.wins ?? '—'}–${r.losses ?? '—'}–${r.ties ?? '—'}</td>
      <td style="color:var(--text-muted);font-size:.8rem">${pts || '—'}</td>
      <td>${r.max_score ?? '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Qualification Rankings</div>
      <div class="table-wrap">
        <table><thead><tr>
          <th>Rank</th><th>Team</th><th>W–L–T</th><th>Points</th><th>High Score</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
}

// ── Stream link helper ─────────────────────────────────────────────────────
function streamLink(matchId) {
  if (!currentEvent?.sku) return '';
  const prog = (currentEvent.program?.name || 'VRC').replace(/\s+/g, '');
  const url = 'https://www.robotevents.com/robot-competitions/' + prog + '/' + currentEvent.sku + '.html#tab-livestream';
  return '<a class="stream-link" href="' + url + '" target="_blank" rel="noopener" title="Livestream on RobotEvents" onclick="event.stopPropagation()">▶</a>';
}

// ── Season-level OPR from prior events ────────────────────────────────────
// Fetches up to 3 recent completed events this season for the same program,
// computes combined OPR, and stores in cachedSeasonOPR.
// Falls back to prior-season events at 50% weight if none found.
async function loadSeasonOPR() {
  if (!currentEvent?.season?.id || !currentEvent?.program?.id) return;
  const sid  = currentEvent.season.id;
  const prog = currentEvent.program.id;
  const eid  = currentEvent.id;

  async function fetchEventsOPR(seasonId, weight) {
    try {
      const events = await fetchAllPages(
        `/events?season[]=${seasonId}&program[]=${prog}&per_page=50&status=past`
      );
      // Sort by start date descending; skip the current event
      const recent = events
        .filter(e => e.id !== eid && e.start)
        .sort((a, b) => new Date(b.start) - new Date(a.start))
        .slice(0, 3);

      const allMatches = [];
      await Promise.all(recent.map(async ev => {
        try {
          const divs = ev.divisions || [];
          const divId = divs[0]?.id;
          if (!divId) return;
          const ms = await fetchAllPages(`/events/${ev.id}/divisions/${divId}/matches`);
          allMatches.push(...ms);
        } catch (_) {}
      }));

      if (!allMatches.length) return {};
      const opr = computeOPR(allMatches.filter(m => m.round === 2));
      const result = {};
      for (const [name, vals] of Object.entries(opr)) {
        result[name] = { opr: vals.opr * weight, ccwm: vals.ccwm * weight };
      }
      return result;
    } catch (_) { return {}; }
  }

  // Current season first
  let seasonOPR = await fetchEventsOPR(sid, 1.0);

  // If empty, try prior season (find season id = sid - 1 or look up via API)
  if (!Object.keys(seasonOPR).length) {
    try {
      const seasons = await fetchAllPages(`/seasons?program[]=${prog}&per_page=20`);
      const sorted  = seasons.sort((a, b) => b.id - a.id);
      const idx     = sorted.findIndex(s => s.id === sid);
      if (idx >= 0 && idx + 1 < sorted.length) {
        seasonOPR = await fetchEventsOPR(sorted[idx + 1].id, 0.5);
      }
    } catch (_) {}
  }

  cachedSeasonOPR = seasonOPR;
}

// ── Multi-stat prediction model ────────────────────────────────────────────

// Per-team score history from completed qual matches (for consistency + form).
function teamAllianceScores(name) {
  return cachedEventMatches
    .filter(m => m.round === 2 && matchIsScored(m))
    .sort((a, b) => a.matchnum - b.matchnum)
    .flatMap(m => {
      const a = (m.alliances || []).find(al => (al.teams || []).some(t => t.team?.name === name));
      return a?.score != null ? [a.score] : [];
    });
}

// Build a normalized [0,1] stat block for every team in the current event.
// Each dimension is min-max scaled within the field so weights are comparable.
// Only includes teams actually in this event (not season-OPR teams from other events).
function buildTeamStatCache() {
  // Collect every team seen in this event's data
  const teamSet = new Set([
    ...Object.keys(cachedOPR),
    ...Object.keys(cachedEventRankings),
    ...cachedEventMatches.flatMap(m =>
      (m.alliances || []).flatMap(a =>
        (a.teams || []).map(t => t.team?.name).filter(Boolean)
      )
    ),
  ]);
  if (!teamSet.size) return {};

  const raw = {};
  for (const name of teamSet) {
    const o   = cachedOPR[name] || {};
    const sn  = cachedSeasonOPR[name];
    const snO = sn != null ? (typeof sn === 'object' ? sn.opr : sn) : null;
    const snC = sn != null && typeof sn === 'object' ? sn.ccwm : null;

    const opr  = (o.opr >= 2 ? o.opr : null) ?? snO ?? 0;
    const ccwm = (o.opr >= 2 ? o.ccwm : null) ?? snC ?? 0;
    const dpr  = (o.opr >= 2 ? o.dpr  : null) ?? (opr - ccwm);

    const wr      = cachedEventRankings[name]?.winRate ?? 0.5;
    const skills  = cachedEventSkills[name]?.combined ?? 0;

    const scores  = teamAllianceScores(name);
    const mean    = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : opr;
    const form    = scores.length
      ? (() => {
          const last = scores.slice(-5);
          const ws = last.reduce((s, v, i) => s + v * (i + 1), 0);
          const wt = last.reduce((s, _, i) => s + (i + 1), 0);
          return ws / wt;
        })()
      : mean;
    const consist = scores.length >= 2
      ? (() => {
          const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
          const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
          return Math.max(0, 1 - cv); // higher = more consistent
        })()
      : 0.5;

    raw[name] = { opr, ccwm, dpr, wr, skills, form, consist };
  }

  // Min-max normalize each stat across all teams in this event
  const teams  = Object.keys(raw);
  const minMax = {};
  for (const key of ['opr', 'ccwm', 'dpr', 'skills', 'form']) {
    const vals = teams.map(n => raw[n][key]).filter(isFinite);
    minMax[key] = { min: Math.min(...vals), max: Math.max(...vals) };
  }

  const norm = {};
  for (const name of teams) {
    const r = raw[name];
    const n01 = (key, invert = false) => {
      const { min, max } = minMax[key];
      const v = max > min ? (r[key] - min) / (max - min) : 0.5;
      return invert ? 1 - v : v;
    };
    norm[name] = {
      opr_n:    n01('opr'),
      ccwm_n:   n01('ccwm'),
      dpr_n:    n01('dpr', true), // lower DPR = better defence
      wr:       Math.max(0, Math.min(1, r.wr)),
      skills_n: n01('skills'),
      form_n:   n01('form'),
      consist_n: Math.max(0, Math.min(1, r.consist)),
    };
  }
  return norm;
}

// Multi-stat strength score for a single team (higher = stronger).
// Uses the 7 tunable weights in predTuning.
function teamStrength(name, cache) {
  const s = cache[name];
  if (!s) return 0; // unknown team
  const t = predTuning;
  return t.wOPR * s.opr_n + t.wCCWM * s.ccwm_n + t.wDPR * s.dpr_n
       + t.wWR  * s.wr    + t.wSkills * s.skills_n
       + t.wConsist * s.consist_n + t.wForm * s.form_n;
}

// Lazy cache — rebuilt automatically when event data changes (_predStatCache = null)
function getPredStatCache() {
  if (!_predStatCache) _predStatCache = buildTeamStatCache();
  return _predStatCache;
}

// ── Effective OPR: current event → season fallback → H2H cache → proxy ─────
function effectiveOPR(name) {
  const entry = cachedOPR[name];
  if (entry?.opr != null && entry.opr >= 2) return entry.opr;
  const s = cachedSeasonOPR[name];
  if (s != null) {
    const val = typeof s === 'object' ? s.opr : s;
    if (val > 0) return val;
  }
  // Use H2H season data when available (computed from average match scores, reliable)
  const h2h = h2hTeamData[name];
  if (h2h?.opr > 2) return h2h.opr;

  // Proxy: rankings/skills strength scaled to event or season OPR magnitude
  const hasRank = Object.keys(cachedEventRankings).length > 0;
  const hasSk   = Object.keys(cachedEventSkills).length > 0;
  const wR = hasRank ? predWeights.ranking : 0;
  const wS = hasSk   ? predWeights.skills  : 0;
  const wT = wR + wS;
  let str = 0.5;
  if (wT > 0) {
    str = 0;
    if (wR > 0) str += (cachedEventRankings[name]?.winRate ?? 0.5) * wR;
    if (wS > 0) str += (cachedEventSkills[name]?.normalized  || 0) * wS;
    str = Math.max(0.2, str / wT);
  }
  const allOPRVals = Object.values(cachedOPR).map(o => o.opr).filter(v => v > 0);
  const hasOPRData = allOPRVals.length > 0;
  const maxOPR     = hasOPRData ? Math.max(...allOPRVals) : 1;
  const seasonVals = Object.values(cachedSeasonOPR).map(s => typeof s === 'object' ? s.opr : s).filter(v => v > 0);
  // Also include H2H OPR values as a baseline reference
  const h2hVals = Object.values(h2hTeamData).map(d => d.opr).filter(v => v > 2);
  const allSeasonVals = [...seasonVals, ...h2hVals];
  const hasSeasonOPR = allSeasonVals.length > 0;
  const maxSeasonOPR = hasSeasonOPR ? Math.max(...allSeasonVals) : 1;
  const BASELINE     = hasSeasonOPR ? maxSeasonOPR : 30;
  return str * (hasOPRData ? maxOPR : BASELINE);
}

function effectiveStrength(name) {
  const cache = getPredStatCache();
  if (cache[name]) return Math.max(0.01, teamStrength(name, cache));
  // fallback when cache has no entry for this team
  const entry = cachedOPR[name];
  if (entry?.opr >= 2) return Math.max(1, entry.opr + (predTuning.wCCWM ?? 0.3) * entry.ccwm);
  const s = cachedSeasonOPR[name];
  if (s != null) {
    if (typeof s === 'object' && s.ccwm != null)
      return Math.max(1, s.opr + (predTuning.wCCWM ?? 0.3) * s.ccwm);
    const val = typeof s === 'object' ? s.opr : s;
    if (val > 0) return val;
  }
  return effectiveOPR(name);
}

// Compute typical score standard deviation from scored event matches.
// Used to calibrate Gaussian noise in the simulation.
function eventScoreStdDev() {
  const scored = cachedEventMatches.filter(
    m => m.round === 2 && matchIsScored(m)
  );
  if (scored.length < 4) return 15; // default: ±15 pts before enough data
  const scores = [];
  for (const m of scored) {
    const red  = (m.alliances || []).find(a => a.color === 'red');
    const blue = (m.alliances || []).find(a => a.color === 'blue');
    if (red && blue) { scores.push(red.score, blue.score); }
  }
  if (scores.length < 4) return 15;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
  // Use 45% of the raw std dev — we want noise around the *prediction*, not raw spread
  return Math.max(5, Math.sqrt(variance) * 0.45);
}

// Box-Muller transform: returns one standard-normal sample
function randn() {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Match prediction ───────────────────────────────────────────────────────
// Score predicted via OPR sums. Win direction + confidence via multi-stat model.
// Accepts an optional prebuilt stat cache (used by auto-tuner to avoid rebuilds).
function predictMatch(m, _cache) {
  const alliances = m.alliances || [];
  const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
  const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};
  const redTeams  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
  const blueTeams = (blue.teams || []).map(t => t.team?.name).filter(Boolean);
  if (!redTeams.length || !blueTeams.length) return null;

  // OPR sums → predicted scores (OPR is purpose-built for score prediction)
  const oprRed  = redTeams.reduce((s, n)  => s + effectiveOPR(n), 0);
  const oprBlue = blueTeams.reduce((s, n) => s + effectiveOPR(n), 0);
  if (oprRed + oprBlue <= 0) return null;

  // Multi-stat strength → win direction + confidence
  const cache   = _cache ?? getPredStatCache();
  const strRed  = redTeams.reduce((s, n)  => s + teamStrength(n, cache), 0);
  const strBlue = blueTeams.reduce((s, n) => s + teamStrength(n, cache), 0);
  const total   = strRed + strBlue;

  // Fallback when multi-stat cache has no data yet: use OPR for direction only
  if (total <= 0) {
    const winner = oprRed > oprBlue ? 'red' : oprBlue > oprRed ? 'blue' : 'tie';
    return {
      redScore: Math.max(0, Math.round(oprRed)),
      blueScore: Math.max(0, Math.round(oprBlue)),
      winner,
      confidence: 55,
    };
  }

  const diff = Math.abs(strRed - strBlue);
  const ts    = predTuning.tanhScale > 0 ? predTuning.tanhScale : 0.22;
  const noise = Math.max(0, Math.min(0.5, predTuning.noise ?? 0.05));

  // Base win probability (0.5 = toss-up, 0.87 = highly confident)
  const baseProb = 0.5 + 0.45 * Math.tanh(diff / (total * ts));
  // Noise flattens the probability toward 0.5 (DC, stuck bot = random outcome)
  const adjProb  = (1 - noise) * baseProb + noise * 0.5;
  const confidence = Math.min(87, Math.round(adjProb * 100));

  return {
    redScore:  Math.max(0, Math.round(oprRed)),
    blueScore: Math.max(0, Math.round(oprBlue)),
    winner:    strRed > strBlue ? 'red' : strBlue > strRed ? 'blue' : 'tie',
    confidence,
  };
}

// ── Prediction weights panel ───────────────────────────────────────────────
// Computes live accuracy on played matches given current predTuning.
function computeLiveAccuracy() {
  const played = cachedEventMatches.filter(m => m.round === 2 && matchIsScored(m));
  if (!played.length) return null;
  const cache = getPredStatCache();
  let correct = 0, total = 0;
  for (const m of played) {
    const pred = predictMatch(m, cache);
    if (!pred) continue;
    const all = m.alliances || [];
    const red  = all.find(a => a.color === 'red');
    const blue = all.find(a => a.color === 'blue');
    if (!red || !blue || red.score == null || blue.score == null) continue;
    const actual = red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie';
    if (pred.winner === actual) correct++;
    total++;
  }
  return total > 0 ? { pct: Math.round(correct / total * 100), n: total } : null;
}

function renderPredWeightsPanel() {
  const on  = showMatchPredictions;
  const t   = predTuning;

  // Tuning sliders: key, label, max value (all weights 0-2, tanhScale 0-0.5)
  const TUNE_ROWS = [
    { key: 'wOPR',      label: 'OPR',          max: 2.0, step: 0.05 },
    { key: 'wCCWM',     label: 'CCWM',          max: 2.0, step: 0.05 },
    { key: 'wDPR',      label: 'Defence (DPR)', max: 2.0, step: 0.05 },
    { key: 'wWR',       label: 'Win Rate',      max: 2.0, step: 0.05 },
    { key: 'wSkills',   label: 'Skills',        max: 2.0, step: 0.05 },
    { key: 'wConsist',  label: 'Consistency',   max: 1.0, step: 0.05 },
    { key: 'wForm',     label: 'Recent Form',   max: 2.0, step: 0.05 },
    { key: 'tanhScale', label: 'Curve Width',   max: 0.5,  step: 0.01 },
    { key: 'noise',     label: 'Match Noise',   max: 0.5,  step: 0.01 },
  ];

  const liveAcc = computeLiveAccuracy();
  const accBadge = liveAcc
    ? '<span class="tune-live-acc" id="tune-live-acc">' + liveAcc.pct + '% on ' + liveAcc.n + ' matches</span>'
    : '<span class="tune-live-acc" id="tune-live-acc" style="display:none"></span>';

  const tuningRows = TUNE_ROWS.map(r => {
    const val = t[r.key] ?? PRED_TUNING_DEFAULTS[r.key];
    const pct = Math.round((val / r.max) * 100);
    return '<div class="tune-row">' +
      '<label class="tune-row-label">' + r.label + '</label>' +
      '<input type="range" class="tune-slider" min="0" max="' + r.max + '" step="' + r.step + '" value="' + val + '" ' +
        'data-tunekey="' + r.key + '" data-max="' + r.max + '" />' +
      '<span class="tune-row-val" id="tuneval-' + r.key + '">' + val.toFixed(2) + '</span>' +
      '<div class="tune-row-bar"><div class="tune-row-fill" id="tunefill-' + r.key + '" style="width:' + pct + '%"></div></div>' +
      '</div>';
  }).join('');

  return '<div class="complex-only"><div class="pred-controls-bar">' +
    '<button id="pred-show-toggle" class="pred-toggle-btn' + (on ? ' active' : '') + '">Show Predictions</button>' +
    '<button class="pred-weights-toggle" id="pred-weights-toggle">⚙ Weights ' + accBadge + ' <span class="pred-chevron">▼</span></button>' +
    '<button class="pred-toggle-btn pred-autotune-btn" id="pred-autotune-btn" title="Coordinate-descent over 7 stats · 4 passes">🧪 Auto-Tune</button>' +
    '<button class="pred-toggle-btn" id="pred-reset-btn" title="Reset to defaults">↺ Reset</button>' +
    '</div>' +
    '<div class="pred-weights-body hidden" id="pred-weights-body">' +
    '<div class="tune-section-title">Prediction stat weights <span class="tune-live-inline" id="tune-live-inline">' +
      (liveAcc ? liveAcc.pct + '% accuracy (' + liveAcc.n + ' played)' : 'Load matches to see accuracy') +
    '</span></div>' +
    tuningRows +
    '<div id="autotune-result"></div>' +
    '</div></div>';
}

// ── Matches ────────────────────────────────────────────────────────────────
function renderMatches(matches) {
  if (!matches.length) return '<p class="empty">No match data available yet.</p>';

  const groups = {};
  matches.forEach((m, i) => {
    const label = ROUND_NAMES[m.round] || `Round ${m.round}`;
    (groups[label] = groups[label] || []).push({ ...m, _idx: i });
  });

  const roundOrder = ['Practice', 'Qualifications', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Finals'];
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ai = roundOrder.indexOf(a), bi = roundOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return sortedKeys.map(roundName => {
    const sorted = [...groups[roundName]].sort((a, b) =>
      a.instance - b.instance || a.matchnum - b.matchnum);

    const rows = sorted.map(m => {
      const alliances = m.alliances || [];
      const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
      const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};

      const redTeamLinks  = (red.teams  || []).map(t =>
        '<button class="team-link td-red" data-num="' + esc(t.team?.name || '') + '">' + esc(t.team?.name || '?') + '</button>').join(' ');
      const blueTeamLinks = (blue.teams || []).map(t =>
        '<button class="team-link td-blue" data-num="' + esc(t.team?.name || '') + '">' + esc(t.team?.name || '?') + '</button>').join(' ');

      const hasScore = matchIsScored(m);
      const redWon   = hasScore && red.score  > blue.score;
      const blueWon  = hasScore && blue.score > red.score;

      const matchId = m.round === 2 ? 'Q' + m.matchnum
        : m.round === 1 ? 'P' + m.matchnum
        : m.instance + '-' + m.matchnum;

      const pred = predictMatch(m);

      // Score cells: always show actual score when available
      let dispRed, dispBlue, predBadge = '';
      if (hasScore) {
        dispRed  = '<strong class="' + (redWon  ? 'td-score-red'  : 'td-score-muted') + '">' + red.score  + '</strong>';
        dispBlue = '<strong class="' + (blueWon ? 'td-score-blue' : 'td-score-muted') + '">' + blue.score + '</strong>';
        if (showMatchPredictions && pred) {
          const actualWinner = redWon ? 'red' : blueWon ? 'blue' : 'tie';
          const correct = pred.winner === actualWinner;
          predBadge = ' <span class="pred-inline ' + (correct ? 'pred-correct' : 'pred-wrong') + '">' +
            (correct ? '✓' : '✗') + ' ' + pred.confidence + '%</span>';
        }
      } else if (pred) {
        const rs = pred.redScore !== null ? '~' + pred.redScore : '';
        const bs = pred.blueScore !== null ? '~' + pred.blueScore : '';
        dispRed  = '<span class="pred-score ' + (pred.winner === 'red'  ? 'td-pred-red'  : '') + '">' + (rs || '–') + '</span>';
        dispBlue = '<span class="pred-score ' + (pred.winner === 'blue' ? 'td-pred-blue' : '') + '">' + (bs || '–') + '</span>';
        predBadge = ' <span class="pred-inline">' + pred.confidence + '%</span>';
      } else {
        dispRed  = '—';
        dispBlue = '—';
      }

      return '<tr class="match-row" data-idx="' + m._idx + '">' +
        '<td class="match-id-cell">' + matchId + ' ' + streamLink(matchId) + '</td>' +
        '<td class="td-red-teams">' + (redTeamLinks || '—') + '</td>' +
        '<td class="td-score">' + dispRed + '</td>' +
        '<td class="match-vs">–' + predBadge + '</td>' +
        '<td class="td-score">' + dispBlue + '</td>' +
        '<td class="td-blue-teams">' + (blueTeamLinks || '—') + '</td>' +
        '<td class="match-chevron">›</td>' +
        '</tr>';
    }).join('');

    return '<div class="stats-section">' +
      '<div class="section-title">' + roundName + '</div>' +
      '<div class="table-wrap">' +
      '<table class="match-table">' +
      '<thead><tr>' +
      '<th>Match</th>' +
      '<th class="th-red">Red Alliance</th>' +
      '<th class="th-red">Score</th>' +
      '<th></th>' +
      '<th class="th-blue">Score</th>' +
      '<th class="th-blue">Blue Alliance</th>' +
      '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }).join('');
}

// ── Match detail expand / collapse ─────────────────────────────────────────
function toggleMatchDetail(row) {
  const existing = document.querySelector('.match-detail-row');
  const wasThis  = existing && existing.previousElementSibling === row;

  // Always clean up first
  if (existing) existing.remove();
  document.querySelectorAll('.match-row.active').forEach(r => r.classList.remove('active'));

  if (wasThis) return; // toggle off

  row.classList.add('active');
  const m = cachedEventMatches[+row.dataset.idx];
  if (!m) return;

  const detailRow = document.createElement('tr');
  detailRow.className = 'match-detail-row';
  detailRow.innerHTML = `<td colspan="7">${matchDetailHTML(m)}</td>`;
  row.after(detailRow);

  // Wire team links inside the new detail row
  detailRow.querySelectorAll('.team-link[data-num]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const num = btn.dataset.num;
      if (!num || num === 'undefined') return;
      openTeamEventView(num);
    });
  });
}

function buildPredPanel(pred, actualWinner) {
  const favored = pred.winner === 'tie' ? 'Too close to call'
    : (pred.winner.charAt(0).toUpperCase() + pred.winner.slice(1)) + ' alliance favored';
  const scoreStr = pred.redScore !== null && pred.blueScore !== null
    ? '<div class="prediction-scores">' +
      '<span class="' + (pred.winner === 'red' ? 'td-score-red' : 'td-red') + '" style="font-weight:700">Red ~' + pred.redScore + '</span>' +
      '<span style="color:var(--text-muted)"> vs </span>' +
      '<span class="' + (pred.winner === 'blue' ? 'td-score-blue' : 'td-blue') + '" style="font-weight:700">Blue ~' + pred.blueScore + '</span>' +
      '</div>'
    : '';
  let accuracy = '';
  if (actualWinner !== null) {
    const correct = pred.winner === actualWinner;
    accuracy = ' · <span class="' + (correct ? 'pred-correct' : 'pred-wrong') + '">' +
      (correct ? '✓ Prediction correct' : '✗ Prediction incorrect') + '</span>';
  }
  return '<div class="prediction-panel">' +
    '<div class="prediction-header">Prediction' + accuracy + '</div>' +
    scoreStr +
    '<div class="confidence-bar-wrap">' +
    '<div class="confidence-bar"><div class="confidence-bar-fill" style="width:' + pred.confidence + '%"></div></div>' +
    '<span class="confidence-label">' + pred.confidence + '% confidence · ' + favored + '</span>' +
    '</div></div>';
}

function matchDetailHTML(m) {
  const alliances = m.alliances || [];
  const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
  const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};

  const redNames  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
  const blueNames = (blue.teams || []).map(t => t.team?.name).filter(Boolean);
  const allTeams  = [
    ...redNames.map(n  => ({ name: n, color: 'red'  })),
    ...blueNames.map(n => ({ name: n, color: 'blue' })),
  ];

  const hasScore = matchIsScored(m);
  const pred = (showMatchPredictions || !hasScore) ? predictMatch(m) : null;
  const scoreStr = hasScore
    ? `<span class="td-red" style="font-weight:700">${red.score}</span>
       <span style="color:var(--text-muted);margin:0 4px">–</span>
       <span class="td-blue" style="font-weight:700">${blue.score}</span>`
    : '<span style="color:var(--text-muted)">Unscored</span>';

  const matchId = m.round === 2 ? `Q${m.matchnum}`
    : m.round === 1 ? `P${m.matchnum}`
    : `${ROUND_NAMES[m.round] || 'Match'} ${m.instance}-${m.matchnum}`;

  const hasOPR = Object.keys(cachedOPR).length > 0;
  const fmt = v => (v != null && isFinite(v)) ? v.toFixed(2) : '—';

  const teamRows = allTeams.map(({ name, color }) => {
    const s = cachedOPR[name] || {};
    const ccwmStyle = s.ccwm > 0 ? 'color:var(--accent)' : s.ccwm < 0 ? 'color:#B91C1C' : '';
    return `<tr>
      <td><button class="team-link" data-num="${esc(name)}">${esc(name)}</button></td>
      <td class="${color === 'red' ? 'td-red' : 'td-blue'}" style="font-weight:600">${color === 'red' ? 'Red' : 'Blue'}</td>
      <td class="opr-cell">${fmt(s.opr)}</td>
      <td class="opr-cell">${fmt(s.dpr)}</td>
      <td class="opr-cell" style="${ccwmStyle};font-weight:700">${fmt(s.ccwm)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="match-detail">
      <div class="match-detail-header">
        <span class="match-detail-id">${esc(matchId)}</span>
        <span class="match-detail-score">${scoreStr}</span>
      </div>
      <table class="match-detail-table">
        <thead><tr>
          <th>Team</th><th>Alliance</th>
          <th class="opr-head">OPR</th>
          <th class="opr-head">DPR</th>
          <th class="opr-head">CCWM</th>
        </tr></thead>
        <tbody>${teamRows}</tbody>
      </table>
      <p class="match-detail-note">
        ${hasOPR
          ? 'OPR / DPR / CCWM via recency-weighted least-squares. CCWM (win margin contribution) drives win probability; OPR drives score prediction.'
          : 'No scored qualification matches yet — OPR cannot be calculated.'}
      </p>
      ${pred ? buildPredPanel(pred, hasScore ? (red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie') : null) : ''}
      ${renderPredEvolutionChart(computePredictionHistory(m))}
    </div>`;
}

// ── AWP rate from actual match data ───────────────────────────────────────
// Recomputes base WP (wins×2 + ties×1) from every scored qual match we have,
// then subtracts from the API's r.wp to get exact AWPs earned per team.
// This is more reliable than trusting r.wins/r.losses/r.ties from the API.
function computeAWPRates() {
  const scored = cachedEventMatches.filter(
    m => m.round === 2 && matchIsScored(m)
  );

  const baseWP = {}, played = {};
  for (const m of scored) {
    const red  = (m.alliances || []).find(a => a.color === 'red');
    const blue = (m.alliances || []).find(a => a.color === 'blue');
    if (!red || !blue) continue;
    const redNames  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
    const blueNames = (blue.teams || []).map(t => t.team?.name).filter(Boolean);
    const winner = red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie';
    for (const n of redNames) {
      baseWP[n] = (baseWP[n] || 0) + (winner === 'red' ? 2 : winner === 'tie' ? 1 : 0);
      played[n] = (played[n] || 0) + 1;
    }
    for (const n of blueNames) {
      baseWP[n] = (baseWP[n] || 0) + (winner === 'blue' ? 2 : winner === 'tie' ? 1 : 0);
      played[n] = (played[n] || 0) + 1;
    }
  }

  // Per-team AWP rate = (actual WP − base WP) / matches played
  let totalRate = 0, rateCount = 0;
  const perTeam = {};
  for (const [name, r] of Object.entries(cachedEventRankings)) {
    const n = played[name] || 0;
    if (n === 0) continue;
    const awps = Math.max(0, (r.wp || 0) - (baseWP[name] || 0));
    const rate = Math.min(1, awps / n);
    perTeam[name] = rate;
    totalRate += rate;
    rateCount++;
  }

  const fieldRate = rateCount > 0 ? totalRate / rateCount : 0.15;
  return { perTeam, fieldRate };
}

// ── Rankings Simulation ────────────────────────────────────────────────────

function runRankingSimulation(nSims, fromMatchNum = null) {
  const quals = cachedEventMatches
    .filter(m => m.round === 2)
    .sort((a, b) => a.matchnum - b.matchnum);

  // Build the division team set from the full schedule
  const divTeamNames = new Set();
  for (const m of quals) {
    for (const a of (m.alliances || [])) {
      for (const t of (a.teams || [])) {
        if (t.team?.name) divTeamNames.add(t.team.name);
      }
    }
  }

  // A match is "scored" if both alliances have a real score.
  const scoredNums = new Set(
    quals.filter(m => matchIsScored(m)).map(m => m.matchnum)
  );
  // "Rewound" = the slider is pointing at a match that has already been played.
  // This lets the user replay from any past point — including when the whole event is over.
  const isRewound = fromMatchNum != null && scoredNums.has(fromMatchNum);

  const priorScored = isRewound
    ? quals.filter(m => m.matchnum < fromMatchNum && scoredNums.has(m.matchnum))
    : quals.filter(m => scoredNums.has(m.matchnum));

  // Compute WP, AP, and SP from prior scored matches from scratch
  const wpAccum   = {};
  const apAccum   = {};
  const spAccum   = {};
  const winsAccum = {};
  const lossAccum = {};
  const tiesAccum = {};
  for (const name of divTeamNames) {
    wpAccum[name] = apAccum[name] = spAccum[name] = winsAccum[name] = lossAccum[name] = tiesAccum[name] = 0;
  }

  // Infer AP bonus per match from ranked teams that have played: each team's ap / matches_played
  // The alliance that wins autonomous gets the bonus — on average ~half the matches.
  // So apBonusPerWin ≈ (avgApPerMatch) / 0.5 = avgApPerMatch * 2.
  const apSamples = Object.values(cachedEventRankings).map(r => {
    const played = (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
    return played > 2 ? (r.ap || 0) / played : null;
  }).filter(v => v != null && v > 0);
  const apBonusPerWin = apSamples.length
    ? Math.max(1, Math.round((apSamples.reduce((a, b) => a + b) / apSamples.length) * 2))
    : 3; // default 3 pts (typical VEX bonus)

  for (const m of priorScored) {
    const red  = (m.alliances || []).find(a => a.color === 'red');
    const blue = (m.alliances || []).find(a => a.color === 'blue');
    if (!red || !blue) continue;
    const redNames  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
    const blueNames = (blue.teams || []).map(t => t.team?.name).filter(Boolean);
    const losingScore = Math.min(red.score, blue.score);
    for (const n of [...redNames, ...blueNames]) {
      if (n in spAccum) spAccum[n] += losingScore;
    }
    if (red.score > blue.score) {
      redNames.forEach(n  => { if (n in wpAccum) { wpAccum[n] += 2; winsAccum[n]++; } });
      blueNames.forEach(n => { if (n in wpAccum) lossAccum[n]++; });
    } else if (blue.score > red.score) {
      blueNames.forEach(n => { if (n in wpAccum) { wpAccum[n] += 2; winsAccum[n]++; } });
      redNames.forEach(n  => { if (n in wpAccum) lossAccum[n]++; });
    } else {
      for (const n of [...redNames, ...blueNames]) {
        if (n in wpAccum) { wpAccum[n] += 1; tiesAccum[n]++; }
      }
    }
  }

  // AWP rates computed directly from actual match outcomes vs API WP totals
  const { perTeam: awpRates, fieldRate: fieldAwpRate } = computeAWPRates();

  const teams = {};
  for (const name of divTeamNames) {
    // Use per-team rate if available (derived from real match data), else field average.
    // Per-team rate applies in both rewound and normal modes — a team's AWP tendency
    // doesn't change depending on which point in the event we're simulating from.
    const awpRate = awpRates[name] ?? fieldAwpRate;
    // When not rewound, seed directly from API rankings (includes real AWP already earned).
    // When rewound, estimate AWP earned in prior matches using the field average rate.
    // AWP is independent of match outcome — earned in ANY match (wins, losses, ties alike).
    if (!isRewound && cachedEventRankings[name]) {
      const r = cachedEventRankings[name];
      teams[name] = { wp: r.wp || 0, ap: r.ap || 0, sp: r.sp || 0, awpRate,
        priorWins: r.wins, priorLosses: r.losses, priorTies: r.ties };
    } else {
      const priorMatches   = winsAccum[name] + lossAccum[name] + tiesAccum[name];
      const estimatedAwpWP = Math.round(priorMatches * awpRate);
      teams[name] = {
        wp: (wpAccum[name] || 0) + estimatedAwpWP,
        ap: apAccum[name] || 0,
        sp: spAccum[name] || 0,
        awpRate,
        priorWins: winsAccum[name], priorLosses: lossAccum[name], priorTies: tiesAccum[name],
      };
    }
  }

  // Matches to simulate:
  //   Rewound  → re-play everything from fromMatchNum onward using predictions
  //              (includes already-scored matches; we treat them as counterfactual)
  //   Normal   → only the remaining unscored matches
  const toSim = isRewound
    ? quals.filter(m => m.matchnum >= fromMatchNum)
    : quals.filter(m => !scoredNums.has(m.matchnum));

  const rankSums   = {};
  const wpSums     = {};
  const rankCounts = {};
  const winSums    = {};
  const lossSums   = {};
  const tieSums    = {};
  for (const name of Object.keys(teams)) {
    rankSums[name] = wpSums[name] = winSums[name] = lossSums[name] = tieSums[name] = 0;
    rankCounts[name] = {};
  }

  const numTeams      = Object.keys(teams).length;
  const playoffCutoff = Math.min(16, Math.max(4, Math.floor(numTeams * 0.3)));

  // Calibrate score noise from actual event data: each simulated match samples
  // predicted scores + Gaussian noise → winner determined by score comparison.
  // This lets win probability and tie rate emerge naturally from score distributions
  // instead of relying on hard-coded confidence thresholds.
  const scoreStdDev = eventScoreStdDev();

  // Pre-compute predictions outside the sim loop (they don't change per simulation)
  const matchPreds = toSim.map(m => ({ m, pred: predictMatch(m) })).filter(x => x.pred);

  for (let sim = 0; sim < nSims; sim++) {
    const simTeams = {};
    for (const [n, t] of Object.entries(teams)) {
      simTeams[n] = { wp: t.wp, ap: t.ap, sp: t.sp, awpRate: t.awpRate };
    }

    for (const { m, pred } of matchPreds) {
      const alliances = m.alliances || [];
      const red  = alliances.find(a => a.color === 'red')  || alliances[0];
      const blue = alliances.find(a => a.color === 'blue') || alliances[1];
      if (!red || !blue) continue;

      const redNames  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
      const blueNames = (blue.teams || []).map(t => t.team?.name).filter(Boolean);

      // Sample scores from a Gaussian centred on the OPR prediction.
      // Win probability and tie rate emerge naturally — no hard-coded numbers.
      const noiseFactor = 1 + (predTuning.noise ?? 0.05) * 4;
      const simRed  = Math.max(0, Math.round(pred.redScore  + randn() * scoreStdDev * noiseFactor));
      const simBlue = Math.max(0, Math.round(pred.blueScore + randn() * scoreStdDev * noiseFactor));
      const winner  = simRed > simBlue ? 'red' : simBlue > simRed ? 'blue' : 'tie';

      // SP = the losing alliance's actual simulated score (correct VEX rule)
      const loserSP = winner === 'red' ? simBlue : winner === 'blue' ? simRed : simRed;
      for (const n of [...redNames, ...blueNames]) {
        if (simTeams[n]) simTeams[n].sp += loserSP;
      }

      // AP tiebreaker: award autonomous bonus to the alliance that wins the autonomous period.
      // Probability weighted by relative alliance strength (stronger alliance more likely to win auto).
      const strRed  = redNames.reduce((s, n)  => s + effectiveStrength(n), 0) || 1;
      const strBlue = blueNames.reduce((s, n) => s + effectiveStrength(n), 0) || 1;
      const autoWinner = Math.random() < strRed / (strRed + strBlue) ? 'red' : 'blue';
      const apNames = autoWinner === 'red' ? redNames : blueNames;
      for (const n of apNames) { if (simTeams[n]) simTeams[n].ap += apBonusPerWin; }

      // AWP is earned by completing the autonomous objective — independent of match outcome.
      // Either alliance can earn AWP even if they lose the overall match.
      const redAWP  = Math.random() < (simTeams[redNames[0]]?.awpRate  ?? fieldAwpRate);
      const blueAWP = Math.random() < (simTeams[blueNames[0]]?.awpRate ?? fieldAwpRate);

      if (winner === 'red') {
        for (const n of redNames)  { if (simTeams[n]) { simTeams[n].wp += 2 + (redAWP  ? 1 : 0); } }
        for (const n of blueNames) { if (simTeams[n]) { simTeams[n].wp += 0 + (blueAWP ? 1 : 0); } }
        redNames.forEach(n  => { if (winSums[n]  != null) winSums[n]++;  });
        blueNames.forEach(n => { if (lossSums[n] != null) lossSums[n]++; });
      } else if (winner === 'blue') {
        for (const n of blueNames) { if (simTeams[n]) { simTeams[n].wp += 2 + (blueAWP ? 1 : 0); } }
        for (const n of redNames)  { if (simTeams[n]) { simTeams[n].wp += 0 + (redAWP  ? 1 : 0); } }
        blueNames.forEach(n => { if (winSums[n]  != null) winSums[n]++;  });
        redNames.forEach(n  => { if (lossSums[n] != null) lossSums[n]++; });
      } else {
        for (const n of redNames)  { if (simTeams[n]) { simTeams[n].wp += 1 + (redAWP  ? 1 : 0); } }
        for (const n of blueNames) { if (simTeams[n]) { simTeams[n].wp += 1 + (blueAWP ? 1 : 0); } }
        [...redNames, ...blueNames].forEach(n => { if (tieSums[n] != null) tieSums[n]++; });
      }
    }

    // Sort by official VEX tiebreaker order: WP → AP → SP
    const sorted = Object.entries(simTeams)
      .sort(([, a], [, b]) => b.wp - a.wp || b.ap - a.ap || b.sp - a.sp);
    sorted.forEach(([name], i) => {
      const r = i + 1;
      rankSums[name]      = (rankSums[name]  || 0) + r;
      wpSums[name]        = (wpSums[name]    || 0) + simTeams[name].wp;
      rankCounts[name][r] = (rankCounts[name][r] || 0) + 1;
    });
  }

  const playoffProb = name => {
    let c = 0;
    for (let r = 1; r <= playoffCutoff; r++) c += (rankCounts[name][r] || 0);
    return Math.round((c / nSims) * 100);
  };

  return Object.keys(rankSums)
    .map(name => {
      const t = teams[name];
      return {
        name,
        avgRank:    rankSums[name] / nSims,
        avgWP:      +(wpSums[name] / nSims).toFixed(1),
        current:    cachedEventRankings[name] || null,
        rankCounts: rankCounts[name],
        playoffPct: playoffProb(name),
        // Avg simulated record (from start point) + prior played matches
        avgWins:    +(winSums[name] / nSims + t.priorWins).toFixed(1),
        avgLosses:  +(lossSums[name] / nSims + t.priorLosses).toFixed(1),
        avgTies:    +(tieSums[name] / nSims + t.priorTies).toFixed(1),
        numTeams,
        playoffCutoff,
      };
    })
    .sort((a, b) => b.avgWP - a.avgWP || a.avgRank - b.avgRank);
}

function renderSimMatchTable() {
  const quals = cachedEventMatches
    .filter(m => m.round === 2)
    .sort((a, b) => a.matchnum - b.matchnum);
  if (!quals.length) return '';

  const rows = quals.map(m => {
    const alliances = m.alliances || [];
    const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
    const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};
    const pred = predictMatch(m);
    const isPlayed = matchIsScored(m);

    const redTeamStr  = (red.teams  || []).map(t => '<button class="team-link sim-team-link" data-num="' + esc(t.team?.name || '') + '">' + esc(t.team?.name || '?') + '</button>').join(' ');
    const blueTeamStr = (blue.teams || []).map(t => '<button class="team-link sim-team-link" data-num="' + esc(t.team?.name || '') + '">' + esc(t.team?.name || '?') + '</button>').join(' ');

    const rPred = pred?.redScore  != null ? '~' + pred.redScore  : '—';
    const bPred = pred?.blueScore != null ? '~' + pred.blueScore : '—';
    const favRed  = pred?.winner === 'red';
    const favBlue = pred?.winner === 'blue';

    return '<tr class="' + (isPlayed ? 'sim-played-row' : '') + '">' +
      '<td class="match-id-cell">Q' + m.matchnum + (isPlayed ? ' <span class="sim-played-badge">✓</span>' : '') + '</td>' +
      '<td class="td-red-teams">' + redTeamStr + '</td>' +
      '<td class="td-score"><span class="pred-score' + (favRed  ? ' td-pred-red'  : '') + '">' + rPred + '</span></td>' +
      '<td class="match-vs">–</td>' +
      '<td class="td-score"><span class="pred-score' + (favBlue ? ' td-pred-blue' : '') + '">' + bPred + '</span></td>' +
      '<td class="td-blue-teams">' + blueTeamStr + '</td>' +
      '<td class="sim-conf-cell">' + (pred ? pred.confidence + '%' : '') + '</td>' +
      '</tr>';
  }).join('');

  return '<div class="stats-section">' +
    '<div class="section-title">Simulated Match Scores</div>' +
    '<p class="sim-info">Predicted scores for all qual matches — actual results replaced with model predictions. ✓ = already played.</p>' +
    '<div class="table-wrap"><table class="match-table">' +
    '<thead><tr><th>Match</th><th class="th-red">Red</th><th class="th-red">Pred</th>' +
    '<th></th><th class="th-blue">Pred</th><th class="th-blue">Blue</th><th>Conf.</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderSimTab() {
  const quals = cachedEventMatches.filter(m => m.round === 2);
  const unscoredCount = quals.filter(m =>
    !matchIsScored(m)
  ).length;

  if (!quals.length && !Object.keys(cachedEventRankings).length) {
    return '<div class="stats-section"><p class="empty">No match data available for simulation.</p></div>';
  }

  const simOptions = [10, 100, 500, 1000];
  const defaultSim = 100;

  // Build sorted match list for the slider — only scored matches are valid rewind points
  const sortedQuals   = quals.slice().sort((a, b) => a.matchnum - b.matchnum);
  const matchNums     = sortedQuals.map(m => m.matchnum);
  const minMatch      = matchNums[0] || 1;
  const scoredNums    = new Set(
    sortedQuals.filter(m => matchIsScored(m)).map(m => m.matchnum)
  );
  const scoredSorted  = matchNums.filter(n => scoredNums.has(n));
  const lastScoredNum = scoredSorted[scoredSorted.length - 1] ?? minMatch;
  // +1 sentinel = "End (current)": simulate only remaining unscored matches from now
  const sliderMax    = lastScoredNum + 1;
  const defaultStart = sliderMax; // always default to current state

  function simSliderLabel(v) {
    return +v > lastScoredNum ? 'End (current)' : 'Q-' + v;
  }

  const sliderHtml =
    '<div class="sim-slider-row">' +
    '<span class="sim-label">Simulate from:</span>' +
    '<input type="range" id="sim-start-slider" class="sim-slider" ' +
    'min="' + (scoredSorted[0] ?? minMatch) + '" max="' + sliderMax + '" value="' + defaultStart + '" step="1" />' +
    '<span class="sim-slider-label" id="sim-slider-label">' + simSliderLabel(defaultStart) + '</span>' +
    '</div>';

  const controls =
    '<div class="sim-controls">' +
    '<span class="sim-label">Simulations:</span>' +
    simOptions.map(n =>
      '<button class="sim-count-btn' + (n === defaultSim ? ' active' : '') + '" data-n="' + n + '">' + n + '</button>'
    ).join('') +
    '<button class="btn-primary sim-run-btn" id="sim-run-btn">Run Simulation</button>' +
    '</div>';

  const info =
    '<p class="sim-info">' + unscoredCount + ' unscored qual match' + (unscoredCount !== 1 ? 'es' : '') +
    ' remaining · ' + quals.length + ' total quals · Monte Carlo: CCWM-adjusted OPR predictions + score-distribution sampling</p>';

  return '<div class="stats-section">' +
    '<div class="section-title">Predicted Final Rankings</div>' +
    info + sliderHtml + controls +
    '<div id="sim-results"></div>' +
    '</div>';
}

function renderRankBar(rankCounts, nSims, numTeams) {
  let html = '';
  for (let r = 1; r <= numTeams; r++) {
    const frac = (rankCounts[r] || 0) / nSims;
    if (frac < 0.005) continue;
    const hue = Math.round(240 - (r / numTeams) * 240);
    html += '<span style="display:inline-block;width:' + (frac * 100).toFixed(1) +
      '%;height:10px;background:hsl(' + hue + ',70%,50%);flex-shrink:0" title="Rank ' + r + ': ' +
      Math.round(frac * 100) + '%"></span>';
  }
  return '<div class="rank-bar">' + html + '</div>';
}

function renderSimResults(results) {
  if (!results.length) return '<p class="empty">No teams found.</p>';
  const nSims    = results.reduce((s, r) => s + Object.values(r.rankCounts).reduce((a, b) => a + b, 0), 0) / results.length || 1;
  const numTeams = results[0]?.numTeams || results.length;

  const rows = results.map((r, i) => {
    const cur     = r.current;
    const curRank = cur?.rank ?? '—';
    const delta   = cur?.rank != null ? cur.rank - Math.round(r.avgRank) : null;
    const deltaStr = delta === null ? '' : delta > 0
      ? '<span class="rank-up">▲' + delta + '</span>'
      : delta < 0
      ? '<span class="rank-dn">▼' + Math.abs(delta) + '</span>'
      : '<span class="rank-same">–</span>';
    const cls    = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const record = r.avgWins + '-' + r.avgLosses + (r.avgTies > 0 ? '-' + r.avgTies : '');
    return '<tr>' +
      '<td><span class="rank-badge ' + cls + '">#' + (i + 1) + '</span></td>' +
      '<td><button class="team-link" data-num="' + esc(r.name) + '">' + esc(r.name) + '</button></td>' +
      '<td style="color:var(--text-muted)">' + curRank + '</td>' +
      '<td>' + deltaStr + '</td>' +
      '<td style="color:var(--text-muted);font-size:.8rem">' + record + '</td>' +
      '<td style="font-weight:600">' + r.avgWP + '</td>' +
      '<td>' + renderRankBar(r.rankCounts, nSims, numTeams) + '</td>' +
      '</tr>';
  }).join('');

  return '<div class="table-wrap"><table class="sim-results-table">' +
    '<thead><tr><th>Pred.</th><th>Team</th><th>Now</th><th>Δ</th>' +
    '<th>Record</th><th>Avg WP</th><th>Distribution</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// STANDINGS
// ═══════════════════════════════════════════════════════════════════════════

let standingsState = {
  programId: 1,
  seasonId: null,
  availableSeasons: [],  // [{ id, name }] for current program
  sort: 'combined',   // 'combined' | 'driver' | 'programming' | 'trueskill'
  grade: 'all',
  country: '',
  region: '',
  data: null,         // processed team array for current program+season
  page: 0,
  search: '',         // team number search query
};
const STANDINGS_PAGE = 100;

// ── Standings cache helpers ────────────────────────────────────────────────
// Processed final result: 12h TTL
function standingsCacheKey(pid, sid) { return `vexskills2_${pid}_${sid}`; }
function readStandingsCache(pid, sid) {
  try {
    const raw = localStorage.getItem(standingsCacheKey(pid, sid));
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts < 12 * 60 * 60 * 1000) return data;
  } catch (_) {}
  return null;
}
function writeStandingsCache(pid, sid, data) {
  try {
    localStorage.setItem(standingsCacheKey(pid, sid), JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {
    try {
      const slim = data.map(t => { const c = { ...t }; delete c.region; delete c.city; return c; });
      localStorage.setItem(standingsCacheKey(pid, sid), JSON.stringify({ ts: Date.now(), data: slim }));
    } catch (_2) {}
  }
}

// Partial progress cache — byTeam dict + how many pages were fetched.
// No TTL: any saved progress beats starting over.
// Written every 20 pages; deleted when final cache is written.
function partialCacheKey(pid, sid) { return `vexskills_partial_${pid}_${sid}`; }
function readPartialCache(pid, sid) {
  try { return JSON.parse(localStorage.getItem(partialCacheKey(pid, sid)) || 'null'); } catch (_) { return null; }
}
function writePartialCache(pid, sid, byTeam, doneNums) {
  const payload = { byTeam, doneNums };
  try {
    localStorage.setItem(partialCacheKey(pid, sid), JSON.stringify(payload));
  } catch (_) {
    try {
      const slim = {};
      for (const [k, t] of Object.entries(byTeam)) { slim[k] = { ...t }; delete slim[k].city; delete slim[k].region; }
      localStorage.setItem(partialCacheKey(pid, sid), JSON.stringify({ byTeam: slim, doneNums }));
    } catch (_2) {}
  }
}

// Convert byTeam accumulator to the final result array.
// Only includes teams that have posted at least one skills score this season.
function buildSkillsResult(byTeam) {
  return Object.values(byTeam)
    .filter(t => t.driver > 0 || t.programming > 0)
    .map(t => ({ ...t, combined: t.driver + t.programming, trueSkill: 0 }));
}

// ── TrueSkill: composite rating from skills, awards, rank, win rate ────────
// Populated lazily when the user selects TrueSkill sort.
const trueSkillCache = {};   // teamNumber → { awardsScore, avgRank, winRate, eventsPlayed }
let   trueSkillLoading = false;

// Award title → weight. Excellence outweighs everything; tournament wins count too.
const AWARD_WEIGHTS = [
  [/excellence/i,           3.0],
  [/tournament.champion|champion/i, 2.5],
  [/skills.champion/i,      2.0],
  [/design|think|innovate|build|inspire/i, 1.5],
];
function awardWeight(title) {
  for (const [re, w] of AWARD_WEIGHTS) if (re.test(title)) return w;
  return 1.0;
}

function computeTrueSkill(t, maxCombined) {
  const skillsScore = maxCombined > 0 ? t.combined / maxCombined : 0;
  const ts = trueSkillCache[t.number];
  if (!ts) return +(skillsScore * 3.5).toFixed(2); // provisional until data loads

  // Awards: weighted awards per event, normalized — 1 excellence/event = 1.0
  const awardsNorm = Math.min(ts.awardsScore / 3, 1);
  // Rank: 1/sqrt(avgRank) — rank 1 = 1.0, rank 4 = 0.5, rank 9 = 0.33
  const rankNorm   = ts.avgRank > 0 ? Math.min(1, 1 / Math.sqrt(ts.avgRank)) : 0;
  const winNorm    = ts.winRate;

  // Scale 0–10 with 2 decimal places so differences feel tighter
  return +(10 * (skillsScore * 0.35 + awardsNorm * 0.25 + rankNorm * 0.25 + winNorm * 0.15)).toFixed(2);
}

async function loadTrueSkillData() {
  if (trueSkillLoading) return;
  const data = standingsState.data;
  const sid  = standingsState.seasonId;
  if (!data?.length || !sid) return;

  const needed = data.filter(t => t.teamId && !trueSkillCache[t.number]);
  if (!needed.length) {
    _recomputeAndRender();
    return;
  }

  trueSkillLoading = true;
  let done = 0;
  const total = needed.length;
  let timer = null;

  function scheduleRender() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      setStandingsStatus(`Rating: ${done.toLocaleString()} / ${total.toLocaleString()} teams loaded`, done, total);
      _recomputeAndRender();
    }, 300);
  }

  await promisePool(needed.map(t => async () => {
    try {
      const [awJson, rkJson] = await Promise.all([
        apiFetch(`/teams/${t.teamId}/awards?season[]=${sid}`),
        apiFetch(`/teams/${t.teamId}/rankings?season[]=${sid}`),
      ]);
      const awards   = awJson.data  || [];
      const rankings = rkJson.data  || [];

      // Awards score = sum of weights / events played
      const awardSum = awards.reduce((s, a) => s + awardWeight(a.title || ''), 0);
      const eventsPlayed = rankings.length;

      let totalRank = 0, wins = 0, matches = 0;
      for (const r of rankings) {
        totalRank += r.rank || 0;
        wins      += r.wins || 0;
        matches   += (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
      }

      trueSkillCache[t.number] = {
        awardsScore:  eventsPlayed > 0 ? awardSum / eventsPlayed : 0,
        avgRank:      eventsPlayed > 0 ? totalRank / eventsPlayed : 999,
        winRate:      matches > 0 ? wins / matches : 0,
        eventsPlayed,
      };
    } catch (_) {}
    done++;
    scheduleRender();
  }), 8);

  clearTimeout(timer);
  trueSkillLoading = false;
  setStandingsStatus('');
  _recomputeAndRender();
}

function _recomputeAndRender() {
  const data = standingsState.data;
  if (!data) return;
  const maxCombined = Math.max(1, ...data.map(t => t.combined));
  data.forEach(t => { t.trueSkill = computeTrueSkill(t, maxCombined); });
  renderStandingsTable(applyStandingsFilters(data));
}

// Fetch the full skills standings from the RobotEvents legacy endpoint.
// One call per grade level (~3 total) returns the complete standings instantly —
// no auth token required, no event scanning, no per-team calls.
const SKILLS_GRADE_LEVELS = {
  1:  ['High School', 'Middle School'],          // V5RC
  4:  ['College'],                               // VEXU
  41: ['Middle School', 'Elementary School'],    // VIQRC
};

async function fetchSkillsStandings(pid, sid, onUpdate) {
  const cached = readStandingsCache(pid, sid);
  if (cached) return cached;

  const byTeam    = {};
  const gradeList = SKILLS_GRADE_LEVELS[pid] || ['High School', 'Middle School'];
  const total     = gradeList.length;

  function mergeEntries(entries, pid) {
    for (const entry of entries) {
      const num = entry.team?.team;
      if (!num) continue;
      const driver      = entry.scores?.driver      || 0;
      const programming = entry.scores?.programming || 0;
      const existing    = byTeam[num];
      // Update driver and programming scores independently — take best of each
      if (!existing) {
        byTeam[num] = {
          number:      num,
          teamId:      entry.team?.id         || null,
          grade:       entry.team?.gradeLevel || '',
          programId:   pid,
          country:     entry.team?.country    || '',
          region:      entry.team?.region     || '',
          city:        entry.team?.city       || '',
          driver,      driverStop:      driver      > 0 ? (entry.scores?.driverStopTime || null) : null,
          programming, programmingStop: programming > 0 ? (entry.scores?.progStopTime   || null) : null,
        };
      } else {
        if (driver      > existing.driver)      { existing.driver      = driver;      existing.driverStop      = entry.scores?.driverStopTime || null; }
        if (programming > existing.programming) { existing.programming = programming; existing.programmingStop = entry.scores?.progStopTime   || null; }
      }
    }
  }

  for (let i = 0; i < gradeList.length; i++) {
    const grade = gradeList[i];
    onUpdate?.(null, i, total);
    try {
      const base = `https://www.robotevents.com/api/seasons/${sid}/skills?grade_level=${encodeURIComponent(grade)}`;
      const [regular, worlds] = await Promise.all([
        fetch(base + '&post_season=0').then(r => r.ok ? r.json() : []),
        fetch(base + '&post_season=1').then(r => r.ok ? r.json() : []),
      ]);
      mergeEntries(regular, pid);
      mergeEntries(worlds,  pid);
    } catch (_) {}
    onUpdate?.(byTeam, i + 1, total);
  }

  const result = buildSkillsResult(byTeam);
  writeStandingsCache(pid, sid, result);
  return result;
}

function applyStandingsFilters(data) {
  const { grade, country, region, sort } = standingsState;
  let out = data;
  if (grade   !== 'all' && grade)   out = out.filter(t => t.grade   === grade);
  if (country)                      out = out.filter(t => t.country === country);
  if (region)                       out = out.filter(t => t.region  === region);
  // Stop time tiebreakers: lower is better; 0/null means no stop time recorded → treat as worst.
  const pStop = t => (t.programmingStop > 0 ? t.programmingStop : Infinity);
  const dStop = t => (t.driverStop      > 0 ? t.driverStop      : Infinity);

  if (sort === 'driver') {
    out = [...out].sort((a, b) => b.driver - a.driver || dStop(a) - dStop(b));
  } else if (sort === 'programming') {
    out = [...out].sort((a, b) => b.programming - a.programming || pStop(a) - pStop(b));
  } else if (sort === 'trueskill') {
    out = [...out].sort((a, b) => b.trueSkill - a.trueSkill || b.combined - a.combined);
  } else {
    // Combined: tiebreak by programming stop time, then driver stop time
    out = [...out].sort((a, b) =>
      b.combined - a.combined || pStop(a) - pStop(b) || dStop(a) - dStop(b)
    );
  }
  return out;
}

function setStandingsStatus(msg, done, total) {
  const el = document.getElementById('standings-status');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const bar = (done != null && total > 0)
    ? '<div class="st-progress-wrap"><div class="st-progress-bar" style="width:' + Math.round(done / total * 100) + '%"></div></div>'
    : '';
  el.innerHTML = '<span>' + esc(msg) + '</span>' + bar;
}

function renderStandingsFilters(data) {
  const el = document.getElementById('standings-filters');
  if (!el) return;

  // Build unique sorted country list from current data
  const countries = [...new Set(data.map(t => t.country).filter(Boolean))].sort();
  const regions   = standingsState.country
    ? [...new Set(data.filter(t => t.country === standingsState.country).map(t => t.region).filter(Boolean))].sort()
    : [];

  const prog = standingsState.programId;
  const sel = (val, cur) => val === cur ? ' selected' : '';

  const seasons = standingsState.availableSeasons;

  el.innerHTML =
    '<div class="standings-filter-bar">' +
    // Program
    '<select class="map-filter-select" id="st-prog">' +
    '<option value="1"'  + sel(1,  prog) + '>V5RC</option>' +
    '<option value="4"'  + sel(4,  prog) + '>VEXU</option>'  +
    '<option value="41"' + sel(41, prog) + '>VIQRC</option>' +
    '</select>' +
    // Season
    (seasons.length ? '<select class="map-filter-select" id="st-season">' +
      seasons.map(s => '<option value="' + s.id + '"' + (s.id === standingsState.seasonId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
      '</select>' : '') +
    // Sort
    '<select class="map-filter-select" id="st-sort">' +
    '<option value="combined"'    + sel('combined',    standingsState.sort) + '>Combined</option>' +
    '<option value="driver"'      + sel('driver',      standingsState.sort) + '>Driver Skills</option>' +
    '<option value="programming"' + sel('programming', standingsState.sort) + '>Programming Skills</option>' +
    '<option value="trueskill"'   + sel('trueskill',   standingsState.sort) + '>Rating</option>' +
    '</select>' +
    // Grade — options depend on program
    '<select class="map-filter-select" id="st-grade">' +
    '<option value="all"' + sel('all', standingsState.grade) + '>All Grades</option>' +
    (SKILLS_GRADE_LEVELS[prog] || []).map(g =>
      '<option value="' + esc(g) + '"' + sel(g, standingsState.grade) + '>' + esc(g) + '</option>'
    ).join('') +
    '</select>' +
    // Country
    '<select class="map-filter-select" id="st-country">' +
    '<option value="">All Countries</option>' +
    countries.map(c => '<option value="' + esc(c) + '"' + (c === standingsState.country ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
    '</select>' +
    // Region (only shown when country selected)
    (regions.length ? '<select class="map-filter-select" id="st-region">' +
      '<option value="">All Regions</option>' +
      regions.map(r => '<option value="' + esc(r) + '"' + (r === standingsState.region ? ' selected' : '') + '>' + esc(r) + '</option>').join('') +
      '</select>' : '<select class="map-filter-select" id="st-region" style="display:none"><option value=""></option></select>') +
    // Team search
    '<div class="st-search-wrap">' +
    '<input id="st-search" type="text" class="st-search-input" placeholder="Find team…" autocomplete="off" value="' + esc(standingsState.search) + '" />' +
    '<button class="map-toggle-btn" id="st-search-btn">Find</button>' +
    '</div>' +
    // Cache info
    '<span class="st-cache-note" id="st-cache-note"></span>' +
    '<button class="map-toggle-btn" id="st-refresh" title="Force refresh from API">Refresh</button>' +
    '</div>';

  document.getElementById('st-prog').addEventListener('change', e => {
    standingsState.programId = +e.target.value;
    standingsState.seasonId = null; standingsState.availableSeasons = [];
    standingsState.country = ''; standingsState.region = ''; standingsState.page = 0;
    standingsState.data = null;
    Object.keys(trueSkillCache).forEach(k => delete trueSkillCache[k]);
    loadStandingsData();
  });
  document.getElementById('st-season')?.addEventListener('change', e => {
    standingsState.seasonId = +e.target.value;
    standingsState.data = null; standingsState.page = 0;
    standingsState.country = ''; standingsState.region = '';
    Object.keys(trueSkillCache).forEach(k => delete trueSkillCache[k]);
    loadStandingsData();
  });
  document.getElementById('st-sort').addEventListener('change', e => {
    standingsState.sort = e.target.value; standingsState.page = 0;
    if (e.target.value === 'trueskill') loadTrueSkillData();
    else renderStandingsTable(applyStandingsFilters(standingsState.data));
  });
  document.getElementById('st-grade').addEventListener('change', e => {
    standingsState.grade = e.target.value; standingsState.page = 0;
    renderStandingsTable(applyStandingsFilters(standingsState.data));
  });
  document.getElementById('st-country').addEventListener('change', e => {
    standingsState.country = e.target.value; standingsState.region = ''; standingsState.page = 0;
    renderStandingsFilters(standingsState.data);
    renderStandingsTable(applyStandingsFilters(standingsState.data));
  });
  document.getElementById('st-region').addEventListener('change', e => {
    standingsState.region = e.target.value; standingsState.page = 0;
    renderStandingsTable(applyStandingsFilters(standingsState.data));
  });
  document.getElementById('st-refresh').addEventListener('click', () => {
    if (standingsState.seasonId)
      localStorage.removeItem(standingsCacheKey(standingsState.programId, standingsState.seasonId));
    standingsState.data = null;
    loadStandingsData();
  });

  function doStandingsSearch() {
    const query = (document.getElementById('st-search')?.value || '').trim().toUpperCase();
    standingsState.search = query;
    if (!query || !standingsState.data) return;
    const filtered = applyStandingsFilters(standingsState.data);
    const idx = filtered.findIndex(t => t.number?.toUpperCase() === query);
    if (idx === -1) {
      // Try partial match
      const partialIdx = filtered.findIndex(t => t.number?.toUpperCase().includes(query));
      if (partialIdx === -1) return;
      scrollToStandingsRow(filtered, partialIdx);
    } else {
      scrollToStandingsRow(filtered, idx);
    }
  }

  function scrollToStandingsRow(filtered, idx) {
    const neededPage = Math.floor(idx / STANDINGS_PAGE);
    if (standingsState.page < neededPage) {
      standingsState.page = neededPage;
      renderStandingsTable(filtered);
    }
    requestAnimationFrame(() => {
      const teamNum = filtered[idx]?.number;
      if (!teamNum) return;
      const row = document.querySelector(`#standings-content tr[data-st-num="${CSS.escape(teamNum)}"]`);
      if (row) {
        row.classList.add('row-highlight');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => row.classList.remove('row-highlight'), 2500);
      }
    });
  }

  document.getElementById('st-search-btn').addEventListener('click', doStandingsSearch);
  document.getElementById('st-search')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doStandingsSearch();
  });
}

function renderStandingsTable(filtered) {
  const el = document.getElementById('standings-content');
  if (!el) return;

  const sort = standingsState.sort;
  const isTS = sort === 'trueskill';
  const page = standingsState.page;
  const slice = filtered.slice(0, (page + 1) * STANDINGS_PAGE);
  const hasMore = filtered.length > slice.length;

  const stopFmt = s => (s != null && s > 0) ? s + 's' : '—';
  const scoreCell = (score, stop, highlight) =>
    '<td class="st-score' + (highlight ? ' st-score-hi' : '') + '">' +
    (score > 0 ? score : '<span class="td-score-muted">—</span>') +
    (score > 0 && stop ? '<span class="st-stop"> ' + stopFmt(stop) + '</span>' : '') +
    '</td>';

  let rows = '';
  slice.forEach((t, i) => {
    const globalRank = i + 1;
    const loc = [t.city, t.region, t.country].filter(Boolean).join(', ') || '—';
    rows +=
      '<tr data-st-num="' + esc(t.number) + '">' +
      '<td class="st-rank">' + globalRank + '</td>' +
      '<td><button class="team-link" data-num="' + esc(t.number) + '">' + esc(t.number) + '</button></td>' +
      '<td class="td-score-muted" style="font-size:.8rem">' + esc(t.grade || '—') + '</td>' +
      '<td class="td-score-muted" style="font-size:.75rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(loc) + '</td>' +
      scoreCell(t.combined,     null,             sort === 'combined'    || isTS) +
      scoreCell(t.driver,       t.driverStop,     sort === 'driver') +
      scoreCell(t.programming,  t.programmingStop, sort === 'programming') +
      (isTS ? '<td class="st-score st-score-hi">' + t.trueSkill.toFixed(2) + '<span style="font-size:.7rem;opacity:.55">/10</span></td>' : '') +
      '</tr>';
  });

  el.innerHTML =
    '<div class="st-summary">Showing <strong>' + slice.length + '</strong> of <strong>' + filtered.length + '</strong> teams' +
    (filtered.length !== standingsState.data?.length ? ' (filtered from ' + standingsState.data.length + ' total)' : '') + '</div>' +
    '<div class="table-wrap"><table class="standings-table">' +
    '<thead><tr>' +
    '<th>#</th><th>Team</th><th>Grade</th><th>Location</th>' +
    '<th class="' + (sort === 'combined' || isTS ? 'th-sorted' : '') + '">Combined</th>' +
    '<th class="' + (sort === 'driver'          ? 'th-sorted' : '') + '">Driver</th>' +
    '<th class="' + (sort === 'programming'     ? 'th-sorted' : '') + '">Programming</th>' +
    (isTS ? '<th class="th-sorted">Rating (/10)</th>' : '') +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>' +
    (hasMore ? '<button class="btn-load-more" id="st-load-more">Load more (' + (filtered.length - slice.length) + ' remaining)</button>' : '');

  el.querySelectorAll('.team-link').forEach(btn => {
    btn.addEventListener('click', () => goToTeam(btn.dataset.num, standingsState.programId));
  });
  document.getElementById('st-load-more')?.addEventListener('click', () => {
    standingsState.page++;
    renderStandingsTable(filtered);
  });
}

async function loadStandingsData() {
  const pid = standingsState.programId;
  setStandingsStatus('Loading season info…');

  // Load (or refresh) the full season list when the program changes
  if (!standingsState.availableSeasons.length || standingsState._lastPid !== pid) {
    const seasons = await fetchProgramSeasons(pid);
    standingsState.availableSeasons = seasons;
    // Default to the first (most recent/active) season unless user already picked one for this program
    if (!standingsState.seasonId || standingsState._lastPid !== pid) {
      standingsState.seasonId = seasons[0]?.id || null;
    }
    standingsState._lastPid = pid;
  }

  const sid = standingsState.seasonId;
  if (!sid) { setStandingsStatus('Could not find active season.'); return; }

  // Final cache hit → instant render
  const finalCached = readStandingsCache(pid, sid);
  if (finalCached) {
    standingsState.data = finalCached;
    setStandingsStatus('');
    renderStandingsFilters(finalCached);
    renderStandingsTable(applyStandingsFilters(finalCached));
    try {
      const { ts } = JSON.parse(localStorage.getItem(standingsCacheKey(pid, sid)));
      const mins = Math.round((Date.now() - ts) / 60000);
      const note = document.getElementById('st-cache-note');
      if (note) note.textContent = 'Cached ' + (mins < 60 ? mins + 'm ago' : Math.round(mins / 60) + 'h ago');
    } catch (_) {}
    return;
  }

  // No final cache — fetch progressively.
  // Grade/location come directly from the team list (already in fetchSkillsStandings).
  let filtersRendered = false;

  function onUpdate(byTeam, done, total) {
    const GRADE_LABELS = ['High School', 'Middle School', 'College'];
    if (!byTeam) {
      setStandingsStatus('Loading ' + (GRADE_LABELS[done] || 'skills') + '…');
      return;
    }

    const result = buildSkillsResult(byTeam);
    standingsState.data = result;

    const isComplete = done >= total && total > 0;
    const withScores = result.length;
    const msg = isComplete ? '' :
      `${withScores.toLocaleString()} teams · loading ${GRADE_LABELS[done] || ''}…`;
    setStandingsStatus(msg, done, isComplete ? 0 : total);

    if (!filtersRendered || isComplete) {
      renderStandingsFilters(result);
      filtersRendered = true;
    }
    renderStandingsTable(applyStandingsFilters(result));
  }

  try {
    const data = await fetchSkillsStandings(pid, sid, onUpdate);
    standingsState.data = data;
    setStandingsStatus('');
    renderStandingsFilters(data);
    renderStandingsTable(applyStandingsFilters(data));
  } catch (err) {
    setStandingsStatus('Error: ' + err.message);
  }
}

async function openStandingsView() {
  showView('view-standings');
  // Keep existing data if same program — just re-render
  if (standingsState.data && standingsState._lastPid === standingsState.programId) {
    renderStandingsFilters(standingsState.data);
    renderStandingsTable(applyStandingsFilters(standingsState.data));
    return;
  }
  await loadStandingsData();
}

// ═══════════════════════════════════════════════════════════════════════════
// WORLD MAP
// ═══════════════════════════════════════════════════════════════════════════

// Country name → [lat, lon] centroid for Leaflet circle markers
const COUNTRY_COORDS = {
  "United States":[37.09,-95.71],"China":[35.86,104.19],"Canada":[56.13,-106.35],
  "United Kingdom":[55.38,-3.44],"Germany":[51.17,10.45],"Australia":[-25.27,133.78],
  "South Korea":[35.91,127.77],"Japan":[36.20,138.25],"Brazil":[-14.24,-51.93],
  "Singapore":[1.35,103.82],"Mexico":[23.63,-102.55],"New Zealand":[-40.90,174.89],
  "India":[20.59,78.96],"Netherlands":[52.13,5.29],"Taiwan":[23.70,120.96],
  "France":[46.23,2.21],"Spain":[40.46,-3.75],"Italy":[41.87,12.57],
  "Sweden":[60.13,18.64],"Norway":[60.47,8.47],"Denmark":[56.26,9.50],
  "Finland":[61.92,25.75],"Poland":[51.92,19.15],"Czech Republic":[49.82,15.47],
  "Hungary":[47.16,19.50],"Romania":[45.94,24.97],"Bulgaria":[42.73,25.49],
  "Greece":[39.07,21.82],"Portugal":[39.40,-8.22],"Belgium":[50.50,4.47],
  "Switzerland":[46.82,8.23],"Austria":[47.52,14.55],"Israel":[31.05,34.85],
  "Turkey":[38.96,35.24],"South Africa":[-30.56,22.94],"Egypt":[26.82,30.80],
  "Nigeria":[9.08,8.68],"Kenya":[-0.02,37.91],"Ghana":[7.95,-1.02],
  "Morocco":[31.79,-7.09],"Tunisia":[33.89,9.54],
  "Argentina":[-38.42,-63.62],"Chile":[-35.68,-71.54],"Colombia":[4.57,-74.30],
  "Peru":[-9.19,-75.02],"Venezuela":[6.42,-66.59],"Ecuador":[-1.83,-78.18],
  "Bolivia":[-16.29,-63.59],"Paraguay":[-23.44,-58.44],"Uruguay":[-32.52,-55.77],
  "Costa Rica":[9.75,-83.75],"Panama":[8.54,-80.78],"Guatemala":[15.78,-90.23],
  "Honduras":[15.20,-86.24],"El Salvador":[13.79,-88.90],
  "Dominican Republic":[18.74,-70.16],"Puerto Rico":[18.22,-66.59],
  "Trinidad and Tobago":[10.69,-61.22],"Jamaica":[18.11,-77.30],
  "Bahamas":[25.03,-77.40],"Cuba":[21.52,-77.78],"Haiti":[18.97,-72.29],
  "Barbados":[13.19,-59.54],
  "Saudi Arabia":[23.89,45.08],"United Arab Emirates":[23.42,53.85],
  "Qatar":[25.35,51.18],"Kuwait":[29.31,47.48],"Bahrain":[26.02,50.55],
  "Oman":[21.51,55.92],"Jordan":[30.59,36.24],"Lebanon":[33.85,35.86],
  "Iran":[32.43,53.69],"Iraq":[33.22,43.68],
  "Pakistan":[30.38,69.35],"Bangladesh":[23.68,90.36],"Sri Lanka":[7.87,80.77],
  "Nepal":[28.39,84.12],"India":[20.59,78.96],
  "Malaysia":[4.21,101.98],"Indonesia":[-0.79,113.92],"Thailand":[15.87,100.99],
  "Vietnam":[14.06,108.28],"Philippines":[12.88,121.77],"Myanmar":[16.87,96.19],
  "Cambodia":[12.57,104.99],"Laos":[19.86,102.50],"Brunei":[4.54,114.73],
  "Hong Kong":[22.32,114.17],"Macau":[22.17,113.55],"Taiwan":[23.70,120.96],
  "Mongolia":[46.86,103.85],"Afghanistan":[33.94,67.71],
  "Russia":[61.52,105.32],"Ukraine":[48.38,31.17],"Belarus":[53.71,27.95],
  "Kazakhstan":[48.02,66.92],"Azerbaijan":[40.14,47.58],"Georgia":[42.32,43.36],
  "Armenia":[40.07,45.04],"Uzbekistan":[41.38,64.59],"Kyrgyzstan":[41.20,74.77],
  "Serbia":[44.02,21.01],"Croatia":[45.10,15.20],"Slovenia":[46.15,14.99],
  "Slovakia":[48.67,19.70],"Estonia":[58.60,25.01],"Latvia":[56.88,24.60],
  "Lithuania":[55.17,23.88],"Bosnia and Herzegovina":[43.92,17.68],
  "North Macedonia":[41.61,21.74],"Albania":[41.15,20.17],"Moldova":[47.41,28.37],
  "Montenegro":[42.71,19.37],"Kosovo":[42.60,20.90],
  "Iceland":[64.96,-19.02],"Ireland":[53.41,-8.24],"Luxembourg":[49.82,6.13],
  "Malta":[35.94,14.38],"Cyprus":[35.13,33.43],
  "Ethiopia":[9.15,40.49],"Tanzania":[-6.37,34.89],"Uganda":[1.37,32.29],
  "Rwanda":[-1.94,29.87],"Mozambique":[-18.67,35.53],"Zambia":[-13.13,27.85],
  "Zimbabwe":[-19.01,29.15],"Botswana":[-22.33,24.68],"Namibia":[-22.96,18.49],
  "Ivory Coast":[7.54,-5.55],"Senegal":[14.50,-14.45],"Cameroon":[3.85,11.50],
  "Angola":[-11.20,17.87],
  "Papua New Guinea":[-6.31,143.96],"Fiji":[-17.71,178.07],
};

const PROGRAM_IDS = { all: null, v5rc: 1, vexu: 4, viqrc: 41 };

let mapState = {
  programId: 1, grade: 'all', eventId: null, countryData: {}, sourceView: 'view-search',
  leafletMap: null, markerLayer: null,
  heatLayer: null, heatmap: false,
  skillsHeatLayer: null, skillsHeatmap: false,
  eventsLayer: null, showEvents: false,
  stateLayer: null, showStateSkills: false,
  travelLayer: null,
  allTeams: null, dots: {},
};
let _mapLoadGen = 0;
const _seasonIdCache      = {};   // programId -> seasonId (in-memory, avoids repeated API calls)
const _seasonListCache    = {};   // programId -> [{ id, name }] fetched season list
const _teamsByProgram     = {};   // programId -> slimTeam[] (map-use, no season filter)
const _teamsByProgSeason  = {};   // `${pid}_${sid}` -> slimTeam[] (standings-use, season-filtered)

function destroyLeafletMap() {
  if (mapState.leafletMap) {
    mapState.leafletMap.remove();
    mapState.leafletMap = null;
    mapState.markerLayer = null;
    mapState.heatLayer = null;
    mapState.skillsHeatLayer = null;
    mapState.eventsLayer = null;
    mapState.stateLayer = null;
    mapState.travelLayer = null;
  }
}

// Dynamically loads the leaflet.heat plugin (no-op if already present)
function ensureLeafletHeat() {
  if (window.L?.heatLayer) return Promise.resolve(true);
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js';
    s.onload  = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function buildHeatPoints(teams) {
  const grade = mapState.grade;
  const pts = [];
  for (const t of teams) {
    if (grade !== 'all' && t.grade !== grade) continue;
    let lat = t.location?.coordinates?.lat;
    let lon = t.location?.coordinates?.lon;
    if ((lat == null || lon == null) && t.location?.country && COUNTRY_COORDS[t.location.country]) {
      [lat, lon] = COUNTRY_COORDS[t.location.country];
    }
    if (lat != null && lon != null) pts.push([lat, lon]);
  }
  return pts;
}

function initLeafletMap() {
  if (mapState.leafletMap) return; // already live
  const container = document.getElementById('map-container');
  container.innerHTML = '';
  container.style.height = '480px';
  if (typeof L === 'undefined') {
    container.innerHTML = '<p class="empty" style="padding:20px">Map library failed to load.</p>';
    return;
  }
  const m = L.map(container, { zoomControl: true, scrollWheelZoom: true });
  mapState.leafletMap = m;
  L.tileLayer('https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=v2zClPQKX8x55Lzh1OxJ', {
    attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(m);
  mapState.markerLayer = L.layerGroup().addTo(m);
  setTimeout(() => { m.invalidateSize(); m.setView([20, 10], 2); }, 50);
}

function buildDots(teams) {
  const grade = mapState.grade;
  const dots = {};
  const byCountry = {};
  for (const t of teams) {
    if (grade !== 'all' && t.grade !== grade) continue;
    const country  = t.location?.country;
    const teamInfo = { name: t.name, number: t.number || t.name, grade: t.grade, country, programId: t.program?.id ?? t.program };

    let lat = t.location?.coordinates?.lat;
    let lon = t.location?.coordinates?.lon;
    if ((lat == null || lon == null) && country && COUNTRY_COORDS[country]) {
      [lat, lon] = COUNTRY_COORDS[country];
    }
    if (lat != null && lon != null) {
      const key = lat.toFixed(2) + ',' + lon.toFixed(2);
      if (!dots[key]) dots[key] = { lat, lon, city: t.location?.city || '', region: t.location?.region || '', country: t.location?.country || '', teams: [] };
      dots[key].teams.push(teamInfo);
    }
    if (country) {
      if (!byCountry[country]) byCountry[country] = { count: 0, teams: [] };
      byCountry[country].count++;
      byCountry[country].teams.push(teamInfo);
    }
  }
  return { dots, byCountry };
}

function updateMapOverlay(teams) {
  if (!mapState.leafletMap || !mapState.markerLayer) return;
  const { dots, byCountry } = buildDots(teams);
  mapState.countryData = byCountry;
  mapState.dots = dots;

  const anyHeatmap = mapState.heatmap || mapState.skillsHeatmap;

  // ── Dot markers — shown only when no heatmap is active ──────────────────
  mapState.markerLayer.clearLayers();
  if (!anyHeatmap) {
    const maxAtDot = Math.max(1, ...Object.values(dots).map(d => d.teams.length));
    for (const dot of Object.values(dots)) {
      const count  = dot.teams.length;
      const frac   = count / maxAtDot;
      const radius = count === 1 ? 5 : 5 + Math.sqrt(frac) * 18;
      const hue    = count === 1 ? 210 : Math.round(210 - frac * 180);
      const marker = L.circleMarker([dot.lat, dot.lon], {
        radius, fillColor: `hsl(${hue},75%,45%)`, color: '#fff',
        weight: 1, opacity: 0.9, fillOpacity: 0.8,
      }).addTo(mapState.markerLayer);
      const dotLocLabel = [dot.city, dot.region, dot.country].filter(Boolean).join(', ') || 'this location';
      const tipLabel = count === 1
        ? '<strong>' + esc(dot.teams[0].number) + '</strong> · ' + esc(dotLocLabel)
        : '<strong>' + count + ' teams</strong> · ' + esc(dotLocLabel);
      marker.bindTooltip(tipLabel, { direction: 'top', offset: [0, -4] });
      marker.on('click', () => showMapDotsPanel(dot));
    }
  }

  // ── Density heatmap — only when that specific toggle is on ───────────────
  if (mapState.heatmap && window.L?.heatLayer) {
    const pts = buildHeatPoints(teams);
    if (mapState.heatLayer) {
      mapState.heatLayer.setLatLngs(pts);
    } else {
      mapState.heatLayer = L.heatLayer(pts, {
        radius: 35, blur: 30, maxZoom: 16, max: 1.0, minOpacity: 0.45,
        gradient: { 0.2: '#0ea5e9', 0.45: '#6366f1', 0.7: '#f59e0b', 1.0: '#ef4444' },
      }).addTo(mapState.leafletMap);
    }
  } else if (!mapState.heatmap && mapState.heatLayer) {
    mapState.heatLayer.remove();
    mapState.heatLayer = null;
  }

  const total = Object.values(byCountry).reduce((s, d) => s + d.count, 0);
  const legendEl = document.getElementById('map-legend');
  if (legendEl) legendEl.innerHTML =
    '<div class="map-legend"><span>1 team</span><div class="map-legend-bar"></div><span>Many teams</span>' +
    '<span style="margin-left:auto;color:var(--text-muted)">' + total.toLocaleString() + ' teams · ' + Object.keys(byCountry).length + ' countries</span></div>';
}

// US state centroids for sub-national resolution
const US_STATE_COORDS = {
  'Alabama':[32.80,-86.79],'Alaska':[64.20,-153.37],'Arizona':[34.05,-111.09],
  'Arkansas':[34.80,-92.20],'California':[36.78,-119.42],'Colorado':[39.55,-105.78],
  'Connecticut':[41.60,-72.69],'Delaware':[39.00,-75.50],'Florida':[27.99,-81.76],
  'Georgia':[32.17,-82.90],'Hawaii':[19.90,-155.56],'Idaho':[44.07,-114.74],
  'Illinois':[40.35,-88.99],'Indiana':[39.85,-86.26],'Iowa':[42.01,-93.21],
  'Kansas':[38.53,-96.73],'Kentucky':[37.67,-84.67],'Louisiana':[31.17,-91.87],
  'Maine':[44.69,-69.38],'Maryland':[39.06,-76.80],'Massachusetts':[42.23,-71.53],
  'Michigan':[43.33,-84.54],'Minnesota':[45.69,-93.90],'Mississippi':[32.74,-89.68],
  'Missouri':[38.46,-92.29],'Montana':[46.88,-110.36],'Nebraska':[41.13,-98.27],
  'Nevada':[38.31,-117.06],'New Hampshire':[43.45,-71.56],'New Jersey':[40.30,-74.52],
  'New Mexico':[34.52,-105.87],'New York':[42.17,-74.95],'North Carolina':[35.63,-79.81],
  'North Dakota':[47.53,-99.78],'Ohio':[40.39,-82.76],'Oklahoma':[35.57,-96.93],
  'Oregon':[44.07,-120.54],'Pennsylvania':[40.59,-77.21],'Rhode Island':[41.68,-71.51],
  'South Carolina':[33.84,-81.16],'South Dakota':[44.30,-99.44],'Tennessee':[35.74,-86.69],
  'Texas':[31.97,-99.90],'Utah':[39.32,-111.09],'Vermont':[44.07,-72.67],
  'Virginia':[37.77,-78.17],'Washington':[47.75,-120.74],'West Virginia':[38.60,-80.95],
  'Wisconsin':[43.78,-88.79],'Wyoming':[43.08,-107.29],'District of Columbia':[38.91,-77.04],
  'Puerto Rico':[18.22,-66.59],'Guam':[13.44,144.79],
};

// Resolve a skills entry's geographic region to [lat, lon] and a region key.
// US teams use state-level granularity; others use country centroid.
function skillsRegionCoords(t) {
  if (t.country === 'United States' || t.country === 'USA') {
    const region = t.region || '';
    // Try exact state match first
    if (US_STATE_COORDS[region]) return { key: region, coords: US_STATE_COORDS[region] };
    // Some regions are formatted "California" or "California Region 1" — extract state name
    for (const state of Object.keys(US_STATE_COORDS)) {
      if (region.startsWith(state)) return { key: state, coords: US_STATE_COORDS[state] };
    }
    // Unknown US region — fall back to national centroid
    return { key: 'United States', coords: COUNTRY_COORDS['United States'] };
  }
  const coords = COUNTRY_COORDS[t.country];
  if (coords) return { key: t.country, coords };
  return null;
}

// ── Skills quality heatmap ────────────────────────────────────────────────
// Aggregates skills scores per geographic region (US state or country),
// computes the avg of the top-10% scores in each region as the quality signal,
// then renders one weighted heat point per region.  One point per region means
// no stacking artefacts and the gradient clearly shows regional skill level.
async function loadSkillsHeatmap() {
  if (!mapState.leafletMap) return;
  const pid = mapState.programId || 1;

  const btn = document.getElementById('map-skills-heat-toggle');
  const sid = await getActiveSeasonId(pid);
  if (!sid) return;

  if (btn) btn.textContent = 'Loading…';
  let allSkills;
  try {
    allSkills = await fetchSkillsStandings(pid, sid, null);
  } catch (_) {
    if (btn) btn.textContent = 'Skills Heat';
    return;
  }
  if (btn) btn.textContent = 'Skills Heat';
  if (!mapState.skillsHeatmap || !mapState.leafletMap) return;

  // Top 1000 teams by combined score
  const top1000 = allSkills
    .filter(t => t.combined > 0)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, 1000);

  if (!top1000.length) return;

  const maxScore = top1000[0].combined;

  // Build one heat point per team weighted by their skills score
  const pts = [];
  for (const t of top1000) {
    const country = (t.country || '').trim();
    const region  = (t.region  || '').trim();
    let coords = null;

    // US → state-level resolution
    if (country === 'United States' || country === 'USA') {
      if (US_STATE_COORDS[region]) {
        coords = US_STATE_COORDS[region];
      } else {
        // "California Region 1" → California
        for (const state of Object.keys(US_STATE_COORDS)) {
          if (region.startsWith(state)) { coords = US_STATE_COORDS[state]; break; }
        }
      }
      if (!coords) coords = COUNTRY_COORDS['United States'];
    } else if (country) {
      coords = COUNTRY_COORDS[country] || null;
    }

    if (!coords) continue;

    // Small jitter so multiple teams in the same region spread into a visible
    // cluster rather than stacking on a single pixel (±1° ≈ ±110 km)
    const lat = coords[0] + (Math.random() - 0.5) * 2;
    const lon = coords[1] + (Math.random() - 0.5) * 2;
    const weight = t.combined / maxScore;
    pts.push([lat, lon, weight]);
  }

  if (!pts.length) return;

  if (mapState.skillsHeatLayer) {
    mapState.skillsHeatLayer.setLatLngs(pts);
  } else {
    // No maxZoom — let leaflet.heat use its default so points aren't dimmed at world zoom.
    // Gradient goes from visible blue through purple to gold/white for elite regions.
    // max:0.7 so mid-range teams still show colour; radius large enough to see at zoom 2.
    mapState.skillsHeatLayer = L.heatLayer(pts, {
      radius: 30, blur: 22, max: 0.7, minOpacity: 0.55,
      gradient: { 0.0: '#2563eb', 0.4: '#7c3aed', 0.7: '#f59e0b', 1.0: '#fef08a' },
    }).addTo(mapState.leafletMap);
  }

  const legendEl = document.getElementById('map-legend');
  if (legendEl && !legendEl.innerHTML.includes('Skills')) {
    legendEl.innerHTML +=
      '<div class="map-legend" style="margin-top:4px">' +
      '<span style="color:var(--text-muted);font-size:.75rem">Skills:</span>' +
      '<div class="map-legend-bar" style="background:linear-gradient(to right,#2563eb,#7c3aed,#f59e0b,#fef08a)"></div>' +
      '<span style="font-size:.75rem">elite</span>' +
      '<span style="margin-left:auto;color:var(--text-muted);font-size:.75rem">' +
      'top ' + pts.length + ' teams · weighted by score</span>' +
      '</div>';
  }
}

// Haversine distance in km between two lat/lon pairs
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Interpolate N points along the great-circle arc between two lat/lon pairs.
// Returns an array of [lat, lon] suitable for L.polyline — the arc will follow
// the actual shortest path on the sphere rather than a straight Mercator line.
function geodesicPoints(lat1, lon1, lat2, lon2, n = 64) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  // Convert to unit Cartesian vectors
  const x1 = Math.cos(φ1)*Math.cos(λ1), y1 = Math.cos(φ1)*Math.sin(λ1), z1 = Math.sin(φ1);
  const x2 = Math.cos(φ2)*Math.cos(λ2), y2 = Math.cos(φ2)*Math.sin(λ2), z2 = Math.sin(φ2);
  const dot = Math.min(1, Math.max(-1, x1*x2 + y1*y2 + z1*z2));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return [[lat1, lon1], [lat2, lon2]];
  const sinA = Math.sin(angle);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = Math.sin((1 - t) * angle) / sinA;
    const b = Math.sin(t * angle) / sinA;
    const x = a*x1 + b*x2, y = a*y1 + b*y2, z = a*z1 + b*z2;
    pts.push([toDeg(Math.atan2(z, Math.sqrt(x*x + y*y))), toDeg(Math.atan2(y, x))]);
  }
  return pts;
}

async function openMapView(eventId) {
  const wasEvent = !!mapState.eventId;
  mapState.eventId    = eventId || null;
  mapState.sourceView = eventId ? 'view-event' : 'view-search';
  if (eventId) mapState.grade = 'all';
  showView('view-map');
  if (!eventId) mapState.programId = mapState.programId || 1;

  // Switching event map → global map: destroy the event's Leaflet instance so
  // loadMapData starts clean (either instant cache render or loading spinner).
  // _teamsByProgram cache is unaffected — global data is kept.
  if (wasEvent && !eventId) destroyLeafletMap();

  const filterEl = document.getElementById('map-filters');
  const isEvent  = !!eventId;

  filterEl.innerHTML =
    '<div class="map-filters">' +
    (isEvent
      ? '<span class="sim-label">Teams at: <strong>' + esc(currentEvent?.name || 'Event') + '</strong></span>'
      : '<select class="map-filter-select" id="map-prog-select">' +
        '<option value="all"'   + (mapState.programId === null ? ' selected' : '') + '>All Programs</option>' +
        '<option value="v5rc"'  + (mapState.programId === 1    ? ' selected' : '') + '>V5RC</option>' +
        '<option value="vexu"'  + (mapState.programId === 4    ? ' selected' : '') + '>VEXU</option>'  +
        '<option value="viqrc"' + (mapState.programId === 41   ? ' selected' : '') + '>VIQRC</option>' +
        '</select>' +
        '<select class="map-filter-select" id="map-grade-select">' +
        '<option value="all"'          + (mapState.grade === 'all'           ? ' selected' : '') + '>All Grades</option>' +
        '<option value="Middle School"'+ (mapState.grade === 'Middle School' ? ' selected' : '') + '>Middle School</option>' +
        '<option value="High School"'  + (mapState.grade === 'High School'   ? ' selected' : '') + '>High School</option>' +
        '<option value="College"'      + (mapState.grade === 'College'       ? ' selected' : '') + '>College</option>' +
        '</select>') +
    '<button class="map-toggle-btn' + (mapState.heatmap         ? ' active' : '') + '" id="map-heat-toggle">Density</button>' +
    '<button class="map-toggle-btn' + (mapState.skillsHeatmap   ? ' active' : '') + '" id="map-skills-heat-toggle">Skills Heat</button>' +
    (!isEvent ? '<button class="map-toggle-btn' + (mapState.showEvents      ? ' active' : '') + '" id="map-events-toggle">Events</button>' : '') +
    (!isEvent ? '<button class="map-toggle-btn' + (mapState.showStateSkills ? ' active' : '') + '" id="map-state-toggle">State Skills</button>' : '') +
    (isEvent  ? '<button class="map-toggle-btn' + (mapState.travelLayer     ? ' active' : '') + '" id="map-travel-toggle">Travel Lines</button>' : '') +
    '</div>';

  if (!isEvent) {
    document.getElementById('map-prog-select').addEventListener('change', e => {
      mapState.programId = PROGRAM_IDS[e.target.value] ?? null;
      mapState.grade = 'all';
      document.getElementById('map-grade-select').value = 'all';
      loadMapData();
    });
    document.getElementById('map-grade-select').addEventListener('change', e => {
      mapState.grade = e.target.value;
      applyMapGradeFilter();
    });
  }

  document.getElementById('map-heat-toggle').addEventListener('click', async function () {
    if (!mapState.heatmap) { const ok = await ensureLeafletHeat(); if (!ok) return; }
    mapState.heatmap = !mapState.heatmap;
    this.classList.toggle('active', mapState.heatmap);
    if (mapState.allTeams) updateMapOverlay(mapState.allTeams);
  });

  document.getElementById('map-skills-heat-toggle').addEventListener('click', async function () {
    const ok = await ensureLeafletHeat(); if (!ok) return;
    mapState.skillsHeatmap = !mapState.skillsHeatmap;
    this.classList.toggle('active', mapState.skillsHeatmap);
    if (mapState.skillsHeatmap) {
      loadSkillsHeatmap();
      if (mapState.allTeams) updateMapOverlay(mapState.allTeams);
    } else {
      if (mapState.skillsHeatLayer) { mapState.skillsHeatLayer.remove(); mapState.skillsHeatLayer = null; }
      if (mapState.allTeams) updateMapOverlay(mapState.allTeams);
    }
  });

  document.getElementById('map-events-toggle')?.addEventListener('click', async function () {
    mapState.showEvents = !mapState.showEvents;
    this.classList.toggle('active', mapState.showEvents);
    if (mapState.showEvents) loadEventsLayer();
    else if (mapState.eventsLayer) { mapState.eventsLayer.remove(); mapState.eventsLayer = null; }
  });

  document.getElementById('map-state-toggle')?.addEventListener('click', async function () {
    mapState.showStateSkills = !mapState.showStateSkills;
    this.classList.toggle('active', mapState.showStateSkills);
    if (mapState.showStateSkills) loadStateSkillsLayer();
    else if (mapState.stateLayer) { mapState.stateLayer.remove(); mapState.stateLayer = null; }
  });

  document.getElementById('map-travel-toggle')?.addEventListener('click', function () {
    if (mapState.travelLayer) {
      mapState.travelLayer.remove(); mapState.travelLayer = null;
      this.classList.remove('active');
    } else {
      this.classList.add('active');
      drawTravelLines();
    }
  });

  document.getElementById('map-country-panel').classList.add('hidden');
  document.getElementById('map-country-panel').innerHTML = '';

  await loadMapData();
}

// ── Events layer: pins for every event this season ─────────────────────────
async function loadEventsLayer() {
  if (!mapState.leafletMap) return;
  const pid = mapState.programId || 1;
  const sid = await getActiveSeasonId(pid);
  if (!sid) return;

  const btn = document.getElementById('map-events-toggle');
  if (btn) btn.textContent = 'Events…';

  let events = [];
  try {
    events = await fetchAllPages(`/events?season[]=${sid}&program[]=${pid}&per_page=250`);
  } catch (_) {}

  if (btn) btn.textContent = 'Events';
  if (!mapState.showEvents || !mapState.leafletMap) return;

  if (mapState.eventsLayer) mapState.eventsLayer.remove();
  mapState.eventsLayer = L.layerGroup().addTo(mapState.leafletMap);

  const now = Date.now();
  for (const ev of events) {
    const lat = ev.location?.coordinates?.lat;
    const lon = ev.location?.coordinates?.lon;
    if (lat == null || lon == null) continue;

    const start = ev.start ? new Date(ev.start) : null;
    const end   = ev.end   ? new Date(ev.end)   : null;
    const isOngoing = start && end && start.getTime() <= now && end.getTime() >= now;
    const isFuture  = start && start.getTime() > now;

    const color = isOngoing ? '#22C55E' : isFuture ? '#3B82F6' : '#9CA3AF';
    const radius = isOngoing ? 8 : isFuture ? 6 : 4;

    const marker = L.circleMarker([lat, lon], {
      radius, fillColor: color, color: '#fff',
      weight: 1.5, opacity: 1, fillOpacity: isOngoing ? 1 : 0.75,
    }).addTo(mapState.eventsLayer);

    const dateStr = start ? start.toLocaleDateString() : '—';
    const statusStr = isOngoing ? '🟢 Ongoing' : isFuture ? '🔵 Upcoming' : '⚫ Past';
    marker.bindTooltip(
      `<strong>${esc(ev.name)}</strong><br>${statusStr} · ${dateStr}<br>${[ev.location?.city, ev.location?.region].filter(Boolean).join(', ')}`,
      { direction: 'top', offset: [0, -4] }
    );
    marker.on('click', () => openEventDetail(ev));
  }

  const legendEl = document.getElementById('map-legend');
  if (legendEl) legendEl.innerHTML +=
    '<div class="map-legend" style="margin-top:4px">' +
    '<span style="color:#22C55E;font-weight:700">● Ongoing</span> &nbsp;' +
    '<span style="color:#3B82F6;font-weight:700">● Upcoming</span> &nbsp;' +
    '<span style="color:#9CA3AF">● Past</span> &nbsp;' +
    '<span style="margin-left:auto;color:var(--text-muted);font-size:.75rem">' + events.length + ' events</span>' +
    '</div>';
}

// ── US state skills choropleth ─────────────────────────────────────────────
async function loadStateSkillsLayer() {
  if (!mapState.leafletMap) return;
  const pid = mapState.programId || 1;
  const sid = await getActiveSeasonId(pid);
  if (!sid) return;

  const btn = document.getElementById('map-state-toggle');
  if (btn) btn.textContent = 'Loading…';

  let geojson, allSkills;
  try {
    [geojson, allSkills] = await Promise.all([
      fetch('https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json').then(r => r.json()),
      fetchSkillsStandings(pid, sid, null),
    ]);
  } catch (_) {
    if (btn) btn.textContent = 'State Skills';
    return;
  }
  if (btn) btn.textContent = 'State Skills';
  if (!mapState.showStateSkills || !mapState.leafletMap) return;

  // Group by state → compute avg of top 10 combined scores
  const byState = {};
  for (const t of allSkills) {
    if (t.country !== 'United States' && t.country !== 'USA') continue;
    const region = (t.region || '').trim();
    let state = region;
    if (!US_STATE_COORDS[state]) {
      state = Object.keys(US_STATE_COORDS).find(s => region.startsWith(s)) || null;
    }
    if (!state) continue;
    (byState[state] = byState[state] || []).push(t.combined || 0);
  }

  const stateAvg = {};
  let maxAvg = 0;
  for (const [state, scores] of Object.entries(byState)) {
    scores.sort((a, b) => b - a);
    const top = scores.slice(0, Math.max(1, Math.ceil(scores.length * 0.1)));
    stateAvg[state] = top.reduce((a, b) => a + b, 0) / top.length;
    if (stateAvg[state] > maxAvg) maxAvg = stateAvg[state];
  }

  if (mapState.stateLayer) mapState.stateLayer.remove();
  mapState.stateLayer = L.geoJSON(geojson, {
    style: feature => {
      const name  = feature.properties?.name || '';
      const score = stateAvg[name] || 0;
      const frac  = maxAvg > 0 ? score / maxAvg : 0;
      // Gradient: light gray (no data/low) → deep blue → orange (elite)
      const hue   = frac > 0 ? Math.round(220 - frac * 160) : 0;
      const sat   = frac > 0 ? 70 : 0;
      const lit   = frac > 0 ? Math.round(65 - frac * 30) : 88;
      return { fillColor: `hsl(${hue},${sat}%,${lit}%)`, weight: 0.8, color: '#fff', fillOpacity: frac > 0 ? 0.8 : 0.25 };
    },
    onEachFeature: (feature, layer) => {
      const name  = feature.properties?.name || '?';
      const score = stateAvg[name];
      const count = byState[name]?.length || 0;
      layer.bindTooltip(
        `<strong>${esc(name)}</strong><br>` +
        (score ? `Avg top-10% skills: ${score.toFixed(0)}<br>${count} teams` : 'No data'),
        { sticky: true }
      );
    },
  }).addTo(mapState.leafletMap);

  mapState.leafletMap.fitBounds(mapState.stateLayer.getBounds(), { padding: [20, 20] });
  const legendEl = document.getElementById('map-legend');
  if (legendEl) legendEl.innerHTML +=
    '<div class="map-legend" style="margin-top:4px">' +
    '<span>Low</span><div class="map-legend-bar" style="background:linear-gradient(to right,#e5e7eb,#2563eb,#ea580c)"></div><span>Elite</span>' +
    '<span style="margin-left:auto;color:var(--text-muted);font-size:.75rem">Top-10% avg skills by US state</span></div>';
}

// ── Travel distance lines (event map mode) ─────────────────────────────────
function drawTravelLines() {
  if (!mapState.leafletMap || !mapState.eventId || !mapState.allTeams?.length) return;

  const venueLat = currentEvent?.location?.coordinates?.lat;
  const venueLon = currentEvent?.location?.coordinates?.lon;
  if (venueLat == null || venueLon == null) return;

  if (mapState.travelLayer) mapState.travelLayer.remove();
  mapState.travelLayer = L.layerGroup().addTo(mapState.leafletMap);

  // Venue marker
  L.circleMarker([venueLat, venueLon], {
    radius: 10, fillColor: '#F59E0B', color: '#fff', weight: 2, fillOpacity: 1,
  }).bindTooltip(`<strong>Venue</strong><br>${esc(currentEvent?.name || '')}`, { permanent: false })
    .addTo(mapState.travelLayer);

  const distances = [];
  for (const t of mapState.allTeams) {
    let lat = t.location?.coordinates?.lat;
    let lon = t.location?.coordinates?.lon;
    if (lat == null || lon == null) {
      const country = t.location?.country;
      if (country && COUNTRY_COORDS[country]) { [lat, lon] = COUNTRY_COORDS[country]; }
      else continue;
    }
    const km = haversineKm(venueLat, venueLon, lat, lon);
    distances.push({ t, lat, lon, km });
  }

  if (!distances.length) return;
  const maxKm = Math.max(...distances.map(d => d.km));

  for (const { t, lat, lon, km } of distances) {
    const frac  = maxKm > 0 ? km / maxKm : 0;
    const hue   = Math.round(120 - frac * 120); // green(120) → red(0)
    const color = `hsl(${hue},80%,45%)`;
    const mi    = (km * 0.621371).toFixed(0);

    // Use geodesic arc so the line follows the actual great-circle path on the globe
    // rather than a straight line in Mercator projection (critical for intercontinental routes)
    L.polyline(geodesicPoints(venueLat, venueLon, lat, lon), {
      color, weight: 1.2, opacity: 0.55,
    }).bindTooltip(
      `<strong>${esc(t.number || t.name)}</strong><br>${km.toFixed(0)} km / ${mi} mi`,
      { sticky: true }
    ).addTo(mapState.travelLayer);
  }

  distances.sort((a, b) => b.km - a.km);
  const top5 = distances.slice(0, 5).map(d =>
    `<tr><td>${esc(d.t.number||d.t.name)}</td><td>${d.km.toFixed(0)} km</td></tr>`
  ).join('');
  const legendEl = document.getElementById('map-legend');
  if (legendEl) legendEl.innerHTML +=
    `<div class="map-legend" style="margin-top:8px;flex-direction:column;align-items:flex-start;gap:4px">` +
    `<span style="font-size:.75rem;font-weight:700">Farthest travelers</span>` +
    `<table style="font-size:.75rem;border-collapse:collapse">${top5}</table>` +
    `<span style="font-size:.7rem;color:var(--text-muted)">green = local · red = far · ${distances.length} teams</span>` +
    `</div>`;
}

async function fetchProgramSeasons(programId) {
  if (_seasonListCache[programId]) return _seasonListCache[programId];
  try {
    const json = await apiFetch(`/seasons?program[]=${programId}&per_page=25`);
    const list = (json.data || []).map(s => ({ id: s.id, name: s.name }));
    _seasonListCache[programId] = list;
    // Also cache the first (active) id so getActiveSeasonId doesn't re-fetch
    if (list.length && _seasonIdCache[programId] === undefined) {
      _seasonIdCache[programId] = list[0].id;
    }
    return list;
  } catch { return []; }
}

async function getActiveSeasonId(programId) {
  if (_seasonIdCache[programId] !== undefined) return _seasonIdCache[programId];
  try {
    const json = await apiFetch(`/seasons?program[]=${programId}&active=true&per_page=1`);
    if (json.data?.length) return (_seasonIdCache[programId] = json.data[0].id);
    const fallback = await apiFetch(`/seasons?program[]=${programId}&per_page=1`);
    return (_seasonIdCache[programId] = fallback.data?.[0]?.id || null);
  } catch { return (_seasonIdCache[programId] = null); }
}

// Slim down a team object to only the fields the map needs, to keep the cache small.
function slimTeam(t) {
  return {
    id:       t.id,
    number:   t.number,
    name:     t.name,
    grade:    t.grade,
    program:  t.program?.id,
    location: t.location ? { country: t.location.country, region: t.location.region, city: t.location.city, coordinates: t.location.coordinates } : null,
  };
}

// ── Per-program localStorage cache (24 h TTL) ─────────────────────────────
function _progCacheKey(pid) { return `vexmap_prog2_${pid}`; }
function _readProgCache(pid) {
  try {
    const raw = localStorage.getItem(_progCacheKey(pid));
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts < 24 * 60 * 60 * 1000 && Array.isArray(data) && data.length > 0) return data;
  } catch (_) {}
  return null;
}
function _writeProgCache(pid, data) {
  const payload = { ts: Date.now(), data };
  try {
    localStorage.setItem(_progCacheKey(pid), JSON.stringify(payload));
  } catch (e) {
    // Quota exceeded — retry without city/region to shrink the payload
    try {
      const slim = data.map(t => ({
        ...t,
        location: t.location
          ? { country: t.location.country, coordinates: t.location.coordinates }
          : null,
      }));
      localStorage.setItem(_progCacheKey(pid), JSON.stringify({ ts: Date.now(), data: slim }));
    } catch (_) {
      console.warn('[map] localStorage quota exceeded for program', pid, '— map cache disabled');
    }
  }
}

// Pure fetcher — no caching. Calls onBatch(batch) as each page arrives.
// apiFetch already retries 429 automatically; this retries other transient errors per page.
async function fetchMapTeams(url, onBatch) {
  const sep = url.includes('?') ? '&' : '?';

  const first = await apiFetch(`${url}${sep}page=1&per_page=250`);
  if (!first.data?.length) return [];
  const all = first.data.map(slimTeam);
  const lastPage = first.meta?.last_page ?? 1;
  onBatch?.(all.slice());

  if (lastPage > 1) {
    const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    await promisePool(pages.map(p => async () => {
      // Retry each page up to 4 times with backoff for transient errors
      for (let attempt = 0; ; attempt++) {
        try {
          const json = await apiFetch(`${url}${sep}page=${p}&per_page=250`);
          if (json.data?.length) {
            const batch = json.data.map(slimTeam);
            all.push(...batch);
            onBatch?.(batch);
          }
          break;
        } catch (err) {
          if (attempt >= 4) break; // give up on this page after 4 retries
          await sleep(Math.min(2000 * Math.pow(2, attempt), 30000));
        }
      }
    }), 8);
  }

  return all;
}

async function loadMapData() {
  const gen = ++_mapLoadGen;
  const container = document.getElementById('map-container');
  mapState.grade = mapState.grade || 'all';

  // ── Event-specific map (no per-program cache) ──────────────────────────────
  if (mapState.eventId) {
    destroyLeafletMap();
    container.innerHTML = '<p class="empty" style="padding:20px">Loading…</p>';
    try {
      const teams = await fetchAllPages(`/events/${mapState.eventId}/teams`);
      if (gen !== _mapLoadGen) return;
      mapState.allTeams = teams;
      initLeafletMap();
      updateMapOverlay(teams);
    } catch (err) {
      if (!mapState.leafletMap) container.innerHTML = '<p class="empty">Error: ' + esc(err.message) + '</p>';
    }
    return;
  }

  // ── Global map — use per-program in-memory cache ───────────────────────────
  const programsNeeded = mapState.programId ? [mapState.programId] : [1, 4, 41];

  // Warm in-memory cache from localStorage for any program not yet loaded this session
  for (const pid of programsNeeded) {
    if (!_teamsByProgram[pid]) {
      const cached = _readProgCache(pid);
      if (cached) _teamsByProgram[pid] = cached;
    }
  }

  const missing = programsNeeded.filter(pid => !_teamsByProgram[pid]);

  // Everything already in memory → instant re-render, no network at all
  if (missing.length === 0) {
    const allTeams = programsNeeded.flatMap(pid => _teamsByProgram[pid]);
    mapState.allTeams = allTeams;
    initLeafletMap();
    updateMapOverlay(allTeams);
    return;
  }

  // Seed accTeams with any programs already cached so they appear immediately
  const accTeams = programsNeeded
    .filter(pid => _teamsByProgram[pid])
    .flatMap(pid => _teamsByProgram[pid]);

  // Only destroy/show spinner if we have no existing map content to show
  if (!mapState.leafletMap) {
    if (accTeams.length === 0) {
      container.innerHTML = '<p class="empty" style="padding:20px">Loading…</p>';
    }
  } else if (accTeams.length > 0) {
    // Map is live — immediately show what's cached while we fetch the rest
    updateMapOverlay(accTeams);
  }

  let renderTimer = null;
  function scheduleOverlayUpdate() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (gen !== _mapLoadGen) return;
      initLeafletMap();
      mapState.allTeams = accTeams.slice();
      updateMapOverlay(accTeams);
    }, 250);
  }

  try {
    await Promise.all(missing.map(async pid => {
      const seasonId = await getActiveSeasonId(pid);
      const url = `/teams?myTeams=false&registered=true&program[]=${pid}` +
        (seasonId ? `&season[]=${seasonId}` : '');
      // fetchMapTeams returns the complete array; use it for the cache write
      // so we don't depend on onBatch accumulation being intact
      const fetched = await fetchMapTeams(url, batch => {
        if (gen !== _mapLoadGen) return;
        accTeams.push(...batch);
        scheduleOverlayUpdate();
      });
      // Commit full dataset to in-memory cache and persist to localStorage
      if (gen === _mapLoadGen && fetched.length > 0) {
        _teamsByProgram[pid] = fetched;
        _writeProgCache(pid, fetched);
      }
    }));

    clearTimeout(renderTimer);
    if (gen !== _mapLoadGen) return;
    initLeafletMap();
    mapState.allTeams = accTeams.slice();
    updateMapOverlay(accTeams);
  } catch (err) {
    clearTimeout(renderTimer);
    if (!mapState.leafletMap) container.innerHTML = '<p class="empty">Error: ' + esc(err.message) + '</p>';
  }
}

function applyMapGradeFilter() {
  if (!mapState.allTeams) return;
  initLeafletMap();
  updateMapOverlay(mapState.allTeams);
}

function buildAndRenderMap(teams) {
  mapState.allTeams = teams;
  initLeafletMap();
  updateMapOverlay(teams);
}

function showMapDotsPanel(dot) {
  const panel = document.getElementById('map-country-panel');
  panel.classList.remove('hidden');
  const teams = dot.teams;
  const inEvent = !!mapState.eventId;
  const city    = dot.city    || '';
  const region  = dot.region  || '';
  const country = dot.country || teams[0]?.country || '';

  const locationLabel = [city, region, country].filter(Boolean).join(', ') || 'this location';

  let headerHtml =
    '<div class="map-panel-header">' +
    '<span class="map-panel-title">' + esc(locationLabel) + '</span>' +
    '<span class="map-panel-count">' + teams.length + ' team' + (teams.length !== 1 ? 's' : '') + '</span>' +
    '</div>';

  let rows;
  if (inEvent && Object.keys(cachedEventRankings).length > 0) {
    // Event context — show rank + record alongside team info
    const sorted = [...teams].sort((a, b) => {
      const ra = cachedEventRankings[a.number]?.rank ?? 999;
      const rb = cachedEventRankings[b.number]?.rank ?? 999;
      return ra - rb;
    });
    rows = sorted.map(t => {
      const r = cachedEventRankings[t.number];
      const rank   = r ? '#' + r.rank : '—';
      const record = r ? r.wins + '-' + r.losses + (r.ties ? '-' + r.ties : '') : '—';
      const wp     = r ? r.wp : '—';
      return '<tr>' +
        '<td>' + rank + '</td>' +
        '<td><button class="team-link map-team-link" data-num="' + esc(t.number) + '">' + esc(t.number) + '</button></td>' +
        '<td>' + esc(t.name) + '</td>' +
        '<td>' + record + '</td>' +
        '<td>' + wp + '</td>' +
        '</tr>';
    }).join('');

    headerHtml += '<div class="table-wrap"><table>' +
      '<thead><tr><th>Rank</th><th>Team</th><th>Name</th><th>Record</th><th>WP</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  } else {
    // Global context — show team info
    const sorted = [...teams].sort((a, b) =>
      (a.number || '').localeCompare(b.number || '', undefined, { numeric: true }));
    rows = sorted.map(t =>
      '<tr>' +
      '<td><button class="team-link map-team-link" data-num="' + esc(t.number) + '">' + esc(t.number) + '</button></td>' +
      '<td>' + esc(t.name) + '</td>' +
      '<td>' + esc(t.grade || '—') + '</td>' +
      '</tr>'
    ).join('');

    headerHtml += '<div class="table-wrap"><table>' +
      '<thead><tr><th>Team</th><th>Name</th><th>Grade</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  panel.innerHTML = '<div class="map-country-panel-inner">' + headerHtml + '</div>';

  // Wire team clicks
  panel.querySelectorAll('.map-team-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const num = btn.dataset.num;
      if (!num) return;
      if (inEvent) {
        openTeamEventView(num);
      } else {
        const t = dot.teams.find(x => x.number === num);
        const progParam = t?.programId ? `&program[]=${t.programId}` : '';
        apiFetch(`/teams?number[]=${encodeURIComponent(num)}${progParam}&myTeams=false`)
          .then(json => {
            const team = json.data?.[0];
            if (team) openSeasonsView(team);
          })
          .catch(() => {});
      }
    });
  });
}

// ── OPR / DPR / CCWM (least-squares, recency-weighted) ────────────────────
function computeOPR(qualMatches) {
  // Only use scored matches; sort oldest→newest so decay weights are correct
  const scored = qualMatches
    .filter(m => matchIsScored(m))
    .sort((a, b) => a.matchnum - b.matchnum);

  const teamNames = [];
  const teamIdx   = {};
  scored.forEach(m => {
    (m.alliances || []).forEach(a => {
      (a.teams || []).forEach(t => {
        const name = t.team?.name;
        if (name && !(name in teamIdx)) { teamIdx[name] = teamNames.length; teamNames.push(name); }
      });
    });
  });

  const n = teamNames.length;
  if (n === 0) return {};

  const N = scored.length;
  // Gentle exponential recency weighting: newest match weight = 1,
  // oldest = e^(−DECAY*N). DECAY=0.07 → after ~14 matches oldest is ~0.37× newest.
  const DECAY = 0.07;

  const ATA   = Array.from({ length: n }, () => new Array(n).fill(0));
  const ATb_o = new Array(n).fill(0);
  const ATb_d = new Array(n).fill(0);

  scored.forEach((m, idx) => {
    const w = Math.exp(DECAY * (idx - N + 1)); // ranges from e^(-N*DECAY) to 1
    const alliances = m.alliances || [];
    const red  = alliances.find(a => a.color === 'red')  || alliances[0];
    const blue = alliances.find(a => a.color === 'blue') || alliances[1];
    if (!red || !blue) return;

    for (const [ally, ownScore, oppScore] of [
      [red,  red.score,  blue.score],
      [blue, blue.score, red.score ],
    ]) {
      const indices = (ally.teams || [])
        .map(t => teamIdx[t.team?.name])
        .filter(i => i !== undefined);
      indices.forEach(i => {
        ATb_o[i] += ownScore * w;
        ATb_d[i] += oppScore * w;
        indices.forEach(j => { ATA[i][j] += w; });
      });
    }
  });

  const oprVals = gaussianElim(ATA.map(r => [...r]), [...ATb_o], n);
  const dprVals = gaussianElim(ATA.map(r => [...r]), [...ATb_d], n);

  const result = {};
  teamNames.forEach((name, i) => {
    const o = oprVals[i] ?? 0;
    const d = dprVals[i] ?? 0;
    result[name] = { opr: o, dpr: d, ccwm: o - d };
  });
  return result;
}

function gaussianElim(A, b, n) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let p = 0; p < n; p++) {
    let maxRow = p;
    for (let r = p + 1; r < n; r++) {
      if (Math.abs(M[r][p]) > Math.abs(M[maxRow][p])) maxRow = r;
    }
    [M[p], M[maxRow]] = [M[maxRow], M[p]];
    if (Math.abs(M[p][p]) < 1e-10) continue;
    for (let r = 0; r < n; r++) {
      if (r === p) continue;
      const f = M[r][p] / M[p][p];
      for (let c = p; c <= n; c++) M[r][c] -= f * M[p][c];
    }
  }
  return Array.from({ length: n }, (_, i) =>
    Math.abs(M[i][i]) > 1e-10 ? M[i][n] / M[i][i] : 0
  );
}

// ── Bracket & Alliance Selection ──────────────────────────────────────────────

// ── Elimination bracket simulator ─────────────────────────────────────────
// Compute a composite strength score for an alliance (array of team name strings).
// Combines OPR, CCWM, win rate, skills, and consistency into one number.
function allianceStrength(teams) {
  const opr   = teams.reduce((s, n) => s + (cachedOPR[n]?.opr  ?? cachedSeasonOPR[n]?.opr  ?? 0), 0);
  const ccwm  = teams.reduce((s, n) => s + (cachedOPR[n]?.ccwm ?? cachedSeasonOPR[n]?.ccwm ?? 0), 0);
  const wr    = teams.reduce((s, n) => s + (cachedEventRankings[n]?.winRate ?? 0.5), 0) / teams.length;
  const skill = teams.reduce((s, n) => s + (cachedEventSkills[n]?.combined ?? 0), 0);
  // Normalize skills to a comparable scale (~200 combined = roughly 2 pts contribution)
  return opr * 0.40 + ccwm * 0.25 + wr * 20 * 0.20 + (skill / 100) * 0.15;
}

// Simulate a single elimination match; returns 'A' or 'B'.
function simElimGame(teamsA, teamsB) {
  const sA    = allianceStrength(teamsA);
  const sB    = allianceStrength(teamsB);
  const tot   = sA + sB;
  const noise = Math.max(0, Math.min(0.5, predTuning.noise ?? 0.05));
  const base  = tot > 0 ? 0.5 + 0.45 * Math.tanh((sA - sB) / (tot * 0.35)) : 0.5;
  const probA = (1 - noise) * base + noise * 0.5;
  return Math.random() < probA ? 'A' : 'B';
}

// Best-of-3 series
function simBo3(teamsA, teamsB) {
  let wA = 0, wB = 0;
  while (wA < 2 && wB < 2) {
    simElimGame(teamsA, teamsB) === 'A' ? wA++ : wB++;
  }
  return { winner: wA > wB ? 'A' : 'B', wA, wB };
}

// Single-elimination bracket for N alliances.
// Pads to next power of 2 — top seeds get first-round byes.
// alliances: [{ label, teams: [name, ...] }]
// Returns rounds: [[{ aLabel, bLabel, aTeams, bTeams, wA, wB }], ...]
function runElimBracket(alliances) {
  const n = alliances.length;
  if (n < 2) return [];

  // Next power of 2 for bracket size
  let size = 2;
  while (size < n) size *= 2;

  // field[i] = alliance or null (BYE). Top seeds come first.
  let field = Array.from({ length: size }, (_, i) => (i < n ? alliances[i] : null));

  const rounds = [];

  while (field.length > 1) {
    const roundMatches = [];
    const nextField = [];
    const half = field.length / 2;

    // Pair seed i vs seed (size-1-i): top bracket vs bottom bracket
    for (let i = 0; i < half; i++) {
      const a = field[i];
      const b = field[field.length - 1 - i];

      if (!a && !b) continue;
      if (!a) { nextField.push(b); continue; } // b gets bye
      if (!b) { nextField.push(a); continue; } // a gets bye

      const { winner, wA, wB } = simBo3(a.teams, b.teams);
      roundMatches.push({ aLabel: a.label, bLabel: b.label, aTeams: a.teams, bTeams: b.teams, wA, wB });
      nextField.push(winner === 'A' ? a : b);
    }

    if (roundMatches.length > 0) rounds.push(roundMatches);
    field = nextField;
  }

  return rounds;
}

function renderSimBracket(alliances, yourLabel) {
  // alliances: [{ label, teams }]
  const rounds = runElimBracket(alliances);
  const total = rounds.length;
  const roundName = (ri) => {
    const fromEnd = total - 1 - ri;
    if (fromEnd === 0) return 'Finals';
    if (fromEnd === 1) return 'Semifinals';
    if (fromEnd === 2) return 'Quarterfinals';
    return `Round ${ri + 1}`;
  };

  const roundsHTML = rounds.map((matches, ri) => {
    const name = roundName(ri);
    const matchCards = matches.map(m => {
      const aWon = m.wA > m.wB, bWon = m.wB > m.wA;
      const aYours = m.aLabel === yourLabel, bYours = m.bLabel === yourLabel;
      return `<div class="sb-match">
        <div class="sb-row ${aWon ? 'sb-won' : 'sb-lost'} ${aYours ? 'sb-yours' : ''}">
          <span class="sb-label">${esc(m.aLabel)}</span>
          <span class="sb-teams">${m.aTeams.map(t => esc(t)).join(' / ')}</span>
          <span class="sb-score">${m.wA}</span>
        </div>
        <div class="sb-row ${bWon ? 'sb-won' : 'sb-lost'} ${bYours ? 'sb-yours' : ''}">
          <span class="sb-label">${esc(m.bLabel)}</span>
          <span class="sb-teams">${m.bTeams.map(t => esc(t)).join(' / ')}</span>
          <span class="sb-score">${m.wB}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="sb-round"><div class="sb-round-name">${name}</div>${matchCards}</div>`;
  }).join('');

  const finalMatch  = rounds[rounds.length - 1]?.[0];
  const champion    = finalMatch
    ? (finalMatch.wA > finalMatch.wB ? finalMatch.aLabel : finalMatch.bLabel)
    : '—';
  const youWon      = champion === yourLabel;

  return `
    <div class="stats-section">
      <div class="section-title">Simulated Elimination Bracket
        <span class="sim-badge">Simulated</span>
      </div>
      <p class="pl-info">Win probability uses OPR (40%) + CCWM (25%) + Win Rate (20%) + Skills (15%). Best-of-3 series.</p>
      <div class="sb-bracket">${roundsHTML}</div>
      <div class="sb-champion">${youWon ? '🏆 Your alliance wins the event!' : `Champion: ${esc(champion)}`}</div>
    </div>`;
}

function simulateAllianceSelection() {
  const ranked = Object.entries(cachedEventRankings).sort(([,a],[,b]) => a.rank - b.rank);
  if (ranked.length < 4) return [];
  // VEX alliances = 2 teams: captain + 1 partner
  const n = Math.min(8, Math.floor(ranked.length / 2));
  const opr = { ...cachedSeasonOPR, ...cachedOPR };
  const all = ranked.map(([name, r]) => ({ name, rank: r.rank }));
  const captains = all.slice(0, n);
  // Available = everyone not a captain (captains can't be picked in simulated bracket projection)
  const available = all.slice(n);
  const alliances = captains.map((c, i) => ({ num: i + 1, captain: c, picks: [] }));

  // Single round: each captain picks 1 partner in seeding order, by OPR
  for (let ai = 0; ai < n; ai++) {
    if (!available.length) break;
    available.sort((a, b) => (opr[b.name]?.opr ?? 0) - (opr[a.name]?.opr ?? 0));
    alliances[ai].picks.push(available.shift());
  }
  return alliances;
}

function renderBracketTab(rawAlliances, matches) {
  const hasReal = rawAlliances.length > 0;
  let allianceList = [];

  if (hasReal) {
    allianceList = rawAlliances.map(a => {
      const teams = a.teams || [];
      const captain = teams.find(t => t.captain)?.team || teams[0]?.team;
      const picks   = teams.filter(t => !t.captain).map(t => t.team);
      return { num: a.number, captain: { name: captain?.name || '?' }, picks: picks.map(t => ({ name: t?.name || '?' })) };
    }).sort((a, b) => a.num - b.num);
  } else {
    allianceList = simulateAllianceSelection();
  }

  return renderAllianceSection(allianceList, hasReal) + renderEliminationBracket(matches, allianceList);
}

function renderAllianceSection(alliances, isReal) {
  const qualTeams = Object.keys(cachedEventRankings).length;
  const opr = { ...cachedSeasonOPR, ...cachedOPR };

  if (!alliances.length) return `<div class="stats-section"><div class="section-title">Alliances</div><p class="empty">Not enough ranking data to project alliances.</p></div>`;

  const cards = alliances.map(a => {
    function teamChip(t, role) {
      const o = opr[t.name]?.opr;
      return `<div class="alliance-member">
        <span class="alliance-role-tag ${role}">${role === 'C' ? 'Captain' : 'Pick ' + (role)}</span>
        <button class="team-link alliance-team-btn" data-num="${esc(t.name)}">${esc(t.name)}</button>
        ${o != null ? `<span class="alliance-opr">OPR ${o.toFixed(1)}</span>` : ''}
      </div>`;
    }
    return `<div class="alliance-card">
      <div class="alliance-num-badge">#${a.num}</div>
      ${teamChip(a.captain, 'C')}
      ${a.picks.map((p, i) => teamChip(p, i + 1)).join('')}
    </div>`;
  }).join('');

  const diffHtml = qualTeams ? computeEventDifficultyHTML() : '';

  return `<div class="stats-section">
    <div class="section-title">Alliances ${!isReal ? '<span class="sim-badge">Simulated</span>' : ''}</div>
    ${!isReal ? `<p class="sim-info">Projected from qual rankings: top ${alliances.length} teams as captains, each picks 1 partner by OPR.</p>` : ''}
    <div class="alliance-grid">${cards}</div>
    ${diffHtml}
  </div>`;
}

function computeEventDifficultyHTML() {
  const oprVals = Object.values(cachedOPR).map(o => o.opr).filter(v => v > 0);
  const skillVals = Object.values(cachedEventSkills).map(s => s.driver + s.prog).filter(v => v > 0);
  if (!oprVals.length && !skillVals.length) return '';

  const avgOPR   = oprVals.length   ? oprVals.reduce((a,b)=>a+b,0)   / oprVals.length   : null;
  const avgSkill = skillVals.length ? skillVals.reduce((a,b)=>a+b,0) / skillVals.length : null;
  const maxSkill = skillVals.length ? Math.max(...skillVals) : null;
  const numTeams = Object.keys(cachedEventRankings).length;

  // Rough difficulty score 0-100 based on avg OPR (calibrated to ~V5RC norms)
  const oprScore   = avgOPR   != null ? Math.min(100, Math.round(avgOPR   / 1.2))  : null;
  const skillScore = avgSkill != null ? Math.min(100, Math.round(avgSkill / 2.5))  : null;
  const combined   = [oprScore, skillScore].filter(v=>v!=null);
  const diffScore  = combined.length ? Math.round(combined.reduce((a,b)=>a+b,0)/combined.length) : null;

  const label = diffScore == null ? '—'
    : diffScore >= 75 ? 'Very Competitive'
    : diffScore >= 55 ? 'Competitive'
    : diffScore >= 35 ? 'Moderate'
    : 'Developing';
  const color = diffScore == null ? 'var(--text-muted)'
    : diffScore >= 75 ? '#DC2626'
    : diffScore >= 55 ? '#D97706'
    : diffScore >= 35 ? '#2563EB'
    : 'var(--text-muted)';

  const stat = (lbl, val) => val != null ? `<div class="diff-stat"><span class="diff-stat-label">${lbl}</span><span class="diff-stat-val">${val}</span></div>` : '';

  return `<div class="difficulty-card">
    <div class="difficulty-label">Event Difficulty</div>
    <div class="difficulty-score" style="color:${color}">${label}${diffScore != null ? ` <span style="font-size:.75rem;font-weight:400;opacity:.7">(${diffScore}/100)</span>` : ''}</div>
    <div class="diff-stats-row">
      ${stat('Teams', numTeams)}
      ${stat('Avg OPR', avgOPR != null ? avgOPR.toFixed(1) : null)}
      ${stat('Avg Skills', avgSkill != null ? Math.round(avgSkill) : null)}
      ${stat('Top Skills', maxSkill)}
    </div>
  </div>`;
}

function renderEliminationBracket(matches, alliances) {
  const elimMatches = matches.filter(m => m.round >= 3);

  const teamAlliance = {};
  alliances.forEach(a => {
    [a.captain, ...a.picks].forEach(t => { if (t?.name) teamAlliance[t.name] = a.num; });
  });

  const groups = {};
  elimMatches.forEach(m => {
    const key = `${m.round}-${m.instance || 1}`;
    (groups[key] = groups[key] || []).push(m);
  });

  function matchupCard(games) {
    const first = games[0];
    const redA   = first?.alliances?.find(a => a.color === 'red');
    const blueA  = first?.alliances?.find(a => a.color === 'blue');
    const redTeams  = (redA?.teams  || []).map(t => t.team?.name).filter(Boolean);
    const blueTeams = (blueA?.teams || []).map(t => t.team?.name).filter(Boolean);

    let redWins = 0, blueWins = 0;
    const gamePairs = [];
    games.forEach(g => {
      if (!matchIsScored(g)) return;
      const r = g.alliances?.find(a => a.color === 'red');
      const b = g.alliances?.find(a => a.color === 'blue');
      if (!r || !b) return;
      gamePairs.push([r.score, b.score]);
      if (r.score > b.score) redWins++; else if (b.score > r.score) blueWins++;
    });
    const winner = redWins >= 2 ? 'red' : blueWins >= 2 ? 'blue' : null;

    function alNum(teams) {
      const n = teams.map(t => teamAlliance[t]).filter(Boolean);
      return n.length ? [...new Set(n)][0] : null;
    }

    function teamRow(teams, wins, isRed) {
      const al  = alNum(teams);
      const won = winner === (isRed ? 'red' : 'blue');
      const lost = winner && !won;
      const chips = teams.map(t =>
        `<button class="team-link bk-team-btn" data-num="${esc(t)}">${esc(t)}</button>`
      ).join('');
      return `<div class="bk-row${won ? ' bk-won' : lost ? ' bk-lost' : ''}">
        ${al ? `<span class="bk-al-tag">#${al}</span>` : ''}
        <span class="bk-teams">${chips}</span>
        ${gamePairs.length ? `<span class="bk-wins">${wins}</span>` : ''}
      </div>`;
    }

    const scoreStr = gamePairs.map(([r,b]) => `${r}–${b}`).join(' · ');

    return `<div class="bk-match">
      ${teamRow(redTeams,  redWins,  true)}
      ${teamRow(blueTeams, blueWins, false)}
      ${scoreStr ? `<div class="bk-scores">${scoreStr}</div>` : ''}
    </div>`;
  }

  const ROUND_ORDER  = [6, 3, 4, 5];
  const ROUND_LABELS = { 6: 'R16', 3: 'Quarterfinals', 4: 'Semifinals', 5: 'Finals' };

  const usedRounds = ROUND_ORDER.filter(r => Object.keys(groups).some(k => k.startsWith(`${r}-`)));
  if (!usedRounds.length) return `<div class="stats-section"><div class="section-title">Elimination Bracket</div><p class="empty">Elimination matches have not started yet.</p></div>`;

  const cols = usedRounds.map(r => {
    const keys = Object.keys(groups).filter(k => k.startsWith(`${r}-`)).sort();
    return `<div class="bk-col">
      <div class="bk-round-label">${ROUND_LABELS[r]}</div>
      <div class="bk-col-matches">${keys.map(k => matchupCard(groups[k])).join('')}</div>
    </div>`;
  }).join('');

  return `<div class="stats-section">
    <div class="section-title">Elimination Bracket</div>
    <div class="bk-wrap">${cols}</div>
  </div>`;
}

// ── Award classification ────────────────────────────────────────────────────
// criteria values:
//   'top40'      — top 40% qual rank + top 40% combined skills + programming skills > 0 (Excellence)
//   'qual_rank'  — determined by elimination bracket result (Tournament Champions/Finalists)
//   'skills'     — highest combined robot skills score
//   'auto_gt0'   — must have programming skills score > 0; otherwise judged (Think Award)
//   'skills_rank'— strong combined skills + qual rank (Amaze / Innovate qualifier)
//   'notebook'   — fully judged: any team eligible regardless of performance
//   'none'       — purely discretionary / behavioral
const AWARD_INFO = {
  excellence:    { icon: '🏆', cat: 'excellence',  criteria: 'top40',
    desc: 'Top 40% qual rank · top 40% combined skills · programming skills > 0 required · judged' },
  champion:      { icon: '🥇', cat: 'performance', criteria: 'qual_rank',
    desc: 'Won the elimination finals' },
  finalist:      { icon: '🥈', cat: 'performance', criteria: 'qual_rank',
    desc: 'Runner-up in the elimination finals' },
  skills_champ:  { icon: '⚙️', cat: 'performance', criteria: 'skills',
    desc: 'Highest combined Driver + Programming Skills score at this event' },
  skills_2nd:    { icon: '🎖️', cat: 'performance', criteria: 'skills',
    desc: 'Second-highest combined Skills score' },
  high_score:    { icon: '📈', cat: 'performance', criteria: 'qual_rank',
    desc: 'Highest single-match alliance score recorded at this event' },
  design:        { icon: '📐', cat: 'notebook',    criteria: 'notebook',
    desc: 'Outstanding engineering design process — judged on notebook + interview · any team eligible' },
  innovate:      { icon: '💡', cat: 'notebook',    criteria: 'notebook',
    desc: 'Novel or innovative robot design — judged · any team eligible' },
  think:         { icon: '🧠', cat: 'notebook',    criteria: 'auto_gt0',
    desc: 'Outstanding autonomous programming — must have programming skills score > 0 · judged' },
  amaze:         { icon: '✨', cat: 'notebook',    criteria: 'skills_rank',
    desc: 'Excellent performance across skills challenges and qual matches · judged' },
  build:         { icon: '🔧', cat: 'notebook',    criteria: 'notebook',
    desc: 'Exceptional robot construction quality — judged · any team eligible' },
  create:        { icon: '🎨', cat: 'notebook',    criteria: 'notebook',
    desc: 'Creative solution to the game challenge — judged · any team eligible' },
  judges:        { icon: '⚖️', cat: 'special',     criteria: 'none',
    desc: 'Special recognition at judges\' discretion — any team eligible' },
  inspire:       { icon: '🌟', cat: 'conduct',     criteria: 'none',
    desc: 'Ambassador for VEX — passion, positivity, and community engagement · any team eligible' },
  sportsmanship: { icon: '🤝', cat: 'conduct',     criteria: 'none',
    desc: 'Exemplary gracious professionalism throughout the event · any team eligible' },
  energy:        { icon: '⚡', cat: 'conduct',     criteria: 'none',
    desc: 'Outstanding enthusiasm and team spirit · any team eligible' },
  other:         { icon: '🏅', cat: 'other',       criteria: 'none', desc: '' },
};

function classifyAward(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('excellence'))                                                           return 'excellence';
  if (t.includes('tournament champion') || t.includes('division champion') ||
      t.includes('teamwork champion')   || t.includes('teamwork challenge champion'))    return 'champion';
  if (t.includes('robot skills champion') || t.includes('skills challenge champion') ||
      (t.includes('skills') && t.includes('champion')))                                 return 'skills_champ';
  if (t.includes('finalist') || (t.includes('second place') && !t.includes('skills'))) return 'finalist';
  if (t.includes('skills') && (t.includes('2nd') || t.includes('second')))             return 'skills_2nd';
  if (t.includes('high score') || t.includes('highest score'))                          return 'high_score';
  if (t.includes('design'))                                                              return 'design';
  if (t.includes('innovate') || t.includes('innovation'))                               return 'innovate';
  if (t.includes('think'))                                                               return 'think';
  if (t.includes('amaze'))                                                               return 'amaze';
  if (t.includes('build'))                                                               return 'build';
  if (t.includes('create') || t.includes('creative'))                                   return 'create';
  if (t.includes('judge') || t.includes("judges'") || t.includes("judge's"))           return 'judges';
  if (t.includes('inspire') || t.includes('inspiration'))                               return 'inspire';
  if (t.includes('sportsmanship') || t.includes('spirit'))                              return 'sportsmanship';
  if (t.includes('energy') || t.includes('enthusiasm'))                                 return 'energy';
  return 'other';
}

// Extract all winners from an award object.
// The RobotEvents v2 API returns:
//   a.teamWinners       = [{ team: { id, name, number }, division: { id, name } }]
//   a.individualWinners = ["Person Name", ...]
function extractAwardWinners(a) {
  if (!a) return [];
  const results = [];
  const seen = new Set();

  for (const t of (a.teamWinners || [])) {
    const teamName = t.team?.name || t.team?.number;
    if (teamName && !seen.has(teamName)) {
      seen.add(teamName);
      results.push({ kind: 'team', name: teamName, division: t.division?.name || null });
    }
  }

  for (const w of (a.individualWinners || [])) {
    if (!w || seen.has(w)) continue;
    seen.add(w);
    results.push({ kind: 'person', name: w });
  }

  return results;
}

// ── Award eligibility / prediction helpers ─────────────────────────────────

function awardsTop40Eligible() {
  const rankEntries = Object.entries(cachedEventRankings);
  const total = rankEntries.length;
  if (!total) return [];

  const qualCutoff = Math.ceil(total * 0.4);

  // Skills ranking (by combined score)
  const skillsRanked = Object.entries(cachedEventSkills)
    .sort(([, a], [, b]) => (b.driver + b.prog) - (a.driver + a.prog));
  const skillsCutoffScore = skillsRanked[Math.ceil(skillsRanked.length * 0.4) - 1]?.[1]?.combined ?? 0;

  // Autonomous-only ranking — must have score > 0 AND be in top 40%
  const autoRanked = Object.entries(cachedEventSkills)
    .filter(([, s]) => (s.prog || 0) > 0)
    .sort(([, a], [, b]) => b.prog - a.prog);
  const autoCutoffScore = autoRanked[Math.ceil(autoRanked.length * 0.4) - 1]?.[1]?.prog ?? 1;

  return rankEntries
    .filter(([name, r]) => {
      if (r.rank > qualCutoff) return false;
      const sk = cachedEventSkills[name];
      if (!sk) return false;
      if (sk.combined < skillsCutoffScore) return false;
      if ((sk.prog || 0) < autoCutoffScore) return false;
      return true;
    })
    .map(([name]) => name);
}

// Points assigned to each prior-event judged award type when building the history bonus.
// Excellence at a prior event is the strongest signal; conduct/special awards count minimally.
const PRIOR_AWARD_WEIGHTS = {
  excellence:    5.0,
  design:        4.0,
  innovate:      3.0,
  think:         3.0,
  amaze:         2.5,
  build:         2.0,
  create:        2.0,
  judges:        1.0,
  inspire:       0.5,
  sportsmanship: 0.5,
};

// Returns a 0–1 composite score for Excellence / Sportsmanship prediction.
// When prior award scores are available (cachedPriorAwardScores loaded), blends them in.
// Weights without history : 40% qual, 35% skills, 25% auto
// Weights with history    : 35% qual, 30% skills, 20% auto, 15% prior awards
function compositeAwardScore(name) {
  const r   = cachedEventRankings[name];
  const sk  = cachedEventSkills[name];
  const tot = Object.keys(cachedEventRankings).length;

  const qualPct = (r && tot > 1) ? (tot - r.rank) / (tot - 1) : 0;
  const skPct   = sk?.normalized ?? 0;

  const autoVals    = Object.values(cachedEventSkills).map(s => s.prog || 0).sort((a, b) => b - a);
  const autoRankIdx = sk ? autoVals.findIndex(v => v <= (sk.prog || 0)) : autoVals.length;
  const autoPct     = autoVals.length > 1 ? (autoVals.length - autoRankIdx - 1) / (autoVals.length - 1) : 0;

  const hasPrior = cachedPriorAwardScores && Object.keys(cachedPriorAwardScores).length > 0;
  if (!hasPrior) {
    return qualPct * 0.40 + skPct * 0.35 + autoPct * 0.25;
  }

  // Normalise prior scores to 0–1 against the max among eligible teams
  const allPrior = Object.values(cachedPriorAwardScores);
  const maxPrior = Math.max(1, ...allPrior);
  const priorPct = Math.min(1, (cachedPriorAwardScores[name] || 0) / maxPrior);

  return qualPct * 0.35 + skPct * 0.30 + autoPct * 0.20 + priorPct * 0.15;
}

// ── Event Awards ───────────────────────────────────────────────────────────
function renderEventAwards(awards) {
  const hasRankings  = Object.keys(cachedEventRankings).length > 0;
  const hasSkills    = Object.keys(cachedEventSkills).length > 0;
  const pastEvent    = currentEvent?.end ? new Date(currentEvent.end) < new Date() : false;
  const worldsQual   = isWorldsStyleEvent() && !isDomeDivision();
  const worldsDome   = isWorldsStyleEvent() && isDomeDivision();
  const DOME_ONLY    = new Set(['champion', 'finalist', 'excellence']);

  // ── Prediction helpers ─────────────────────────────────────────────────────
  function predExcellence() {
    // Worlds Dome note (no local ranking data available)
    if (worldsDome) {
      return `<div class="award-pred-note-block award-worlds-note">
        <strong>VEX Worlds Dome:</strong> Excellence is awarded to a team from any division that won Excellence at a qualifying event this season.
      </div>`;
    }

    // Standard event — top 40% qual + skills + auto > 0
    if (!hasRankings || !hasSkills) return `<div class="award-pred-note-block">Loads once rankings and skills data are available.</div>`;
    const eligible = awardsTop40Eligible();
    if (!eligible.length) return `<div class="award-pred-note-block">No teams currently meet the top-40% threshold across qual rank, combined skills, and auto skills.</div>`;

    const rows = eligible
      .map(name => ({ name, score: compositeAwardScore(name) }))
      .sort((a, b) => b.score - a.score)
      .map((e, i) => {
        const r  = cachedEventRankings[e.name];
        const sk = cachedEventSkills[e.name];
        return `<tr>
          <td class="aw-rank">${i + 1}</td>
          <td><button class="team-link" data-num="${esc(e.name)}">${esc(e.name)}</button></td>
          <td class="aw-stat">Q${r?.rank ?? '—'}</td>
          <td class="aw-stat">${sk ? sk.driver + sk.prog : '—'}</td>
          <td class="aw-stat">${sk?.prog ?? '—'}</td>
          <td class="aw-score-bar"><div class="aw-bar-fill" style="width:${Math.round(e.score*100)}%"></div><span>${Math.round(e.score*100)}%</span></td>
        </tr>`;
      }).join('');
    const weightNote = '40% qual · 35% skills · 25% auto';
    return `<div class="award-pred-section">
      <div class="award-pred-title">Eligible teams <span class="award-pred-note">(${weightNote})</span></div>
      <div class="table-wrap"><table class="award-table">
        <thead><tr><th>#</th><th>Team</th><th>Qual</th><th>Skills</th><th>Auto</th><th>Score</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function predQualRank() {
    if (!hasRankings) return `<div class="award-pred-note-block">Determined by elimination bracket result.</div>`;
    const top = Object.entries(cachedEventRankings).sort(([,a],[,b]) => a.rank - b.rank).slice(0, 5);
    const rows = top.map(([name, r]) => `<tr>
      <td class="aw-rank">${r.rank}</td>
      <td><button class="team-link" data-num="${esc(name)}">${esc(name)}</button></td>
      <td class="aw-stat">${r.wins}–${r.losses}–${r.ties}</td>
      <td class="aw-stat">WP ${r.wp ?? '—'}</td>
    </tr>`).join('');
    return `<div class="award-pred-section"><div class="award-pred-title">Current qual standings (top 5)</div>
      <div class="table-wrap"><table class="award-table">
        <thead><tr><th>Rank</th><th>Team</th><th>W-L-T</th><th>WP</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function predSkills() {
    if (!hasSkills) return `<div class="award-pred-note-block">Determined by highest combined skills score.</div>`;
    const top = Object.entries(cachedEventSkills).sort(([,a],[,b]) => (b.driver+b.prog)-(a.driver+a.prog)).slice(0, 5);
    const rows = top.map(([name, sk], i) => `<tr>
      <td class="aw-rank">#${i+1}</td>
      <td><button class="team-link" data-num="${esc(name)}">${esc(name)}</button></td>
      <td class="aw-stat">${sk.driver}</td><td class="aw-stat">${sk.prog}</td>
      <td class="aw-stat" style="font-weight:700">${sk.driver+sk.prog}</td>
    </tr>`).join('');
    return `<div class="award-pred-section"><div class="award-pred-title">Current skills standings (top 5)</div>
      <div class="table-wrap"><table class="award-table">
        <thead><tr><th>#</th><th>Team</th><th>Driver</th><th>Auto</th><th>Combined</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function predAutoGt0() {
    if (!hasSkills) return `<div class="award-pred-note-block">Requires programming skills score > 0 · otherwise fully judged.</div>`;
    const eligible = Object.entries(cachedEventSkills).filter(([,sk]) => (sk.prog||0) > 0).sort(([,a],[,b]) => b.prog - a.prog).slice(0, 8);
    if (!eligible.length) return `<div class="award-pred-note-block">No teams have a programming skills score yet.</div>`;
    const rows = eligible.map(([name, sk], i) => `<tr>
      <td class="aw-rank">#${i+1}</td>
      <td><button class="team-link" data-num="${esc(name)}">${esc(name)}</button></td>
      <td class="aw-stat" style="font-weight:700">${sk.prog}</td>
    </tr>`).join('');
    return `<div class="award-pred-section"><div class="award-pred-title">Teams with programming skills score > 0 (${eligible.length})</div>
      <div class="table-wrap"><table class="award-table">
        <thead><tr><th>#</th><th>Team</th><th>Auto Score</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function predSkillsRank() {
    if (!hasSkills) return `<div class="award-pred-note-block">Based on combined skills + qual performance · judged.</div>`;
    const names = [...new Set([...Object.keys(cachedEventSkills), ...Object.keys(cachedEventRankings)])];
    const tot = Object.keys(cachedEventRankings).length;
    const rows = names.map(name => {
      const sk = cachedEventSkills[name]; const r = cachedEventRankings[name];
      const skPct  = sk?.normalized ?? 0;
      const rnkPct = (r && tot > 1) ? (tot - r.rank) / (tot - 1) : 0;
      return { name, score: skPct * 0.6 + rnkPct * 0.4, sk, r };
    }).sort((a,b) => b.score - a.score).slice(0, 8).map((e, i) => `<tr>
      <td class="aw-rank">#${i+1}</td>
      <td><button class="team-link" data-num="${esc(e.name)}">${esc(e.name)}</button></td>
      <td class="aw-stat">${e.sk ? e.sk.driver + e.sk.prog : '—'}</td>
      <td class="aw-stat">${e.r ? 'Q' + e.r.rank : '—'}</td>
      <td class="aw-score-bar"><div class="aw-bar-fill" style="width:${Math.round(e.score*100)}%"></div><span>${Math.round(e.score*100)}%</span></td>
    </tr>`).join('');
    return `<div class="award-pred-section"><div class="award-pred-title">Top performers (60% skills · 40% qual)</div>
      <div class="table-wrap"><table class="award-table">
        <thead><tr><th>#</th><th>Team</th><th>Skills</th><th>Qual</th><th>Score</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  // ── Single award card ──────────────────────────────────────────────────────
  function renderAwardCard(a) {
    const type    = classifyAward(a?.title);
    const info    = AWARD_INFO[type] || AWARD_INFO.other;
    const winners = extractAwardWinners(a);
    const given   = winners.length > 0;

    const quals = (a?.qualifications?.length)
      ? `<div class="award-qual-tag">Qualifies: ${esc(a.qualifications.join(', '))}</div>` : '';

    // Winner display — team numbers become clickable links; person names are plain text
    let winnerHtml = '';
    if (given) {
      const chips = winners.map(w =>
        w.kind === 'team'
          ? `<button class="team-link award-winner-btn" data-num="${esc(w.name)}">${esc(w.name)}</button>` +
            (w.division ? `<span class="award-winner-div">${esc(w.division)}</span>` : '')
          : `<span class="award-person">${esc(w.name)}</span>`
      ).join('');
      winnerHtml = `<div class="award-winner-row"><span class="award-winner-label">Winner</span>${chips}</div>`;
    }

    // Prediction block — only for pending awards
    let predHtml = '';
    if (!given) {
      if      (type === 'excellence')               predHtml = predExcellence();
      else if (info.criteria === 'qual_rank')        predHtml = predQualRank();
      else if (info.criteria === 'skills')           predHtml = predSkills();
      else if (info.criteria === 'auto_gt0')         predHtml = predAutoGt0();
      else if (info.criteria === 'skills_rank')      predHtml = predSkillsRank();
      else if (info.criteria === 'notebook')
        predHtml = `<div class="award-pred-note-block">Judged award — any team eligible regardless of performance standings.</div>`;
      else
        predHtml = `<div class="award-pred-note-block">Determined by judges or event staff.</div>`;
    }

    const badge = given
      ? '<span class="award-given-badge">Awarded</span>'
      : pastEvent
      ? '<span class="award-pending-badge award-not-recorded">Not Recorded</span>'
      : '<span class="award-pending-badge">Pending</span>';

    return `<div class="award-card award-cat-${info.cat}${given ? ' award-given' : ''}">
      <div class="award-card-header">
        <span class="award-icon">${info.icon}</span>
        <div class="award-card-title-block">
          <div class="award-card-name">${esc(a?.title || type)}</div>
          <div class="award-card-desc">${info.desc}</div>
        </div>
        ${badge}
      </div>
      ${quals}
      ${winnerHtml}
      ${predHtml}
    </div>`;
  }

  // ── Build final HTML ───────────────────────────────────────────────────────
  const CAT_ORDER = { excellence: 0, performance: 1, notebook: 2, special: 3, conduct: 4, other: 5 };
  const sorted = [...awards].sort((a, b) => {
    const ta = classifyAward(a.title), tb = classifyAward(b.title);
    const pa = CAT_ORDER[AWARD_INFO[ta]?.cat] ?? 5, pb = CAT_ORDER[AWARD_INFO[tb]?.cat] ?? 5;
    return pa !== pb ? pa - pb : (a.order || 0) - (b.order || 0);
  });

  // Worlds division filtering
  const visible = sorted.filter(a => {
    const t = classifyAward(a.title);
    if (worldsQual && t === 'excellence') return false;
    if (worldsDome && !DOME_ONLY.has(t))  return false;
    return true;
  });

  if (!awards.length) {
    // No data from API yet — show prediction-only cards
    let types = ['excellence', 'champion', 'skills_champ', 'design', 'think', 'build', 'create', 'judges'];
    if (worldsQual) types = types.filter(t => t !== 'excellence');
    if (worldsDome) types = ['champion', 'finalist', 'excellence'];
    const cards = types.map(type => renderAwardCard({ title: AWARD_INFO[type]?.icon + ' ' + type })).join('');
    return `<div class="stats-section">
      <div class="section-title">Awards</div>
      <p class="sim-info">No awards have been announced yet — showing eligibility based on current standings.</p>
      <div class="awards-grid">${cards}</div>
    </div>`;
  }

  if (!visible.length) {
    const note = worldsQual
      ? 'Qualification division — Excellence is given at the Dome ceremony. Tournament Champions and Finalists are awarded per division.'
      : 'No awards to display for this division.';
    return `<div class="stats-section">
      <div class="section-title">Awards</div>
      <p class="sim-info">${note}</p>
    </div>`;
  }

  const givenCount   = visible.filter(a => extractAwardWinners(a).length > 0).length;
  const pendingCount = visible.length - givenCount;
  const statusNote   = givenCount === visible.length
    ? `All ${givenCount} award${givenCount !== 1 ? 's' : ''} recorded.`
    : pendingCount === visible.length
    ? (pastEvent ? 'Award winners were not entered in RobotEvents for this event.' : 'No awards announced yet.')
    : `${givenCount} awarded · ${pendingCount} ${pastEvent ? 'not recorded' : 'pending'}`;

  return `<div class="stats-section">
    <div class="section-title">Awards (${visible.length})</div>
    <p class="sim-info">${statusNote}</p>
    <div class="awards-grid">${visible.map(renderAwardCard).join('')}</div>
  </div>`;
}

// ── Event Skills (grouped by team) ─────────────────────────────────────────
function renderEventSkills(skills) {
  if (!skills.length) return `
    <div class="stats-section">
      <div class="section-title">Skills</div>
      <p class="empty">No skills data available.</p>
    </div>`;

  // One entry per team showing both driver and programming
  const byTeam = {};
  skills.forEach(s => {
    const name = s.team?.name || '?';
    if (!byTeam[name]) byTeam[name] = { name };
    if (s.type === 'driver')      byTeam[name].driver = s;
    else if (s.type === 'programming') byTeam[name].prog = s;
  });

  const teams = Object.values(byTeam).sort((a, b) => {
    const aTotal = (a.driver?.score || 0) + (a.prog?.score || 0);
    const bTotal = (b.driver?.score || 0) + (b.prog?.score || 0);
    return bTotal - aTotal;
  });

  const rows = teams.map((t, i) => {
    const dScore   = t.driver?.score ?? null;
    const pScore   = t.prog?.score   ?? null;
    const combined = (dScore ?? 0) + (pScore ?? 0);
    // Use the rank from whichever type has one (prefer driver)
    const rank     = t.driver?.rank ?? t.prog?.rank ?? (i + 1);
    return `<tr>
      <td><span class="rank-badge">#${rank}</span></td>
      <td><button class="team-link" data-num="${esc(t.name)}">${esc(t.name)}</button></td>
      <td style="font-weight:600">${dScore ?? '—'}</td>
      <td style="font-weight:600">${pScore ?? '—'}</td>
      <td style="font-weight:700;color:var(--accent)">${combined || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="stats-section">
      <div class="section-title">Skills Scores</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Rank</th><th>Team</th><th>Driver</th><th>Programming</th><th>Combined</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Event Teams ────────────────────────────────────────────────────────────
function renderEventTeams(teams) {
  if (!teams.length) return `
    <div class="stats-section">
      <div class="section-title">Teams</div>
      <p class="empty">No team data available.</p>
    </div>`;
  const sorted = [...teams].sort((a, b) =>
    a.number.localeCompare(b.number, undefined, { numeric: true }));
  const rows = sorted.map(t => {
    const loc = [t.location?.city, t.location?.region].filter(Boolean).join(', ') || '—';
    return `<tr>
      <td><button class="team-link" data-num="${esc(t.number)}">${esc(t.number)}</button></td>
      <td>${esc(t.team_name) || '—'}</td>
      <td>${esc(t.robot_name) || '—'}</td>
      <td>${esc(t.organization) || '—'}</td>
      <td>${esc(loc)}</td>
      <td>${esc(t.grade) || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Teams (${teams.length})</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Team #</th><th>Name</th><th>Robot</th><th>Organization</th><th>Location</th><th>Grade</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASONS VIEW
// ═══════════════════════════════════════════════════════════════════════════

async function openSeasonsView(team) {
  currentTeam = team;
  showView('view-seasons');
  const teamHeroEl = document.getElementById('team-hero');
  teamHeroEl.innerHTML = teamHeroHTML(team, false);
  teamHeroEl.querySelector('.follow-team-btn')?.addEventListener('click', () => {
    if (isFollowingTeam(team.number)) {
      unfollowTeam(team.number);
    } else {
      followTeam(team.number, team.team_name || team.number, team.program?.name || '');
      addNotification(`Now following team ${team.number}`, 'info');
    }
    updateFollowButtons();
  });
  clearStatus('seasons');
  document.getElementById('seasons-grid').innerHTML = '';
  setStatus('seasons', 'Loading season history…');
  try {
    const allEvents = await fetchAllPages(`/teams/${team.id}/events`);
    const seen = new Set();
    const seasons = [];
    const countBySeason = {};
    allEvents.forEach(ev => {
      if (ev.season) {
        countBySeason[ev.season.id] = (countBySeason[ev.season.id] || 0) + 1;
        if (!seen.has(ev.season.id)) {
          seen.add(ev.season.id);
          seasons.push({ ...ev.season, program: ev.program });
        }
      }
    });
    seasons.sort((a, b) => b.id - a.id);
    clearStatus('seasons');
    renderSeasonCards(seasons, countBySeason);
  } catch (err) {
    setStatus('seasons', `Error: ${err.message}`, 'error');
  }
}

function renderSeasonCards(seasons, counts) {
  const el = document.getElementById('seasons-grid');
  if (!seasons.length) { el.innerHTML = '<p class="empty">No season history found.</p>'; return; }
  el.innerHTML = `
    <p class="seasons-heading">Select a season to view stats</p>
    <div class="seasons-grid">
      ${seasons.map(s => `
        <div class="season-card" data-id="${s.id}">
          <div class="season-name">${esc(s.name)}</div>
          <div class="season-pills">
            ${s.program?.name ? `<span class="pill">${esc(s.program.name)}</span>` : ''}
            <span class="pill">${counts[s.id] || 0} event${counts[s.id] !== 1 ? 's' : ''}</span>
          </div>
        </div>`).join('')}
    </div>`;
  el.querySelectorAll('.season-card').forEach(card => {
    card.addEventListener('click', () => {
      const season = seasons.find(s => s.id === +card.dataset.id);
      if (season) openStatsView(currentTeam, season);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS VIEW
// ═══════════════════════════════════════════════════════════════════════════

// Compute TrueSkill directly from a team's fetched season data.
// Uses standingsState.data max combined for normalization if available.
function computeTeamTrueSkill(skills, rankings, awards, pid, sid) {
  const bestDriver = Math.max(0, ...skills.filter(s => s.type === 'driver').map(s => s.score));
  const bestProg   = Math.max(0, ...skills.filter(s => s.type === 'programming').map(s => s.score));
  const combined   = bestDriver + bestProg;
  if (combined === 0 && !rankings.length) return null;

  // Resolve maxCombined: prefer live standingsState for the same pid/sid, then try
  // localStorage standings cache, then fall back to team's own score (least accurate).
  let maxCombined = 0;
  if (standingsState.data?.length &&
      standingsState.programId === pid && standingsState.seasonId === sid) {
    maxCombined = Math.max(1, ...standingsState.data.map(t => t.combined));
  } else if (pid && sid) {
    const cached = readStandingsCache(pid, sid);
    if (cached?.length) maxCombined = Math.max(1, ...cached.map(t => t.combined));
  }
  if (!maxCombined) maxCombined = Math.max(combined, 1);

  const skillsScore  = combined / maxCombined;

  const eventsPlayed = rankings.length;
  const awardSum     = awards.reduce((s, a) => s + awardWeight(a.title || ''), 0);
  const awardsNorm   = eventsPlayed > 0 ? Math.min(awardSum / eventsPlayed / 3, 1) : 0;

  let totalRank = 0, wins = 0, matches = 0;
  for (const r of rankings) {
    totalRank += r.rank || 0;
    wins      += r.wins || 0;
    matches   += (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
  }
  const avgRank  = eventsPlayed > 0 ? totalRank / eventsPlayed : 999;
  const rankNorm = avgRank > 0 ? Math.min(1, 1 / Math.sqrt(avgRank)) : 0;
  const winNorm  = matches > 0 ? wins / matches : 0;

  return +(10 * (skillsScore * 0.35 + awardsNorm * 0.25 + rankNorm * 0.25 + winNorm * 0.15)).toFixed(2);
}

// Fetch a team's official world skills rank from the legacy standings endpoint.
// Checks both regular season and worlds, returns the entry with the best combined score.
async function fetchTeamWorldSkillsRank(teamNumber, seasonId, grade) {
  if (!grade) return null;
  try {
    const base = `https://www.robotevents.com/api/seasons/${seasonId}/skills` +
      `?grade_level=${encodeURIComponent(grade)}`;
    const [regular, worlds] = await Promise.all([
      fetch(base + '&post_season=0').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(base + '&post_season=1').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    const all = [...(Array.isArray(regular) ? regular : []), ...(Array.isArray(worlds) ? worlds : [])];
    // Find all entries for this team and pick the one with the best combined score
    const entries = all.filter(e => e.team?.team === teamNumber);
    if (!entries.length) return null;
    return entries.reduce((best, e) =>
      (e.scores?.score || 0) > (best.scores?.score || 0) ? e : best
    );
  } catch (_) { return null; }
}

async function openStatsView(team, season) {
  showView('view-stats');
  document.getElementById('season-hero').innerHTML = `
    <div class="season-hero">
      <div class="season-label">Season</div>
      <div class="season-title">${esc(season.name)}</div>
      <div class="season-team-ref">Team <strong>${esc(team.number)}</strong>${team.team_name ? ' · ' + esc(team.team_name) : ''}</div>
    </div>`;
  clearStatus('stats');
  document.getElementById('stats-content').innerHTML = '';
  setStatus('stats', 'Loading stats…');
  try {
    const sid = season.id;
    const [events, rankings, skills, awards, worldEntry] = await Promise.all([
      fetchAllPages(`/teams/${team.id}/events?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/rankings?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/skills?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/awards?season[]=${sid}`),
      fetchTeamWorldSkillsRank(team.number, sid, team.grade),
    ]);
    clearStatus('stats');
    renderTeamStats(events, rankings, skills, awards, worldEntry, season.program?.id || team.program?.id, sid);
  } catch (err) {
    setStatus('stats', `Error: ${err.message}`, 'error');
  }
}

function renderTeamStats(events, rankings, skills, awards, worldEntry, pid, sid) {
  const el = document.getElementById('stats-content');
  const eventMap = {};
  events.forEach(ev => { eventMap[ev.id] = ev; });

  const bestRank = rankings.length ? Math.min(...rankings.map(r => r.rank)) : null;
  const driver   = skills.filter(s => s.type === 'driver');
  const prog     = skills.filter(s => s.type === 'programming');
  const bestDriver = driver.length ? Math.max(...driver.map(s => s.score)) : null;
  const bestProg   = prog.length   ? Math.max(...prog.map(s => s.score))   : null;

  // Prefer world rank from legacy endpoint (includes worlds); fall back to v2 rank field
  const worldSkillsRank = worldEntry?.rank
    ?? (skills.map(s => s.rank).filter(n => n != null && n > 0).reduce((a, b) => Math.min(a, b), Infinity) || null);

  const trueSkillScore = computeTeamTrueSkill(skills, rankings, awards, pid, sid);

  el.innerHTML = [
    metricsHTML(events.length, bestRank, worldSkillsRank, awards.length, trueSkillScore),
    events.length > 1 ? `<div class="stats-section"><div class="section-title">Season Event Map</div><div id="team-hist-map" class="team-hist-map"></div></div>` : '',
    teamRankingsHTML(rankings, eventMap),
    teamSkillsHTML(driver, prog, bestDriver, bestProg, worldEntry),
    teamAwardsHTML(awards),
  ].join('');

  if (events.length > 1) initTeamHistoryMap(events, rankings);

  el.querySelectorAll('.clickable-row[data-event-id]').forEach(row => {
    const ev = eventMap[+row.dataset.eventId];
    if (!ev) return;
    row.addEventListener('click', () => {
      pendingHighlightTeam = currentTeam?.number;
      openEventDetail(ev);
    });
  });
}

function initTeamHistoryMap(events, rankings) {
  const container = document.getElementById('team-hist-map');
  if (!container || typeof L === 'undefined') return;

  // Destroy any prior Leaflet instance on this element
  if (container._leaflet_id) {
    const old = container._leaflet_map;
    if (old) old.remove();
  }

  const map = L.map(container, { zoomControl: true, scrollWheelZoom: false });
  container._leaflet_map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(map);

  // Ranking lookup: eventId → rank
  const rankByEvent = {};
  for (const r of rankings) {
    if (r.event?.id) rankByEvent[r.event.id] = r.rank;
  }
  const allRanks = Object.values(rankByEvent).filter(Boolean);
  const maxRank  = allRanks.length ? Math.max(...allRanks) : 50;

  const markers = [];
  for (const ev of events) {
    let lat = ev.location?.coordinates?.lat;
    let lon = ev.location?.coordinates?.lon;
    if (lat == null || lon == null) {
      const country = ev.location?.country;
      if (country && COUNTRY_COORDS[country]) [lat, lon] = COUNTRY_COORDS[country];
      else continue;
    }

    const rank   = rankByEvent[ev.id];
    const pct    = rank != null ? (1 - (rank - 1) / Math.max(maxRank - 1, 1)) : 0.5;
    // Green (rank 1) → yellow → red (last)
    const hue    = Math.round(pct * 120);
    const color  = `hsl(${hue},80%,42%)`;
    const radius = rank === 1 ? 10 : rank != null && rank <= 3 ? 8 : 6;

    const start  = ev.start ? new Date(ev.start).toLocaleDateString() : '—';
    const loc    = [ev.location?.city, ev.location?.region].filter(Boolean).join(', ') || ev.location?.country || '—';
    const tooltip = `<strong>${esc(ev.name)}</strong><br>${start} · ${loc}${rank != null ? '<br>Rank: #' + rank : ''}`;

    const m = L.circleMarker([lat, lon], {
      radius, fillColor: color, color: '#fff', weight: 1.5, fillOpacity: 0.9,
    }).bindTooltip(tooltip, { direction: 'top', offset: [0, -4] });
    m.on('click', () => openEventDetail(ev));
    m.addTo(map);
    markers.push([lat, lon]);
  }

  if (markers.length) {
    map.fitBounds(L.latLngBounds(markers), { padding: [24, 24], maxZoom: 6 });
  } else {
    map.setView([20, 0], 2);
  }

  // Legend
  container.insertAdjacentHTML('afterend', `
    <div class="hist-map-legend">
      <span style="color:#15803D">● Rank 1–3</span> &nbsp;
      <span style="color:#D97706">● Mid</span> &nbsp;
      <span style="color:#DC2626">● Bottom</span> &nbsp;
      <span style="font-size:.72rem;color:var(--text-muted)">Click a pin to open event</span>
    </div>`);
}

function metricsHTML(evCount, bestRank, worldSkillsRank, awardCount, trueSkill) {
  const m = (val, label) => `
    <div class="metric-card">
      <div class="metric-value">${val ?? '—'}</div>
      <div class="metric-label">${label}</div>
    </div>`;
  return `<div class="metrics-row">
    ${m(evCount, 'Events')}
    ${m(bestRank ? `#${bestRank}` : null, 'Best Rank')}
    ${m(worldSkillsRank ? `#${worldSkillsRank}` : null, 'World Skills')}
    ${m(awardCount, 'Awards')}
    ${trueSkill != null ? m(trueSkill.toFixed(2) + '<span style="font-size:.7rem;opacity:.55">/10</span>', 'Rating') : ''}
  </div>`;
}

function rankTrajectoryChart(rankings, eventMap) {
  const pts = [...rankings]
    .filter(r => eventMap[r.event?.id])
    .sort((a, b) => new Date(eventMap[a.event.id]?.start||0) - new Date(eventMap[b.event.id]?.start||0));
  if (pts.length < 2) return '';
  const ranks = pts.map(r => r.rank);
  const maxR = Math.max(...ranks);
  const W = 240, H = 54, pad = 10;
  const xStep = (W - pad * 2) / (pts.length - 1);
  const toY = r => pad + (r - 1) / Math.max(1, maxR - 1) * (H - pad * 2);
  const pathD = pts.map((r, i) => `${i===0?'M':'L'}${(pad + i*xStep).toFixed(1)},${toY(r.rank).toFixed(1)}`).join(' ');
  const fillD = pathD + ` L${(pad+(pts.length-1)*xStep).toFixed(1)},${H} L${pad},${H} Z`;
  const dots = pts.map((r, i) => {
    const x = (pad + i*xStep).toFixed(1), y = toY(r.rank).toFixed(1);
    const ev = eventMap[r.event?.id];
    return `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"><title>${esc(ev?.name||'')} — Rank #${r.rank}</title></circle>`;
  }).join('');
  return `<div class="trajectory-wrap">
    <div class="trajectory-label">Rank trajectory <span class="trajectory-note">${pts.length} events · hover for details · top = better</span></div>
    <svg class="trajectory-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="overflow:visible">
      <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <line x1="${pad}" y1="${pad}" x2="${W-pad}" y2="${pad}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,2"/>
      <text x="${pad-2}" y="${pad+3}" fill="var(--text-muted)" font-size="7" text-anchor="end">#1</text>
      <text x="${pad-2}" y="${H-pad+3}" fill="var(--text-muted)" font-size="7" text-anchor="end">#${maxR}</text>
      <path d="${fillD}" fill="url(#tg)"/>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
  </div>`;
}

function teamRankingsHTML(rankings, eventMap) {
  if (!rankings.length) return `
    <div class="stats-section">
      <div class="section-title">Event Rankings</div>
      <p class="empty">No ranking data for this season.</p>
    </div>`;
  const sorted = [...rankings].sort((a, b) => {
    const ea = eventMap[a.event?.id], eb = eventMap[b.event?.id];
    return new Date(eb?.start || 0) - new Date(ea?.start || 0);
  });
  const rows = sorted.map(r => {
    const ev   = eventMap[r.event?.id];
    const date = ev ? new Date(ev.start).toLocaleDateString() : '—';
    const cls  = r.rank === 1 ? 'gold' : r.rank === 2 ? 'silver' : r.rank === 3 ? 'bronze' : '';
    const pts  = [
      r.wp != null ? `WP ${r.wp}` : '',
      r.ap != null ? `AP ${r.ap}` : '',
      r.sp != null ? `SP ${r.sp}` : '',
    ].filter(Boolean).join(' · ');
    const evId = ev?.id ?? '';
    return `<tr class="event-row${ev ? ' clickable-row' : ''}" data-event-id="${evId}">
      <td style="color:var(--text-muted);font-size:.82rem">${date}</td>
      <td style="white-space:normal;min-width:160px">${ev ? `<span class="event-link">${esc(r.event?.name || '—')}</span>` : esc(r.event?.name || '—')}</td>
      <td><span class="rank-badge ${cls}">#${r.rank}</span></td>
      <td>${r.wins ?? '—'}–${r.losses ?? '—'}–${r.ties ?? '—'}</td>
      <td style="color:var(--text-muted);font-size:.8rem">${pts || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Event Rankings</div>
      ${rankTrajectoryChart(rankings, eventMap)}
      <p class="match-hint">Click an event row to view full event details.</p>
      <div class="table-wrap">
        <table><thead><tr>
          <th>Date</th><th>Event</th><th>Rank</th><th>W–L–T</th><th>Points</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
}

function teamSkillsHTML(driver, prog, bestDriver, bestProg, worldEntry) {
  if (!driver.length && !prog.length && !worldEntry) return `
    <div class="stats-section">
      <div class="section-title">Skills</div>
      <p class="empty">No skills data for this season.</p>
    </div>`;

  // Use legacy worldEntry as the authoritative source where available
  const wDriver  = worldEntry?.scores?.driver      ?? bestDriver;
  const wProg    = worldEntry?.scores?.programming ?? bestProg;
  const wCombined = worldEntry?.scores?.score      ?? (wDriver != null && wProg != null ? wDriver + wProg : null);
  const wRank    = worldEntry?.rank                ?? null;
  const dStop    = worldEntry?.scores?.driverStopTime  || null;
  const pStop    = worldEntry?.scores?.progStopTime    || null;

  const stopFmt  = s => (s != null && s > 0) ? ` <span style="font-size:.75rem;color:var(--text-muted)">${s}s</span>` : '';
  const card = (label, score, stop, worldRank) => score != null ? `
    <div class="skill-card">
      <div class="skill-type">${label}</div>
      <div class="skill-score">${score}${stopFmt(stop)}</div>
      ${worldRank ? `<div class="skill-rank">World Rank #${worldRank}</div>` : ''}
    </div>` : '';

  return `
    <div class="stats-section">
      <div class="section-title">Skills</div>
      <div class="skills-row">
        ${card('Driver',      wDriver,   dStop, null)}
        ${card('Programming', wProg,     pStop, null)}
        ${card('Combined',    wCombined, null,  wRank)}
      </div>
    </div>`;
}

function teamAwardsHTML(awards) {
  if (!awards.length) return `
    <div class="stats-section">
      <div class="section-title">Awards</div>
      <p class="empty">No awards this season.</p>
    </div>`;

  const NOTEBOOK_TYPES = new Set(['excellence','design','think','innovate','amaze','build','create','judges']);
  const notebook    = awards.filter(a => NOTEBOOK_TYPES.has(classifyAward(a.title)));
  const performance = awards.filter(a => !NOTEBOOK_TYPES.has(classifyAward(a.title)));

  function item(a) {
    const type = classifyAward(a.title);
    const info = AWARD_INFO[type] || AWARD_INFO.other;
    const evId = a.event?.id ?? '';
    return `<div class="pedigree-item${evId ? ' clickable-row' : ''}" data-event-id="${evId}">
      <span class="pedigree-icon">${info.icon}</span>
      <div class="pedigree-info">
        <div class="pedigree-title">${esc(a.title)}</div>
        <div class="pedigree-event">${evId ? `<span class="event-link">${esc(a.event?.name||'—')}</span>` : esc(a.event?.name||'—')}</div>
      </div>
    </div>`;
  }

  const notebookHtml = notebook.length ? `
    <div class="stats-section">
      <div class="section-title">Notebook &amp; Judged Awards (${notebook.length})</div>
      <div class="pedigree-list">${notebook.map(item).join('')}</div>
    </div>` : '';

  const perfHtml = performance.length ? `
    <div class="stats-section">
      <div class="section-title">Performance Awards (${performance.length})</div>
      <div class="pedigree-list">${performance.map(item).join('')}</div>
    </div>` : '';

  return (notebookHtml + perfHtml) || `<div class="stats-section"><div class="section-title">Awards</div><p class="empty">No awards this season.</p></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function teamHeroHTML(t, clickable) {
  const loc = [t.location?.city, t.location?.region, t.location?.country].filter(Boolean).join(', ') || '—';
  const following = isFollowingTeam(t.number);
  return `
    <div class="team-hero ${clickable ? 'clickable' : ''}">
      <div class="team-number">${esc(t.number)}</div>
      ${t.team_name ? `<div class="team-name-label">${esc(t.team_name)}</div>` : ''}
      <div class="team-meta-grid">
        ${t.robot_name   ? mf('Robot',        t.robot_name)   : ''}
        ${t.organization ? mf('Organization', t.organization) : ''}
        ${mf('Location', loc)}
        ${t.program?.name ? mf('Program', t.program.name) : ''}
        ${t.grade         ? mf('Grade',   t.grade)         : ''}
      </div>
      ${clickable ? '<div class="view-seasons-hint">Click to view season history →</div>' : ''}
      ${!clickable ? `<button class="follow-team-btn ${following ? 'following' : ''}" data-num="${esc(t.number)}" data-name="${esc(t.team_name||t.number)}" data-prog="${esc(t.program?.name||'')}">
        ${following ? 'Following ★' : 'Follow ☆'}
      </button>` : ''}
    </div>`;
}

function mf(label, value) {
  return `<div class="meta-field">
    <span class="meta-label">${label}</span>
    <span class="meta-value">${esc(value)}</span>
  </div>`;
}

function setStatus(scope, msg, type = 'info') {
  const el = document.getElementById(`${scope}-status`);
  if (!el) return;
  el.classList.remove('hidden', 'error', 'warn', 'status-loading');
  const isLoading = type === 'info' && /load|search|find|fetch|calculat|compil/i.test(msg);
  if (isLoading) {
    el.innerHTML = '<span class="status-spinner"></span><span>' + msg + '</span>';
    el.classList.add('status-loading');
  } else {
    el.textContent = msg;
  }
  if (type !== 'info') el.classList.add(type);
}

function clearStatus(scope) {
  const el = document.getElementById(`${scope}-status`);
  if (!el) return;
  el.classList.add('hidden');
  el.textContent = '';
}

function clearSearch() {
  clearStatus('search');
  document.getElementById('search-results').innerHTML = '';
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Wire clickable schedule rows to show prediction evolution chart ────────
function wireSchedRows(container, sortedMatches) {
  container.querySelectorAll('tr.sched-row[data-midx]').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return; // don't fire on team-link clicks
      const existing = container.querySelector('.sched-evo-row');
      const same = existing?.dataset.for === row.dataset.midx;
      if (existing) existing.remove();
      container.querySelectorAll('tr.sched-row.active').forEach(r => r.classList.remove('active'));
      if (same) return;
      const m = sortedMatches[+row.dataset.midx];
      if (!m) return;
      const pts  = computePredictionHistory(m);
      const html = renderPredEvolutionChart(pts);
      if (!html) return;
      row.classList.add('active');
      const expandRow = document.createElement('tr');
      expandRow.className = 'sched-evo-row';
      expandRow.dataset.for = row.dataset.midx;
      expandRow.innerHTML = '<td colspan="6">' + html + '</td>';
      row.after(expandRow);
    });
  });
}

// ── Schedule strength + carry analysis ────────────────────────────────────
function computeScheduleStrength(teamName) {
  const quals = cachedEventMatches.filter(m =>
    m.round === 2 &&
    (m.alliances || []).some(a => isScored(a.score)) &&
    (m.alliances || []).some(a => (a.teams || []).some(t => t.team?.name === teamName))
  );
  if (!quals.length) return null;
  const oppOPRs = [];
  for (const m of quals) {
    const alliances = m.alliances || [];
    const myColor = alliances.find(a => (a.teams || []).some(t => t.team?.name === teamName))?.color;
    const opp = alliances.find(a => a.color !== myColor);
    for (const t of (opp?.teams || [])) {
      if (t.team?.name) oppOPRs.push(effectiveOPR(t.team.name));
    }
  }
  return oppOPRs.length ? oppOPRs.reduce((a, b) => a + b, 0) / oppOPRs.length : null;
}

function computeCarryIndex(teamName) {
  const quals = cachedEventMatches.filter(m =>
    m.round === 2 &&
    (m.alliances || []).some(a => isScored(a.score)) &&
    (m.alliances || []).some(a => (a.teams || []).some(t => t.team?.name === teamName))
  );
  if (!quals.length) return null;
  const teamOPR = effectiveOPR(teamName);
  const partnerOPRs = [];
  for (const m of quals) {
    const myAlliance = (m.alliances || []).find(a => (a.teams || []).some(t => t.team?.name === teamName));
    for (const t of (myAlliance?.teams || [])) {
      if (t.team?.name && t.team.name !== teamName) partnerOPRs.push(effectiveOPR(t.team.name));
    }
  }
  if (!partnerOPRs.length) return null;
  const avgPartner = partnerOPRs.reduce((a, b) => a + b, 0) / partnerOPRs.length;
  return avgPartner > 0 ? teamOPR / avgPartner : null;
}

function renderScheduleStrengthSection(teamName) {
  const sos = computeScheduleStrength(teamName);
  const carryIdx = computeCarryIndex(teamName);
  if (sos === null && carryIdx === null) return '';

  // Compute SOS percentile among all division teams
  const allTeamNames = [...new Set(
    cachedEventMatches.filter(m => m.round === 2)
      .flatMap(m => (m.alliances || []).flatMap(a => (a.teams || []).map(t => t.team?.name).filter(Boolean)))
  )];
  let sosPct = null;
  if (sos !== null && allTeamNames.length > 1) {
    const allSOS = allTeamNames.map(n => computeScheduleStrength(n)).filter(v => v !== null);
    const below = allSOS.filter(v => v < sos).length;
    sosPct = Math.round((below / allSOS.length) * 100);
  }

  let carryHtml = '';
  if (carryIdx !== null) {
    const label = carryIdx >= 1.2 ? 'Carrying' : carryIdx >= 0.8 ? 'Balanced' : 'Being Carried';
    const icon  = carryIdx >= 1.2 ? '🔥' : carryIdx >= 0.8 ? '⚖' : '📉';
    const cls   = carryIdx >= 1.2 ? 'carry-high' : carryIdx >= 0.8 ? 'carry-mid' : 'carry-low';
    const pct   = Math.round(carryIdx * 100);
    carryHtml =
      '<div class="sos-card">' +
      '<div class="sos-label">Alliance Contribution</div>' +
      '<div class="sos-value ' + cls + '">' + icon + ' ' + label + '</div>' +
      '<div class="sos-bar-wrap"><div class="sos-bar-fill" style="width:' + Math.min(100, pct / 2) + '%"></div></div>' +
      '<div class="sos-label" style="margin-top:4px">' + pct + '% of avg partner OPR</div>' +
      '</div>';
  }

  let sosHtml = '';
  if (sos !== null) {
    const label = sosPct >= 70 ? 'Hard' : sosPct >= 40 ? 'Average' : 'Easy';
    sosHtml =
      '<div class="sos-card">' +
      '<div class="sos-label">Schedule Difficulty</div>' +
      '<div class="sos-value">' + label + (sosPct !== null ? ' (' + sosPct + 'th pct.)' : '') + '</div>' +
      '<div class="sos-bar-wrap"><div class="sos-bar-fill" style="width:' + (sosPct ?? 50) + '%"></div></div>' +
      '<div class="sos-label" style="margin-top:4px">Avg opp OPR: ' + Math.round(sos) + '</div>' +
      '</div>';
  }

  return '<div class="sos-section">' + sosHtml + carryHtml + '</div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// SNAKE DRAFT SIMULATOR
// ═══════════════════════════════════════════════════════════════════════════

let draftState = null;

function draftTeamScore(name) {
  const w = getPickWeights();
  const rows = buildPicklistRows(w);
  if (!rows) return 0;
  const entry = rows.find(r => r.name === name);
  return entry ? entry.composite : 0;
}

function renderDraftSetup() {
  const teams = Object.keys(cachedEventRankings);
  if (!teams.length) return '<p class="empty">Load Rankings first to run a draft simulation.</p>';

  const numTeams    = teams.length;
  const numAlliances = Math.min(8, Math.max(2, Math.floor(numTeams / 2)));
  const captains = [...teams]
    .sort((a, b) => (cachedEventRankings[a]?.rank ?? 999) - (cachedEventRankings[b]?.rank ?? 999))
    .slice(0, numAlliances);

  const opts = captains.map((c, i) =>
    `<button class="draft-seed-btn" data-seed="${i}">#${i+1} — ${esc(c)}</button>`
  ).join('');

  return `
    <div class="stats-section">
      <div class="section-title">Alliance Draft Simulator</div>
      <p class="pl-info">Simulates a ${numAlliances}-alliance selection. Each alliance is 2 teams: a captain + 1 partner. Captains pick in seeding order (1 → ${numAlliances}). AI opponents pick by composite score.</p>
      <div class="draft-seed-label">Choose your captain:</div>
      <div class="draft-seed-grid">${opts}</div>
    </div>`;
}

function wireDraftSetup(container) {
  container.querySelectorAll('.draft-seed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const seed = +btn.dataset.seed;
      startDraft(seed, container);
    });
  });
}

function startDraft(yourSeed, container) {
  const teams = Object.keys(cachedEventRankings);
  // numAlliances = min(8, floor(teams/2)) — each alliance needs at least 2 teams
  const numAlliances = Math.min(8, Math.max(2, Math.floor(teams.length / 3)));
  const sorted = [...teams].sort((a, b) =>
    (cachedEventRankings[a]?.rank ?? 999) - (cachedEventRankings[b]?.rank ?? 999));

  const captains = sorted.slice(0, numAlliances);

  // slots: one per captain, in seed order. skipped=true when a captain was picked as partner.
  // partner: the team they picked.
  // available: ALL teams except the current captain — including other captains.
  draftState = {
    yourSeed,
    slots: captains.map((c, i) => ({ seed: i, captain: c, partner: null, skipped: false })),
    allTeams: sorted,         // full sorted list; used to compute available each turn
    pickedAsPartner: new Set(), // team names taken as partners
    pickIdx: 0,               // index into slots (skip skipped slots)
    done: false,
  };

  renderDraftBoard(container);
  autoAdvanceAI(container);
}

// Returns the next slot index that hasn't been skipped, starting from pickIdx
function nextActivePick(ds) {
  let i = ds.pickIdx;
  while (i < ds.slots.length && ds.slots[i].skipped) i++;
  return i;
}

// All teams not yet committed to an alliance, except the team currently picking.
// Excludes: teams already picked as partners, captains who already have a partner,
// and skipped captains (they were picked as someone else's partner).
function draftAvailable(ds) {
  const pickingCaptain = ds.slots[ds.pickIdx]?.captain;
  const doneCaptains = new Set(
    ds.slots.filter(s => s.partner !== null || s.skipped).map(s => s.captain)
  );
  return ds.allTeams.filter(t =>
    !ds.pickedAsPartner.has(t) &&
    t !== pickingCaptain &&
    !doneCaptains.has(t)
  );
}

function aiPick(available) {
  if (!available.length) return null;
  const scored = available.map(n => ({ n, s: draftTeamScore(n) + (Math.random() - 0.5) * 3 }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0].n;
}

function applyPick(name) {
  const ds = draftState;
  const slot = ds.slots[ds.pickIdx];
  slot.partner = name;
  ds.pickedAsPartner.add(name);

  // If the picked team was another captain, mark their slot as skipped
  const pickedSlot = ds.slots.find(s => s.captain === name);
  if (pickedSlot) pickedSlot.skipped = true;

  // Advance to next non-skipped slot
  ds.pickIdx++;
  ds.pickIdx = nextActivePick(ds);
  if (ds.pickIdx >= ds.slots.length) ds.done = true;
}

function renderDraftBoard(container) {
  const ds = draftState;

  const allianceCards = ds.slots.map(sl => {
    if (sl.skipped) return ''; // this captain was picked — don't show as its own alliance
    const isYours = sl.seed === ds.yourSeed;
    const rankOf  = n => cachedEventRankings[n]?.rank;
    const oprOf   = n => cachedOPR[n]?.opr?.toFixed(1) ?? '—';
    const captainRow = `
      <div class="draft-member draft-captain">
        <span class="draft-member-num">${esc(sl.captain)}</span>
        <span class="draft-member-meta">#${rankOf(sl.captain) ?? '?'} · OPR ${oprOf(sl.captain)}</span>
      </div>`;
    const partnerRow = sl.partner ? `
      <div class="draft-member">
        <span class="draft-member-num">${esc(sl.partner)}</span>
        <span class="draft-member-meta">#${rankOf(sl.partner) ?? '?'} · OPR ${oprOf(sl.partner)}</span>
      </div>` : `<div class="draft-member-pending">awaiting pick…</div>`;
    const totalOPR = [sl.captain, sl.partner].filter(Boolean)
      .reduce((s, n) => s + (cachedOPR[n]?.opr ?? 0), 0);
    return `
      <div class="draft-alliance-card ${isYours ? 'draft-yours' : ''}">
        <div class="draft-alliance-title">${isYours ? '⭐ ' : ''}Alliance ${sl.seed + 1}${isYours ? ' (You)' : ''}</div>
        ${captainRow}${partnerRow}
        ${sl.partner ? `<div class="draft-alliance-opr">Combined OPR: ${totalOPR.toFixed(1)}</div>` : ''}
      </div>`;
  }).join('');

  let pickUI = '';
  if (!ds.done) {
    const curSlot   = ds.slots[ds.pickIdx];
    const isYourTurn = curSlot?.seed === ds.yourSeed;
    const available = draftAvailable(ds);

    if (isYourTurn) {
      const rows = available.map(n => {
        const rank    = cachedEventRankings[n]?.rank;
        const opr     = cachedOPR[n]?.opr?.toFixed(1) ?? '—';
        const ccwm    = cachedOPR[n]?.ccwm?.toFixed(1) ?? '—';
        const skills  = cachedEventSkills[n]?.combined ?? '—';
        const score   = draftTeamScore(n).toFixed(1);
        const isCap   = ds.slots.some(s => s.captain === n && !s.skipped);
        return `<tr class="draft-avail-row ${isCap ? 'draft-row-captain' : ''}">
          <td>${rank != null ? '#' + rank : '—'}${isCap ? ' <span class="draft-cap-tag">C</span>' : ''}</td>
          <td><strong>${esc(n)}</strong>${hasScoutNote(n) ? ' <span class="scout-dot">●</span>' : ''}</td>
          <td>${opr}</td><td>${ccwm}</td><td>${skills}</td>
          <td class="draft-score-cell">${score}</td>
          <td><button class="draft-pick-btn btn-primary" data-name="${esc(n)}">Pick</button></td>
        </tr>`;
      }).join('');
      pickUI = `
        <div class="draft-your-turn">Your pick — choose your alliance partner (C = another captain seed):</div>
        <div class="table-wrap"><table class="draft-avail-table">
          <thead><tr><th>Rank</th><th>Team</th><th>OPR</th><th>CCWM</th><th>Skills</th><th>Score</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    } else {
      pickUI = `<div class="draft-ai-turn">Alliance ${(curSlot?.seed ?? 0) + 1} is picking a partner…
        <button class="btn-secondary draft-ai-btn" id="draft-ai-pick">Simulate pick</button></div>`;
    }
  } else {
    const activeSlots = ds.slots.filter(s => !s.skipped && s.partner);
    const yourSlot = activeSlots.find(s => s.seed === ds.yourSeed);
    const yourLabel = yourSlot ? `Alliance ${ds.yourSeed + 1}` : null;
    const allianceObjs = activeSlots.map(s => ({
      label: `Alliance ${s.seed + 1}`,
      teams: [s.captain, s.partner],
    }));
    const bracketHTML = allianceObjs.length >= 2
      ? renderSimBracket(allianceObjs, yourLabel)
      : '';
    pickUI = `
      <div class="draft-done">
        Draft complete!
        <button class="btn-secondary" id="draft-restart" style="margin-left:12px">Start over</button>
      </div>
      ${bracketHTML}`;
  }

  container.innerHTML = `
    <div class="stats-section">
      <div class="section-title">Alliance Draft${ds.done ? ' — Complete' : ''}</div>
      <div class="draft-alliances">${allianceCards}</div>
      <div class="draft-pick-area">${pickUI}</div>
    </div>`;

  container.querySelectorAll('.draft-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyPick(btn.dataset.name);
      renderDraftBoard(container);
      autoAdvanceAI(container);
    });
  });
  container.querySelector('#draft-ai-pick')?.addEventListener('click', () => {
    applyPick(aiPick(draftAvailable(draftState)));
    renderDraftBoard(container);
    autoAdvanceAI(container);
  });
  container.querySelector('#draft-restart')?.addEventListener('click', () => {
    draftState = null;
    container.innerHTML = renderDraftSetup();
    wireDraftSetup(container);
  });
}

function autoAdvanceAI(container) {
  const ds = draftState;
  if (!ds || ds.done) return;
  const curSlot = ds.slots[ds.pickIdx];
  if (curSlot && curSlot.seed !== ds.yourSeed) {
    setTimeout(() => {
      if (!draftState || draftState.done) return;
      applyPick(aiPick(draftAvailable(draftState)));
      renderDraftBoard(container);
      autoAdvanceAI(container);
    }, 700);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-SCOUT PICK LIST
// ═══════════════════════════════════════════════════════════════════════════

function picklistExcludedKey(eid) { return `picklist_excl_${eid}`; }
function getExcluded(eid) {
  try { return new Set(JSON.parse(localStorage.getItem(picklistExcludedKey(eid)) || '[]')); } catch (_) { return new Set(); }
}
function saveExcluded(eid, set) { localStorage.setItem(picklistExcludedKey(eid), JSON.stringify([...set])); }

const PL_WEIGHT_KEY = 'picklist_weights';
const PL_WEIGHT_DEFAULTS = { opr: 30, ccwm: 20, winRate: 15, auton: 15, skills: 10, consistency: 10 };
function getPickWeights() {
  try { return { ...PL_WEIGHT_DEFAULTS, ...JSON.parse(localStorage.getItem(PL_WEIGHT_KEY) || '{}') }; } catch (_) { return { ...PL_WEIGHT_DEFAULTS }; }
}
function savePickWeights(w) { localStorage.setItem(PL_WEIGHT_KEY, JSON.stringify(w)); }

// Build per-team stats from raw match data for richer pick list scoring
function buildPicklistStats() {
  const stats = {}; // name -> { scores[], apPerMatch, allianceAvg, gamesPlayed }
  for (const m of cachedEventMatches) {
    if (m.round !== 2 || !matchIsScored(m)) continue;
    for (const a of (m.alliances || [])) {
      const score = a.score ?? 0;
      const ap    = a.teams?.reduce((s, t) => s + (t.sit_out ? 0 : (a.autonomous_points ?? 0) / (a.teams?.length || 1)), 0) ?? 0;
      // partner avg: total alliance score excluding this team's OPR contribution
      for (const t of (a.teams || [])) {
        const name = t.team?.name;
        if (!name) continue;
        if (!stats[name]) stats[name] = { scores: [], apTotal: 0, gamesPlayed: 0 };
        stats[name].scores.push(score);
        stats[name].apTotal  += ap;
        stats[name].gamesPlayed++;
      }
    }
  }
  // Compute derived fields
  for (const [, s] of Object.entries(stats)) {
    const n = s.scores.length;
    const mean = n ? s.scores.reduce((a, b) => a + b, 0) / n : 0;
    const variance = n > 1 ? s.scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1; // coefficient of variation: lower = more consistent
    s.mean = mean;
    s.consistency = Math.max(0, 1 - cv);   // 0-1, higher = more consistent
    s.apPerMatch  = s.gamesPlayed ? s.apTotal / s.gamesPlayed : 0;
  }
  return stats;
}

// Normalize array of raw values to 0-100 percentile ranks (handles ties, null-safe)
function percentileRank(values) {
  const valid = values.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return values.map(() => 50);
  return values.map(v => {
    if (v == null || !isFinite(v)) return 50;
    const below = valid.filter(x => x < v).length;
    return valid.length > 1 ? (below / (valid.length - 1)) * 100 : 50;
  });
}

function buildPicklistRows(weights) {
  const teams = Object.keys(cachedEventRankings);
  if (!teams.length) return null;

  const matchStats = buildPicklistStats();

  // Raw values per team for each dimension
  const raw = teams.map(name => {
    const r = cachedEventRankings[name] || {};
    const o = cachedOPR[name] || {};
    const sk = cachedEventSkills[name] || {};
    const ms = matchStats[name] || {};
    return {
      name,
      opr:         o.opr          ?? null,
      ccwm:        o.ccwm         ?? null,
      winRate:     r.winRate      ?? null,
      auton:       ms.apPerMatch  ?? (r.ap != null && r.wins + r.losses + r.ties > 0
                     ? r.ap / (r.wins + r.losses + r.ties) : null),
      skills:      sk.combined    ?? null,
      consistency: ms.consistency ?? null,
      // display-only
      rank:        r.rank,
      dpr:         o.dpr          ?? null,
      maxScore:    r.max_score    ?? null,
      wp:          r.wp           ?? null,
      ap:          r.ap           ?? null,
      sp:          r.sp           ?? null,
      gamesPlayed: ms.gamesPlayed ?? 0,
      hasNotes:    hasScoutNote(name),
    };
  });

  // Compute percentile ranks for each scored dimension
  const dims = ['opr', 'ccwm', 'winRate', 'auton', 'skills', 'consistency'];
  const pctiles = {};
  dims.forEach(dim => {
    const vals = raw.map(r => r[dim]);
    const pcts = percentileRank(vals);
    pctiles[dim] = {};
    raw.forEach((r, i) => { pctiles[dim][r.name] = pcts[i]; });
  });

  const totalWeight = dims.reduce((s, d) => s + (weights[d] || 0), 0) || 1;

  return raw.map(r => {
    const composite = dims.reduce((s, d) =>
      s + (pctiles[d][r.name] * (weights[d] || 0)), 0) / totalWeight;
    return { ...r, composite, pctiles: Object.fromEntries(dims.map(d => [d, pctiles[d][r.name]])) };
  }).sort((a, b) => b.composite - a.composite);
}

function renderPickWeightsPanel(weights) {
  const dims = [
    { key: 'opr',         label: 'OPR',           tip: 'Offensive Power Rating — expected scoring contribution per match' },
    { key: 'ccwm',        label: 'CCWM',          tip: 'Contribution to Winning Margin — how much they push the score past opponents' },
    { key: 'winRate',     label: 'Win Rate',       tip: 'Qualification record win percentage' },
    { key: 'auton',       label: 'Auton (AP/match)',tip: 'Average autonomous points earned per qualification match' },
    { key: 'skills',      label: 'Skills',         tip: 'Combined skills score — reflects individual robot capability' },
    { key: 'consistency', label: 'Consistency',    tip: 'Low score variance — reliable teams that show up every match' },
  ];
  const total = dims.reduce((s, d) => s + weights[d.key], 0);
  return `
    <div class="pl-weights-panel" id="pl-weights-panel">
      <div class="pl-weights-header">
        <span class="pl-weights-title">Scoring Weights <span class="pl-weights-total" id="pl-weights-total">(${total}%)</span></span>
        <button class="pl-weights-reset" id="pl-weights-reset">Reset defaults</button>
      </div>
      <div class="pl-weights-grid">
        ${dims.map(d => `
          <div class="pl-weight-row" title="${esc(d.tip)}">
            <label class="pl-weight-label">${esc(d.label)}</label>
            <input class="pl-weight-slider" type="range" min="0" max="60" step="5"
              data-dim="${d.key}" value="${weights[d.key]}">
            <span class="pl-weight-val" id="pl-wval-${d.key}">${weights[d.key]}%</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderPickList(eid) {
  const excluded = getExcluded(eid);
  const teams    = Object.keys(cachedEventRankings);
  if (!teams.length) return '<p class="empty">Load Rankings first to generate a pick list.</p>';

  const weights = getPickWeights();
  const rows_data = buildPicklistRows(weights);
  if (!rows_data) return '<p class="empty">No ranking data available.</p>';

  const rows = rows_data.map((t, i) => {
    const isExcl    = excluded.has(t.name);
    const pickNum   = isExcl ? '—' : '#' + (rows_data.filter((x, j) => j < i && !excluded.has(x.name)).length + 1);
    const barPct    = t.composite.toFixed(1);
    const barColor  = t.composite >= 75 ? '#15803D' : t.composite >= 50 ? 'var(--accent)' : t.composite >= 25 ? '#D97706' : '#9CA3AF';

    // Mini percentile pips for each dimension
    const pips = ['opr','ccwm','winRate','auton','skills','consistency'].map(d => {
      const pct = t.pctiles[d];
      const col = pct >= 75 ? '#15803D' : pct >= 50 ? 'var(--accent)' : pct >= 25 ? '#D97706' : '#9CA3AF';
      return `<span class="pl-pip" style="background:${col}" title="${d}: ${pct.toFixed(0)}th pct"></span>`;
    }).join('');

    return `<tr class="pl-row ${isExcl ? 'pl-excluded' : ''}" data-num="${esc(t.name)}">
      <td class="pl-pick-num">${pickNum}</td>
      <td class="pl-name-cell">
        <button class="team-link pl-team-name" data-num="${esc(t.name)}">${esc(t.name)}</button>
        ${t.hasNotes ? '<span class="scout-dot" title="Has scouting notes">●</span>' : ''}
      </td>
      <td class="pl-rank">${t.rank != null ? '#' + t.rank : '—'}</td>
      <td>${t.opr   != null ? t.opr.toFixed(1)  : '—'}</td>
      <td>${t.ccwm  != null ? t.ccwm.toFixed(1) : '—'}</td>
      <td>${t.winRate != null ? Math.round(t.winRate * 100) + '%' : '—'}</td>
      <td>${t.auton != null ? t.auton.toFixed(1) : '—'}</td>
      <td>${t.skills || '—'}</td>
      <td>${t.consistency != null ? Math.round(t.consistency * 100) + '%' : '—'}</td>
      <td class="pl-pips-cell">${pips}</td>
      <td class="pl-bar-cell">
        <div class="pl-bar-wrap">
          <div class="pl-bar-fill" style="width:${barPct}%;background:${barColor}"></div>
        </div>
        <span class="pl-score-num">${barPct}</span>
      </td>
      <td><button class="pl-excl-btn btn-secondary" data-num="${esc(t.name)}">${isExcl ? 'Restore' : 'Picked'}</button></td>
    </tr>`;
  }).join('');

  const available = rows_data.filter(t => !excluded.has(t.name)).length;
  return `
    ${renderPickWeightsPanel(weights)}
    <div class="stats-section">
      <div class="section-title">Pick List
        <span class="pl-subtitle">${available} available · ${rows_data.length - available} picked</span>
      </div>
      <p class="pl-info">Each stat is converted to a percentile rank among all teams at this event, then combined using your weights above.
        <strong>Color pips</strong>: green = top 25% · orange = top 50% · amber = top 75% · grey = bottom 25%.
        Click "Picked" to remove a team from the order.</p>
      <div class="table-wrap">
        <table class="pl-table">
          <thead><tr>
            <th>Pick</th><th>Team</th><th>Rank</th><th>OPR</th><th>CCWM</th>
            <th>Win%</th><th>AP/M</th><th>Skills</th><th>Consist.</th>
            <th title="Percentile breakdown per stat">Pcts</th><th>Score</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <button class="btn-secondary pl-reset-btn" id="pl-reset" style="margin-top:10px">Reset all picks</button>
    </div>`;
}

function wirePickList(container, eid) {
  // Weight sliders
  container.querySelectorAll('.pl-weight-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const w = getPickWeights();
      w[slider.dataset.dim] = +slider.value;
      savePickWeights(w);
      const valEl = container.querySelector(`#pl-wval-${slider.dataset.dim}`);
      if (valEl) valEl.textContent = slider.value + '%';
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      const totEl = container.querySelector('#pl-weights-total');
      if (totEl) totEl.textContent = `(${total}%)`;
      // Re-render table body only (not the whole panel) for snappy response
      const tbody = container.querySelector('.pl-table tbody');
      const excluded = getExcluded(eid);
      if (tbody) {
        const newRows = buildPicklistRows(w);
        if (newRows) {
          tbody.innerHTML = newRows.map((t, i) => {
            const isExcl  = excluded.has(t.name);
            const pickNum = isExcl ? '—' : '#' + (newRows.filter((x, j) => j < i && !excluded.has(x.name)).length + 1);
            const barPct  = t.composite.toFixed(1);
            const barColor = t.composite >= 75 ? '#15803D' : t.composite >= 50 ? 'var(--accent)' : t.composite >= 25 ? '#D97706' : '#9CA3AF';
            const pips = ['opr','ccwm','winRate','auton','skills','consistency'].map(d => {
              const pct = t.pctiles[d];
              const col = pct >= 75 ? '#15803D' : pct >= 50 ? 'var(--accent)' : pct >= 25 ? '#D97706' : '#9CA3AF';
              return `<span class="pl-pip" style="background:${col}" title="${d}: ${pct.toFixed(0)}th pct"></span>`;
            }).join('');
            return `<tr class="pl-row ${isExcl ? 'pl-excluded' : ''}" data-num="${esc(t.name)}">
              <td class="pl-pick-num">${pickNum}</td>
              <td class="pl-name-cell">
                <button class="team-link pl-team-name" data-num="${esc(t.name)}">${esc(t.name)}</button>
                ${t.hasNotes ? '<span class="scout-dot" title="Has scouting notes">●</span>' : ''}
              </td>
              <td class="pl-rank">${t.rank != null ? '#' + t.rank : '—'}</td>
              <td>${t.opr   != null ? t.opr.toFixed(1)  : '—'}</td>
              <td>${t.ccwm  != null ? t.ccwm.toFixed(1) : '—'}</td>
              <td>${t.winRate != null ? Math.round(t.winRate * 100) + '%' : '—'}</td>
              <td>${t.auton != null ? t.auton.toFixed(1) : '—'}</td>
              <td>${t.skills || '—'}</td>
              <td>${t.consistency != null ? Math.round(t.consistency * 100) + '%' : '—'}</td>
              <td class="pl-pips-cell">${pips}</td>
              <td class="pl-bar-cell">
                <div class="pl-bar-wrap"><div class="pl-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
                <span class="pl-score-num">${barPct}</span>
              </td>
              <td><button class="pl-excl-btn btn-secondary" data-num="${esc(t.name)}">${isExcl ? 'Restore' : 'Picked'}</button></td>
            </tr>`;
          }).join('');
          wirePickListRows(container, eid);
        }
      }
    });
  });

  container.querySelector('#pl-weights-reset')?.addEventListener('click', () => {
    savePickWeights({ ...PL_WEIGHT_DEFAULTS });
    container.innerHTML = renderPickList(eid);
    wirePickList(container, eid);
  });

  container.querySelector('#pl-reset')?.addEventListener('click', () => {
    saveExcluded(eid, new Set());
    container.innerHTML = renderPickList(eid);
    wirePickList(container, eid);
  });

  wirePickListRows(container, eid);
}

function wirePickListRows(container, eid) {
  container.querySelectorAll('.pl-excl-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const excl = getExcluded(eid);
      const num = btn.dataset.num;
      if (excl.has(num)) excl.delete(num); else excl.add(num);
      saveExcluded(eid, excl);
      container.innerHTML = renderPickList(eid);
      wirePickList(container, eid);
    });
  });
  container.querySelectorAll('.pl-team-name[data-num]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openTeamEventView(btn.dataset.num); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOUTING NOTES
// ═══════════════════════════════════════════════════════════════════════════

function scoutKey(teamNumber) { return `scout_${teamNumber}`; }

function getScoutNote(teamNumber) {
  try { return JSON.parse(localStorage.getItem(scoutKey(teamNumber)) || 'null') || {}; } catch (_) { return {}; }
}
function saveScoutNote(teamNumber, note) {
  localStorage.setItem(scoutKey(teamNumber), JSON.stringify({ ...note, ts: Date.now() }));
}
function hasScoutNote(teamNumber) {
  const n = getScoutNote(teamNumber);
  return !!(n.auto || n.intake || n.endgame || n.driver || n.notes || n.rating);
}

function renderScoutingNotesSection(teamNumber) {
  const n = getScoutNote(teamNumber);
  const starBar = () => [1,2,3,4,5].map(i =>
    `<button class="scout-star ${(n.rating||0) >= i ? 'lit' : ''}" data-val="${i}">★</button>`
  ).join('');

  return `
    <div class="stats-section scout-section" id="scout-notes-section">
      <div class="section-title">Scouting Notes — ${esc(teamNumber)}
        ${hasScoutNote(teamNumber) ? '<span class="scout-saved-badge">Saved</span>' : ''}
      </div>
      <div class="scout-rating-row">
        <span class="scout-field-label">Overall</span>
        <div class="scout-stars" id="scout-stars">${starBar()}</div>
      </div>
      <div class="scout-grid">
        <label class="scout-field">
          <span class="scout-field-label">Autonomous</span>
          <input class="scout-input" id="scout-auto" type="text" placeholder="e.g. consistent 2-ball auton" value="${esc(n.auto||'')}">
        </label>
        <label class="scout-field">
          <span class="scout-field-label">Intake / Mechanism</span>
          <input class="scout-input" id="scout-intake" type="text" placeholder="e.g. fast roller, drops often" value="${esc(n.intake||'')}">
        </label>
        <label class="scout-field">
          <span class="scout-field-label">Driver Skill</span>
          <input class="scout-input" id="scout-driver" type="text" placeholder="e.g. very consistent, plays defense" value="${esc(n.driver||'')}">
        </label>
        <label class="scout-field">
          <span class="scout-field-label">Endgame</span>
          <input class="scout-input" id="scout-endgame" type="text" placeholder="e.g. reliable hang, ~8pts" value="${esc(n.endgame||'')}">
        </label>
      </div>
      <label class="scout-field scout-notes-field">
        <span class="scout-field-label">Free Notes</span>
        <textarea class="scout-textarea" id="scout-notes" rows="3" placeholder="Anything else…">${esc(n.notes||'')}</textarea>
      </label>
      <div class="scout-actions">
        <button class="btn-primary scout-save-btn" id="scout-save">Save Notes</button>
        <button class="btn-secondary scout-clear-btn" id="scout-clear">Clear</button>
        <span class="scout-ts" id="scout-ts">${n.ts ? 'Last saved ' + timeAgo(n.ts) : ''}</span>
      </div>
    </div>`;
}

function wireScoutingNotes(container, teamNumber) {
  let rating = getScoutNote(teamNumber).rating || 0;

  container.querySelectorAll('.scout-star').forEach(btn => {
    btn.addEventListener('click', () => {
      rating = +btn.dataset.val;
      container.querySelectorAll('.scout-star').forEach(s =>
        s.classList.toggle('lit', +s.dataset.val <= rating));
    });
  });

  container.getElementById?.('scout-save') || container.querySelector('#scout-save')
    ?.addEventListener('click', () => {
      const note = {
        rating,
        auto:    container.querySelector('#scout-auto')?.value || '',
        intake:  container.querySelector('#scout-intake')?.value || '',
        driver:  container.querySelector('#scout-driver')?.value || '',
        endgame: container.querySelector('#scout-endgame')?.value || '',
        notes:   container.querySelector('#scout-notes')?.value || '',
      };
      saveScoutNote(teamNumber, note);
      const ts = container.querySelector('#scout-ts');
      if (ts) ts.textContent = 'Saved just now';
      const badge = container.querySelector('.scout-saved-badge');
      if (!badge) {
        const title = container.querySelector('.section-title');
        if (title) title.insertAdjacentHTML('beforeend', '<span class="scout-saved-badge">Saved</span>');
      }
    });

  container.querySelector('#scout-clear')?.addEventListener('click', () => {
    localStorage.removeItem(scoutKey(teamNumber));
    const section = container.querySelector('#scout-notes-section');
    if (section) { section.outerHTML = renderScoutingNotesSection(teamNumber); wireScoutingNotes(container, teamNumber); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TEAM AT EVENT VIEW
// ═══════════════════════════════════════════════════════════════════════════

async function openTeamEventView(teamNumber) {
  currentTeamAtEvent = teamNumber;
  showView('view-team-event');

  document.getElementById('team-event-hero').innerHTML = `
    <div class="team-event-header">
      <div class="team-event-number">${esc(teamNumber)}</div>
      <div class="team-event-context">at <button class="event-name-link" id="back-to-event-link">${esc(currentEvent?.name || 'Event')}</button></div>
      <div class="team-event-actions">
        <button class="btn-secondary" id="view-season-history-btn">Full Season History →</button>
      </div>
    </div>`;

  document.getElementById('back-to-event-link').addEventListener('click', async () => {
    pendingHighlightTeam = currentTeamAtEvent;
    activeEventTab = 'rankings';
    showView('view-event');
    document.querySelectorAll('.detail-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === 'rankings'));
    await loadEventTabContent();
  });

  document.getElementById('view-season-history-btn').addEventListener('click', async () => {
    setStatus('team-event', 'Loading…');
    try {
      const json = await apiFetch(`/teams?number[]=${encodeURIComponent(teamNumber)}&myTeams=false`);
      const team = json.data?.[0];
      if (team) { clearStatus('team-event'); openSeasonsView(team); }
      else setStatus('team-event', `Team ${esc(teamNumber)} not found.`, 'error');
    } catch (err) { setStatus('team-event', `Error: ${err.message}`, 'error'); }
  });

  setStatus('team-event', 'Loading schedule…');
  const contentEl = document.getElementById('team-event-content');
  contentEl.innerHTML = '';

  try {
    if (!cachedEventMatches.length && activeDiv) {
      cachedEventMatches = await fetchAllPages(`/events/${currentEvent.id}/divisions/${activeDiv}/matches`);
    }
    if (!Object.keys(cachedOPR).length && cachedEventMatches.length) {
      cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2)); _predStatCache = null;
    }
    if (!Object.keys(cachedOPR).length && !Object.keys(cachedSeasonOPR).length) {
      loadSeasonOPR().catch(() => {});
    }
    if (!Object.keys(cachedEventRankings).length && activeDiv) {
      try { buildRankingsCache(await fetchAllPages(`/events/${currentEvent.id}/divisions/${activeDiv}/rankings`)); } catch (_) {}
    }
    if (!Object.keys(cachedEventSkills).length) {
      try { buildSkillsCache(await fetchAllPages(`/events/${currentEvent.id}/skills`)); } catch (_) {}
    }

    const teamMatches = cachedEventMatches
      .map((m, i) => ({ ...m, _idx: i }))
      .filter(m => (m.alliances || []).some(a => (a.teams || []).some(t => t.team?.name === teamNumber)));

    let histData = null;
    try { histData = await fetchTeamSeasonStats(teamNumber); } catch (_) {}

    clearStatus('team-event');
    const { html: schedHtml, sorted: schedSorted } = renderTeamEventSchedule(teamMatches, teamNumber, histData);
    contentEl.innerHTML =
      renderScoutingNotesSection(teamNumber) +
      renderPredWeightsPanel() +
      renderScheduleStrengthSection(teamNumber) +
      '<div id="team-sched-container">' + schedHtml + '</div>';
    wireScoutingNotes(contentEl, teamNumber);

    const wireTeamLinks = el => {
      el.querySelectorAll('.team-link[data-num]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const num = btn.dataset.num;
          if (num && num !== 'undefined') openTeamEventView(num);
        });
      });
    };
    wireTeamLinks(contentEl);
    wireSchedRows(contentEl.querySelector('#team-sched-container'), schedSorted);

    const reRenderSched = () => {
      const sosEl = contentEl.querySelector('.sos-section');
      if (sosEl) sosEl.outerHTML = renderScheduleStrengthSection(teamNumber);
      const c = contentEl.querySelector('#team-sched-container');
      if (c) {
        const { html, sorted } = renderTeamEventSchedule(teamMatches, teamNumber, histData);
        c.innerHTML = html;
        wireTeamLinks(c);
        wireSchedRows(c, sorted);
      }
    };

    const predToggle = contentEl.querySelector('#pred-show-toggle');
    if (predToggle) {
      predToggle.addEventListener('click', () => {
        showMatchPredictions = !showMatchPredictions;
        predToggle.classList.toggle('active', showMatchPredictions);
        localStorage.setItem('showMatchPredictions', JSON.stringify(showMatchPredictions));
        reRenderSched();
      });
    }

    attachWeightListeners(contentEl, reRenderSched);
  } catch (err) {
    setStatus('team-event', `Error: ${err.message}`, 'error');
  }
}

async function fetchTeamSeasonStats(teamNumber) {
  const json = await apiFetch(`/teams?number[]=${encodeURIComponent(teamNumber)}&myTeams=false`);
  const team = json.data?.[0];
  if (!team) return null;
  const seasonId = currentEvent?.season?.id;
  if (!seasonId) return { team };
  const [rankings, skills] = await Promise.all([
    fetchAllPages(`/teams/${team.id}/rankings?season[]=${seasonId}`),
    fetchAllPages(`/teams/${team.id}/skills?season[]=${seasonId}`),
  ]);
  const prior  = rankings.filter(r => r.event?.id !== currentEvent?.id);
  const wins   = prior.reduce((s, r) => s + (r.wins   || 0), 0);
  const losses = prior.reduce((s, r) => s + (r.losses || 0), 0);
  const ties   = prior.reduce((s, r) => s + (r.ties   || 0), 0);
  const total  = wins + losses + ties;
  return {
    team,
    priorEvents: prior.length,
    wins, losses, ties,
    winRate:    total > 0 ? wins / total : null,
    bestDriver: skills.filter(s => s.type === 'driver').reduce((m, s) => Math.max(m, s.score || 0), 0) || null,
    bestProg:   skills.filter(s => s.type === 'programming').reduce((m, s) => Math.max(m, s.score || 0), 0) || null,
  };
}

function mc(val, label) {
  return '<div class="metric-card"><div class="metric-value">' + (val != null ? val : '—') +
    '</div><div class="metric-label">' + label + '</div></div>';
}

function buildRankingsCache(data) {
  cachedEventRankings = {};
  for (const r of data) {
    if (!r.team?.name) continue;
    const total = (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
    cachedEventRankings[r.team.name] = {
      rank: r.rank,
      wins: r.wins || 0, losses: r.losses || 0, ties: r.ties || 0,
      winRate: total > 0 ? (r.wins || 0) / total : 0.5,
      wp: r.wp || 0,
      sp: r.sp || 0,
    };
  }
}

function buildSkillsCache(data) {
  cachedEventSkills = {};
  for (const s of data) {
    const name = s.team?.name;
    if (!name) continue;
    if (!cachedEventSkills[name]) cachedEventSkills[name] = { driver: 0, prog: 0 };
    if (s.type === 'driver') cachedEventSkills[name].driver = Math.max(cachedEventSkills[name].driver, s.score || 0);
    else if (s.type === 'programming') cachedEventSkills[name].prog = Math.max(cachedEventSkills[name].prog, s.score || 0);
  }
  const maxCombined = Math.max(1, ...Object.values(cachedEventSkills).map(s => s.driver + s.prog));
  for (const name of Object.keys(cachedEventSkills)) {
    const sk = cachedEventSkills[name];
    sk.combined   = sk.driver + sk.prog;
    sk.normalized = sk.combined / maxCombined;
  }
}

// ── Prediction Accuracy Tracker ───────────────────────────────────────────
function renderPredictionAccuracy(matches) {
  const quals = matches.filter(m => m.round === 2 && matchIsScored(m));
  if (quals.length < 3) return '';

  let correct = 0, total = 0;
  // Confidence buckets: [0-59%, 60-74%, 75-87%]
  const buckets = [
    { label: '< 60%',  min: 0,  max: 60,  c: 0, t: 0 },
    { label: '60–74%', min: 60, max: 75,  c: 0, t: 0 },
    { label: '75%+',   min: 75, max: 100, c: 0, t: 0 },
  ];
  const byMatch = [];

  for (const m of quals) {
    const pred = predictMatch(m);
    if (!pred) continue;
    const alliances = m.alliances || [];
    const red  = alliances.find(a => a.color === 'red');
    const blue = alliances.find(a => a.color === 'blue');
    if (!red || !blue) continue;

    const actualWinner = red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie';
    const predWinner   = pred.winner;
    const hit = actualWinner === predWinner ||
                (actualWinner === 'tie' && predWinner === 'tie');
    if (hit) correct++;
    total++;

    const bucket = buckets.find(b => pred.confidence >= b.min && pred.confidence < b.max)
                   ?? buckets[buckets.length - 1];
    bucket.t++;
    if (hit) bucket.c++;

    byMatch.push({ num: m.matchnum, hit, confidence: pred.confidence, pred: predWinner, actual: actualWinner });
  }

  if (!total) return '';

  const pct = Math.round(correct / total * 100);
  const barColor = pct >= 70 ? '#15803D' : pct >= 55 ? '#D97706' : '#DC2626';

  // Running accuracy line chart (SVG)
  const W = 320, H = 52, pad = { l: 28, r: 8, t: 6, b: 14 };
  const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;
  let running = 0;
  const pts = byMatch.map((m, i) => {
    if (m.hit) running++;
    return { x: pad.l + (i / Math.max(byMatch.length - 1, 1)) * iW, y: pad.t + (1 - running / (i + 1)) * iH };
  });
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const fillD = pathD + ` L${pts[pts.length-1].x.toFixed(1)},${pad.t+iH} L${pad.l},${pad.t+iH} Z`;

  // Gridlines at 50% and 75%
  const y50 = pad.t + 0.5 * iH, y75 = pad.t + 0.25 * iH;
  const chart = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="acc-chart-svg">
      <line x1="${pad.l}" y1="${y75.toFixed(1)}" x2="${W-pad.r}" y2="${y75.toFixed(1)}" stroke="var(--border)" stroke-width="0.7" stroke-dasharray="3,2"/>
      <line x1="${pad.l}" y1="${y50.toFixed(1)}" x2="${W-pad.r}" y2="${y50.toFixed(1)}" stroke="var(--border)" stroke-width="0.7" stroke-dasharray="3,2"/>
      <text x="${pad.l-3}" y="${(y75+3).toFixed(1)}" fill="var(--text-muted)" font-size="7" text-anchor="end">75%</text>
      <text x="${pad.l-3}" y="${(y50+3).toFixed(1)}" fill="var(--text-muted)" font-size="7" text-anchor="end">50%</text>
      <path d="${fillD}" fill="var(--accent)" fill-opacity="0.12"/>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round"/>
      ${pts.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${byMatch[i].hit ? 'var(--accent)' : '#DC2626'}" stroke="var(--bg)" stroke-width="1">
        <title>Q${byMatch[i].num}: ${byMatch[i].hit ? '✓' : '✗'} (conf. ${byMatch[i].confidence}%)</title></circle>`).join('')}
    </svg>`;

  const bucketRows = buckets.filter(b => b.t > 0).map(b => {
    const bPct = Math.round(b.c / b.t * 100);
    return `<tr>
      <td>${esc(b.label)}</td>
      <td>${b.c}/${b.t}</td>
      <td><div class="acc-bucket-bar"><div style="width:${bPct}%;background:${bPct>=70?'#15803D':bPct>=55?'#D97706':'#DC2626'}"></div></div></td>
      <td style="font-weight:700;color:${bPct>=70?'#15803D':bPct>=55?'#D97706':'#DC2626'}">${bPct}%</td>
    </tr>`;
  }).join('');

  return `
    <div class="stats-section acc-section">
      <div class="section-title">Prediction Accuracy</div>
      <div class="acc-summary">
        <div class="acc-big-num" style="color:${barColor}">${pct}%</div>
        <div class="acc-big-label">${correct} of ${total} qual matches predicted correctly</div>
        <div class="acc-note">Using current OPR/CCWM weights · dot = match (green=correct, red=wrong)</div>
      </div>
      <div class="acc-chart">${chart}</div>
      <div class="table-wrap" style="margin-top:10px">
        <table style="font-size:.82rem">
          <thead><tr><th>Confidence</th><th>Correct</th><th>Bar</th><th>%</th></tr></thead>
          <tbody>${bucketRows}</tbody>
        </table>
      </div>
    </div>`;
}

// Returns [{label, redScore, blueScore}] showing how the prediction for targetMatch evolved
function computePredictionHistory(targetMatch) {
  const alliances = targetMatch.alliances || [];
  const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
  const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};
  const redTeams  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
  const blueTeams = (blue.teams || []).map(t => t.team?.name).filter(Boolean);
  if (!redTeams.length && !blueTeams.length) return [];

  const prev = cachedEventMatches.filter(m =>
    m.round === 2 && m.matchnum < targetMatch.matchnum &&
    matchIsScored(m)
  ).sort((a, b) => a.matchnum - b.matchnum);

  if (prev.length < 2) return [];

  const points = [];
  for (let n = 1; n <= prev.length; n++) {
    const opr  = computeOPR(prev.slice(0, n));
    const maxO = Math.max(1, ...Object.values(opr).map(o => o.opr));
    const fallback = name => {
      const wR = Object.keys(cachedEventRankings).length ? predWeights.ranking : 0;
      const wS = Object.keys(cachedEventSkills).length   ? predWeights.skills  : 0;
      const wT = wR + wS || 1;
      return maxO * ((cachedEventRankings[name]?.winRate ?? 0.5) * wR +
                     (cachedEventSkills[name]?.normalized || 0) * wS) / wT;
    };
    const eff = name => { const v = opr[name]?.opr; return (v != null && v > 0) ? v : fallback(name); };
    points.push({
      label:     'Q' + prev[n - 1].matchnum,
      redScore:  Math.max(0, Math.round(redTeams.reduce((s, n) => s + eff(n), 0))),
      blueScore: Math.max(0, Math.round(blueTeams.reduce((s, n) => s + eff(n), 0))),
    });
  }
  return points;
}

function renderPredEvolutionChart(points) {
  if (points.length < 2) return '';
  const W = 480, H = 130, PL = 36, PR = 12, PT = 12, PB = 28;
  const iW = W - PL - PR, iH = H - PT - PB;
  const scores = points.flatMap(p => [p.redScore, p.blueScore]);
  const minS = Math.max(0, Math.min(...scores) - 15);
  const maxS = Math.max(...scores) + 15;
  const xS = i => PL + (points.length > 1 ? (i / (points.length - 1)) * iW : iW / 2);
  const yS = v => PT + iH - ((v - minS) / (maxS - minS || 1)) * iH;

  // Grid lines
  const yMid = (minS + maxS) / 2;
  const gridLines =
    '<line x1="' + PL + '" y1="' + yS(maxS - 15) + '" x2="' + (W - PR) + '" y2="' + yS(maxS - 15) + '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,3"/>' +
    '<line x1="' + PL + '" y1="' + yS(yMid) + '" x2="' + (W - PR) + '" y2="' + yS(yMid) + '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,3"/>' +
    '<text x="' + (PL - 4) + '" y="' + (yS(maxS - 15) + 3) + '" text-anchor="end" font-size="8" fill="var(--text-muted)">' + Math.round(maxS - 15) + '</text>' +
    '<text x="' + (PL - 4) + '" y="' + (yS(yMid) + 3) + '" text-anchor="end" font-size="8" fill="var(--text-muted)">' + Math.round(yMid) + '</text>';

  const RC = 'var(--red)';  // adapts in dark mode
  const BC = 'var(--blue)';
  const redLine  = points.map((p, i) => xS(i) + ',' + yS(p.redScore)).join(' ');
  const blueLine = points.map((p, i) => xS(i) + ',' + yS(p.blueScore)).join(' ');

  // Invisible hover targets (no visible dots — just tooltip area)
  const redHover  = points.map((p, i) =>
    '<circle cx="' + xS(i) + '" cy="' + yS(p.redScore) + '" r="6" fill="transparent" stroke="none">' +
    '<title>' + p.label + ': Red ~' + p.redScore + '</title></circle>').join('');
  const blueHover = points.map((p, i) =>
    '<circle cx="' + xS(i) + '" cy="' + yS(p.blueScore) + '" r="6" fill="transparent" stroke="none">' +
    '<title>' + p.label + ': Blue ~' + p.blueScore + '</title></circle>').join('');

  // Only first and last x-axis labels
  const first = points[0], last = points[points.length - 1];
  const xLabels =
    '<text x="' + xS(0) + '" y="' + (PT + iH + 16) + '" text-anchor="middle" font-size="8" fill="var(--text-muted)">' + first.label + '</text>' +
    (points.length > 1 ? '<text x="' + xS(points.length - 1) + '" y="' + (PT + iH + 16) + '" text-anchor="middle" font-size="8" fill="var(--text-muted)">' + last.label + '</text>' : '');

  const lastPt = points[points.length - 1];
  const winner = lastPt.redScore > lastPt.blueScore ? 'Red' : lastPt.blueScore > lastPt.redScore ? 'Blue' : 'Tie';
  const wColor = winner === 'Red' ? RC : winner === 'Blue' ? BC : 'var(--text-muted)';
  const wScore = winner === 'Red' ? lastPt.redScore : lastPt.blueScore;

  return '<div class="stats-section pred-evo-section">' +
    '<div class="section-title">Prediction Evolution</div>' +
    '<div class="pred-evo-legend"><span class="evo-red">■ Red</span><span class="evo-blue">■ Blue</span><span class="evo-hint">Hover for per-match values</span></div>' +
    '<div class="win-rate-graph">' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:560px;display:block">' +
    gridLines +
    '<polyline points="' + redLine  + '" fill="none" stroke="' + RC + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<polyline points="' + blueLine + '" fill="none" stroke="' + BC + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    redHover + blueHover + xLabels +
    '</svg>' +
    '<p class="evo-summary" style="color:' + wColor + '">' +
    winner + ' projected ~' + wScore + ' pts (after ' + points.length + ' match' + (points.length !== 1 ? 'es' : '') + ' of data)</p>' +
    '</div></div>';
}

function renderTeamEventSchedule(teamMatches, teamNumber, histData) {
  const oprEntry = cachedOPR[teamNumber];

  // Current event record
  let wins = 0, losses = 0, ties = 0;
  for (const match of teamMatches) {
    const al   = match.alliances || [];
    const mine = al.find(a => (a.teams || []).some(t => t.team?.name === teamNumber));
    const opp  = al.find(a => !(a.teams || []).some(t => t.team?.name === teamNumber));
    if (!mine || !opp || !matchIsScored(match)) continue;
    if (mine.score > opp.score) wins++;
    else if (mine.score < opp.score) losses++;
    else ties++;
  }

  // Predicted wins in unscored matches
  let predWins = 0, predCount = 0;
  for (const match of teamMatches) {
    const al   = match.alliances || [];
    const mine = al.find(a => (a.teams || []).some(t => t.team?.name === teamNumber));
    if (!mine || matchIsScored(match)) continue;
    const pred = predictMatch(match);
    if (pred) { predCount++; if (pred.winner === mine.color) predWins++; }
  }

  // ── Summary metrics
  const ccwmColor = oprEntry ? (oprEntry.ccwm >= 0 ? 'var(--accent)' : '#B91C1C') : '';
  const summaryMetrics =
    mc(wins + '–' + losses + '–' + ties, 'Record') +
    mc(teamMatches.length || '—', 'Matches') +
    (oprEntry ? mc(oprEntry.opr.toFixed(1), 'OPR') : '') +
    (oprEntry ? '<div class="metric-card"><div class="metric-value" style="color:' + ccwmColor + '">' +
      oprEntry.ccwm.toFixed(1) + '</div><div class="metric-label">CCWM</div></div>' : '') +
    (predCount > 0 ? mc(predWins + '/' + predCount, 'Pred. Wins') : '');

  const summarySection =
    '<div class="stats-section"><div class="section-title">At This Event</div>' +
    '<div class="metrics-row">' + summaryMetrics + '</div></div>';

  // ── Historical context
  let histSection = '';
  if (histData && (histData.priorEvents > 0 || histData.bestDriver)) {
    const pct = histData.winRate != null ? Math.round(histData.winRate * 100) : null;
    const pctColor = pct != null ? (pct >= 60 ? 'var(--accent)' : pct < 40 ? '#B91C1C' : 'var(--text)') : '';
    const histMetrics =
      (histData.priorEvents ? mc(histData.priorEvents, 'Prior Events') : '') +
      (pct != null ? '<div class="metric-card"><div class="metric-value" style="color:' + pctColor + '">' +
        pct + '%</div><div class="metric-label">Win Rate</div></div>' : '') +
      (histData.wins != null && histData.priorEvents ?
        mc(histData.wins + '–' + histData.losses + '–' + histData.ties, 'W–L–T') : '') +
      (histData.bestDriver ? mc(histData.bestDriver, 'Best Driver') : '') +
      (histData.bestProg   ? mc(histData.bestProg,   'Best Prog.')  : '');
    histSection =
      '<div class="stats-section"><div class="section-title">Season History (Prior Events)</div>' +
      '<div class="metrics-row">' + histMetrics + '</div></div>';
  }

  const sorted = [...teamMatches].sort((a, b) =>
    (a.round - b.round) || (a.instance - b.instance) || (a.matchnum - b.matchnum));

  const nextUnscored = sorted.find(m =>
    m.round === 2 && !matchIsScored(m));
  const graphSection = nextUnscored ? renderPredEvolutionChart(computePredictionHistory(nextUnscored)) : '';

  // ── Match schedule table
  if (!sorted.length) {
    return {
      html: summarySection + histSection + graphSection +
        '<p class="empty" style="margin-top:16px">No matches found for this team at this event yet.</p>',
      sorted,
    };
  }

  let rowsHtml = '';
  for (let midx = 0; midx < sorted.length; midx++) {
    const match = sorted[midx];
    const al   = match.alliances || [];
    const mine = al.find(a => (a.teams || []).some(t => t.team?.name === teamNumber));
    const opp  = al.find(a => !(a.teams || []).some(t => t.team?.name === teamNumber));
    if (!mine) continue;

    const myColor  = mine.color || 'red';
    const partners = (mine.teams || []).filter(t => t.team?.name !== teamNumber)
      .map(t => esc(t.team?.name || '?')).join(' / ') || '—';
    const opponents = (opp?.teams || [])
      .map(t => '<button class="team-link" data-num="' + esc(t.team?.name || '') + '">' +
        esc(t.team?.name || '?') + '</button>').join(' / ') || '—';

    const matchId = match.round === 2 ? 'Q' + match.matchnum
      : match.round === 1 ? 'P' + match.matchnum
      : (ROUND_NAMES[match.round] || 'M') + ' ' + match.instance + '-' + match.matchnum;

    const hasScore = matchIsScored(match);
    const pred = predictMatch(match);
    let scoreCell, resultCell;

    if (hasScore) {
      const won  = mine.score > opp.score;
      const lost = mine.score < opp.score;
      const cls  = won ? 'match-result-win' : lost ? 'match-result-loss' : 'match-result-tie';
      scoreCell  = '<strong>' + mine.score + '</strong> – <span style="color:var(--text-muted)">' + opp.score + '</span>';
      resultCell = '<span class="' + cls + '">' + (won ? 'W' : lost ? 'L' : 'T') + '</span>';
      if (pred) {
        const actualWinner = won ? myColor : lost ? (myColor === 'red' ? 'blue' : 'red') : 'tie';
        const correct = pred.winner === actualWinner;
        resultCell += ' <span class="pred-inline ' + (correct ? 'pred-correct' : 'pred-wrong') + '">' +
          (correct ? '✓' : '✗') + ' ' + pred.confidence + '%</span>';
      }
    } else if (pred) {
      const myPred  = myColor === 'red' ? pred.redScore  : pred.blueScore;
      const oppPred = myColor === 'red' ? pred.blueScore : pred.redScore;
      const icon    = pred.winner === myColor ? '↑' : pred.winner !== 'tie' ? '↓' : '~';
      const scoreStr = (myPred !== null && oppPred !== null)
        ? '~' + myPred + ' – ~' + oppPred : '—';
      scoreCell  = '<span class="pred-score">' + scoreStr + '</span>';
      resultCell = '<span class="pred-badge">' + icon + ' ' + pred.confidence + '%</span>';
    } else {
      scoreCell  = '—';
      resultCell = '—';
    }

    rowsHtml += '<tr class="sched-row" data-midx="' + midx + '">' +
      '<td class="match-id-cell">' + matchId + ' ' + streamLink(matchId) + '</td>' +
      '<td><span class="alliance-pill ' + myColor + '">' + (myColor === 'red' ? 'Red' : 'Blue') + '</span></td>' +
      '<td class="team-partners">' + partners + '</td>' +
      '<td>' + opponents + '</td>' +
      '<td>' + scoreCell + '</td>' +
      '<td>' + resultCell + '</td>' +
      '</tr>';
  }

  const scheduleSection =
    '<div class="stats-section"><div class="section-title">Match Schedule</div>' +
    '<div class="table-wrap"><table>' +
    '<thead><tr><th>Match</th><th>Side</th><th>Partners</th><th>Opponents</th>' +
    '<th>Score</th><th>Result</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div></div>';

  return { html: summarySection + histSection + graphSection + scheduleSection, sorted };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARE TEAMS VIEW
// ═══════════════════════════════════════════════════════════════════════════

const compareState = {
  slots: [null, null, null, null],
  programId: 1,
  seasonId: null,
  seasons: [],
};

async function openCompareView() {
  showView('view-compare');
  if (!compareState.seasons.length) {
    await loadCompareSeasons(compareState.programId);
  }
  renderCompareSeasonPicker();
  renderCompareSearchRow();
  renderCompareContent();
}

async function loadCompareSeasons(programId) {
  const list = await fetchProgramSeasons(programId);
  compareState.programId = programId;
  compareState.seasons   = list;
  compareState.seasonId  = list[0]?.id || null;
}

function renderCompareSeasonPicker() {
  const el = document.getElementById('compare-search-row');
  if (!el) return;
  const programs = [{ id: 1, label: 'V5RC' }, { id: 4, label: 'VEXU' }, { id: 41, label: 'VIQRC' }];
  const progOpts = programs.map(p =>
    `<option value="${p.id}"${p.id === compareState.programId ? ' selected' : ''}>${p.label}</option>`
  ).join('');
  const seasonOpts = compareState.seasons.map(s =>
    `<option value="${s.id}"${s.id === compareState.seasonId ? ' selected' : ''}>${esc(s.name)}</option>`
  ).join('');

  const pickerHtml = `
    <div class="h2h-season-row" id="cmp-season-row">
      <label class="h2h-season-label">Program</label>
      <select class="season-picker-sel" id="cmp-prog-sel">${progOpts}</select>
      <label class="h2h-season-label">Season</label>
      <select class="season-picker-sel" id="cmp-season-sel">${seasonOpts || '<option>Loading…</option>'}</select>
    </div>`;

  // Only prepend picker row once (it persists; the add-row is rebuilt separately)
  const existing = el.querySelector('#cmp-season-row');
  if (!existing) {
    el.insertAdjacentHTML('afterbegin', pickerHtml);
  } else {
    existing.outerHTML = pickerHtml;
  }

  el.querySelector('#cmp-prog-sel')?.addEventListener('change', async e => {
    const pid = +e.target.value;
    await loadCompareSeasons(pid);
    compareState.slots = [null, null, null, null];
    renderCompareSeasonPicker();
    renderCompareSearchRow();
    renderCompareContent();
  });

  el.querySelector('#cmp-season-sel')?.addEventListener('change', e => {
    compareState.seasonId = +e.target.value;
    compareState.slots = [null, null, null, null];
    renderCompareSearchRow();
    renderCompareContent();
  });
}

function renderCompareSearchRow() {
  const el = document.getElementById('compare-search-row');
  const filled = compareState.slots.filter(Boolean).length;
  const canAdd = filled < 4;
  // Preserve the season picker row; only update the add row below it
  let addRowEl = el.querySelector('.compare-add-row');
  if (!addRowEl) {
    addRowEl = document.createElement('div');
    addRowEl.className = 'compare-add-row';
    el.appendChild(addRowEl);
  }
  addRowEl.innerHTML = canAdd ? `
    <input id="cmp-input" type="text" class="compare-input" placeholder="Enter team number (e.g. 2397A)" autocomplete="off" />
    <button id="cmp-add-btn" class="btn-primary">Add Team</button>
  ` : `<span class="compare-max-note">4 teams added — remove one to add another.</span>`;
  if (canAdd) {
    const inp = el.querySelector('#cmp-input');
    const btn = el.querySelector('#cmp-add-btn');
    btn.addEventListener('click', () => addCompareTeam(inp.value.trim()));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') addCompareTeam(inp.value.trim()); });
  }
}

async function addCompareTeam(number) {
  if (!number) return;
  const already = compareState.slots.find(s => s && s.team.number?.toLowerCase() === number.toLowerCase());
  if (already) {
    setStatus('compare', `${number} is already in the comparison.`, 'warn'); return;
  }
  const filled = compareState.slots.filter(Boolean).length;
  if (filled >= 4) { setStatus('compare', 'Maximum 4 teams.', 'warn'); return; }

  setStatus('compare', `Loading ${number}…`);
  try {
    const pid = compareState.programId || 1;
    const json = await apiFetch(`/teams?number[]=${encodeURIComponent(number)}&program[]=${pid}&myTeams=false`);
    const team = json.data?.[0];
    if (!team) { setStatus('compare', `Team ${number} not found.`, 'error'); return; }

    // Use selected season; fall back to team's most recent if none
    let sid = compareState.seasonId;
    let season = compareState.seasons.find(s => s.id === sid) || null;
    if (!sid) {
      const allEvs = await fetchAllPages(`/teams/${team.id}/events`);
      const seasonMap = {};
      allEvs.forEach(ev => { if (ev.season) seasonMap[ev.season.id] = ev.season; });
      season = Object.values(seasonMap).sort((a, b) => b.id - a.id)[0] || null;
      sid = season?.id || null;
    }
    if (!sid) { setStatus('compare', `No season data for ${number}.`, 'error'); return; }
    if (!season) season = { id: sid, name: '' };
    const allEvents = await fetchAllPages(`/teams/${team.id}/events?season[]=${sid}`);
    const [rankings, skills, awards, worldEntry, allMatches] = await Promise.all([
      fetchAllPages(`/teams/${team.id}/rankings?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/skills?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/awards?season[]=${sid}`),
      fetchTeamWorldSkillsRank(team.number, sid, team.grade),
      fetchAllPages(`/teams/${team.id}/matches?season[]=${sid}`),
    ]);

    // Compute per-event OPR from qual matches only, then average across events
    const matchesByEvent = {};
    allMatches.forEach(m => {
      if (m.round !== 2) return; // quals only
      const eid = m.event?.id;
      if (eid) { (matchesByEvent[eid] = matchesByEvent[eid] || []).push(m); }
    });
    const oprValues = [];
    Object.values(matchesByEvent).forEach(evMatches => {
      const opr = computeOPR(evMatches);
      // team.number matches t.team?.name in match data (both are team number strings)
      const entry = opr[team.number];
      if (entry?.opr != null && Number.isFinite(entry.opr)) oprValues.push(entry.opr);
    });
    const avgOPR = oprValues.length ? oprValues.reduce((a, b) => a + b, 0) / oprValues.length : null;

    const slot = {
      team,
      season,
      pid,
      sid,
      eventsPlayed: allEvents.length,
      rankings,
      skills,
      awards,
      worldEntry,
      avgOPR,
      allMatches,
    };

    // Place in first empty slot
    const idx = compareState.slots.findIndex(s => s === null);
    compareState.slots[idx] = slot;
    clearStatus('compare');
    renderCompareSearchRow();
    renderCompareContent();
  } catch (err) {
    setStatus('compare', `Error loading ${number}: ${err.message}`, 'error');
  }
}

function removeCompareSlot(idx) {
  compareState.slots[idx] = null;
  renderCompareSeasonPicker();
  renderCompareSearchRow();
  renderCompareContent();
}

function renderCompareContent() {
  const el = document.getElementById('compare-content');
  const slots = compareState.slots.filter(Boolean);
  if (!slots.length) {
    el.innerHTML = '<p class="empty compare-empty">Add a team above to start comparing.</p>';
    return;
  }

  // ── Per-slot derived stats
  const derived = compareState.slots.map((s, i) => {
    if (!s) return null;
    const { team, rankings, skills, awards, worldEntry, eventsPlayed, avgOPR, pid, sid } = s;

    const driver = skills.filter(x => x.type === 'driver');
    const prog   = skills.filter(x => x.type === 'programming');
    const bestDriver = driver.length ? Math.max(...driver.map(x => x.score)) : null;
    const bestProg   = prog.length   ? Math.max(...prog.map(x => x.score))   : null;
    const combined   = (bestDriver || 0) + (bestProg || 0);

    const wins   = rankings.reduce((a, r) => a + (r.wins   || 0), 0);
    const losses = rankings.reduce((a, r) => a + (r.losses || 0), 0);
    const ties   = rankings.reduce((a, r) => a + (r.ties   || 0), 0);
    const total  = wins + losses + ties;
    const winRate = total > 0 ? wins / total : null;
    const avgRank = rankings.length
      ? rankings.reduce((a, r) => a + (r.rank || 0), 0) / rankings.length
      : null;
    const bestRank = rankings.length ? Math.min(...rankings.map(r => r.rank)) : null;

    // Auton = average AP per match across all events
    const totalAP      = rankings.reduce((a, r) => a + (r.ap || 0), 0);
    const avgAPPerMatch = total > 0 ? totalAP / total : null;

    const worldRank = worldEntry?.rank ?? null;

    const rating = computeTeamTrueSkill(skills, rankings, awards, pid, sid);
    const awardsPerEvent = eventsPlayed > 0 ? awards.length / eventsPlayed : null;

    const excellenceCount = awards.filter(a => /excellence/i.test(a.title || '')).length;
    const championCount   = awards.filter(a => /champion/i.test(a.title || '')).length;

    return { i, team, eventsPlayed, bestDriver, bestProg, combined, wins, losses, ties, winRate,
      avgRank, bestRank, worldRank, rating, awards, awardsPerEvent, excellenceCount, championCount,
      avgOPR, avgAPPerMatch };
  });

  const active = derived.filter(Boolean);

  // Best-value helpers for highlighting
  function bestIdx(key, lower = false) {
    let best = null, bestVal = lower ? Infinity : -Infinity;
    active.forEach(d => {
      const v = d[key];
      if (v == null) return;
      if (lower ? v < bestVal : v > bestVal) { bestVal = v; best = d.i; }
    });
    return best;
  }

  const bestRating   = bestIdx('rating');
  const bestCombined   = bestIdx('combined');
  const bestWinRate    = bestIdx('winRate');
  const bestWorldRank  = bestIdx('worldRank', true);
  const bestRankIdx    = bestIdx('bestRank', true);
  const bestOPR        = bestIdx('avgOPR');
  const bestAuton      = bestIdx('avgAPPerMatch');
  const bestAwardsPerE = bestIdx('awardsPerEvent');

  // ── Radar charts (one per filled slot)
  const RADAR_AXES = ['Win Rate', 'Avg OPR', 'Avg Rank', 'Skills', 'Auton', 'Awards/Evt'];
  function radarNorm(key, lower = false) {
    const vals = active.map(d => d[key]).filter(v => v != null && v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    return d => {
      const v = d[key];
      if (v == null || max === 0) return 0;
      return lower ? Math.max(0, 1 - (v - Math.min(...vals)) / (max - Math.min(...vals) || 1))
                   : v / max;
    };
  }
  const normFns = [
    radarNorm('winRate'),
    radarNorm('avgOPR'),
    radarNorm('avgRank', true),   // lower rank # = better
    radarNorm('combined'),
    radarNorm('avgAPPerMatch'),
    radarNorm('awardsPerEvent'),
  ];

  const SLOT_COLORS = ['#E8854A', '#3B82F6', '#22C55E', '#A855F7'];

  function renderRadar(d, color) {
    const N = RADAR_AXES.length;
    const R = 70, CX = 90, CY = 85;
    const angle = i => (i / N) * 2 * Math.PI - Math.PI / 2;
    const pt = (r, i) => [CX + r * Math.cos(angle(i)), CY + r * Math.sin(angle(i))];

    // Grid rings
    let grid = '';
    for (let ring = 1; ring <= 4; ring++) {
      const r = (ring / 4) * R;
      const pts = Array.from({ length: N }, (_, i) => pt(r, i).join(',')).join(' ');
      grid += `<polygon points="${pts}" fill="none" stroke="var(--border)" stroke-width="0.7"/>`;
    }
    // Spokes + labels
    let spokes = '';
    RADAR_AXES.forEach((label, i) => {
      const [x1, y1] = pt(R, i);
      const [lx, ly] = pt(R + 14, i);
      spokes += `<line x1="${CX}" y1="${CY}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="var(--border)" stroke-width="0.8"/>`;
      spokes += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle" font-size="7" fill="var(--text-muted)">${label}</text>`;
    });
    // Data polygon
    const scores = normFns.map(fn => fn(d));
    const dataPts = scores.map((s, i) => pt(s * R, i).join(',')).join(' ');

    return `<svg viewBox="0 0 180 175" class="radar-svg">
      ${grid}${spokes}
      <polygon points="${dataPts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.5"/>
      ${scores.map((s, i) => { const [x, y] = pt(s * R, i); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}"/>`; }).join('')}
    </svg>`;
  }

  const radarCards = compareState.slots.map((s, i) => {
    if (!s) return '';
    const d = derived[i];
    return `<div class="cmp-radar-card">
      <div class="cmp-radar-label">${esc(d.team.number || d.team.name || '?')}</div>
      ${renderRadar(d, SLOT_COLORS[i])}
    </div>`;
  }).join('');

  // ── Team header cards
  const headers = compareState.slots.map((s, i) => {
    if (!s) return `<div class="cmp-col cmp-col-empty"><div class="cmp-slot-empty">—</div></div>`;
    const d = derived[i];
    const prog = s.season?.program?.name || '';
    return `
      <div class="cmp-col">
        <div class="cmp-team-header">
          <div class="cmp-team-num">${esc(d.team.number || d.team.name || '?')}</div>
          <div class="cmp-team-name">${esc(d.team.team_name || d.team.organization || '')}</div>
          <div class="cmp-team-meta">${esc(d.team.location?.city || d.team.city || '')}${d.team.location?.country || d.team.country ? ' · ' + esc(d.team.location?.country || d.team.country || '') : ''}</div>
          <div class="cmp-team-season">${esc(s.season.name)} · ${esc(prog)}</div>
          <button class="cmp-remove-btn" data-slot="${i}">✕ Remove</button>
        </div>
      </div>`;
  }).join('');

  // ── Stat rows
  function row(label, vals, unit = '') {
    const cells = compareState.slots.map((_, i) => {
      const d = derived[i];
      if (!d) return `<td class="cmp-cell cmp-empty">—</td>`;
      const v = vals(d);
      return `<td class="cmp-cell">${v != null ? v + unit : '—'}</td>`;
    }).join('');
    return `<tr><th class="cmp-row-label">${label}</th>${cells}</tr>`;
  }

  function rowHi(label, vals, bestSlot) {
    const cells = compareState.slots.map((_, i) => {
      const d = derived[i];
      if (!d) return `<td class="cmp-cell cmp-empty">—</td>`;
      const v = vals(d);
      const cls = (v != null && d.i === bestSlot) ? ' cmp-best' : '';
      return `<td class="cmp-cell${cls}">${v != null ? v : '—'}</td>`;
    }).join('');
    return `<tr><th class="cmp-row-label">${label}</th>${cells}</tr>`;
  }

  const tableRows = [
    rowHi('Rating',          d => d.rating != null ? d.rating.toFixed(2) + '<span class="cmp-unit">/10</span>' : null, bestRating),
    row('Season',            d => esc(d.team.grade || '')),
    row('Events Played',     d => d.eventsPlayed),
    rowHi('Best Rank',       d => d.bestRank != null ? '#' + d.bestRank : null,           bestRankIdx),
    rowHi('Avg Rank',        d => d.avgRank  != null ? '#' + d.avgRank.toFixed(1) : null, bestRankIdx),
    rowHi('Win Rate',        d => d.winRate  != null ? Math.round(d.winRate * 100) + '%' : null, bestWinRate),
    row('Record (W–L–T)',    d => `${d.wins}–${d.losses}–${d.ties}`),
    rowHi('Avg OPR',         d => d.avgOPR   != null ? d.avgOPR.toFixed(1) : null,        bestOPR),
    rowHi('Auton (AP/match)',d => d.avgAPPerMatch != null ? d.avgAPPerMatch.toFixed(2) : null, bestAuton),
    rowHi('World Skills',    d => d.worldRank != null ? '#' + d.worldRank : null,          bestWorldRank),
    rowHi('Combined Skills', d => d.combined > 0 ? d.combined : null,                     bestCombined),
    rowHi('Best Driver',     d => d.bestDriver,                                            bestIdx('bestDriver')),
    rowHi('Best Prog.',      d => d.bestProg,                                              bestIdx('bestProg')),
    rowHi('Awards/Event',    d => d.awardsPerEvent != null ? d.awardsPerEvent.toFixed(2) : null, bestAwardsPerE),
    row('Total Awards',      d => d.awards.length),
    row('Excellence',        d => d.excellenceCount || '—'),
    row('Championships',     d => d.championCount  || '—'),
  ].join('');

  const h2hHtml = active.length >= 2 ? renderHeadToHead(active) : '';

  el.innerHTML = `
    <div class="cmp-radar-row">${radarCards}</div>
    <div class="cmp-table-wrap">
      <table class="cmp-table">
        <thead>
          <tr>
            <th class="cmp-row-label"></th>
            ${compareState.slots.map(s =>
              s ? `<th class="cmp-col-head">${esc(s.team.number || s.team.name || '?')}</th>`
                : `<th class="cmp-col-head cmp-empty">Empty</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="cmp-cards-row">${headers}</div>
    ${h2hHtml}`;

  // Wire remove buttons
  el.querySelectorAll('.cmp-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeCompareSlot(+btn.dataset.slot));
  });

  // Wire team number header links
  el.querySelectorAll('.cmp-team-num[data-num]').forEach(btn => {
    btn.addEventListener('click', () => goToTeam(btn.dataset.num));
  });
}

function renderHeadToHead(active) {
  const slots = active.map(d => compareState.slots[d.i]).filter(s => s?.allMatches?.length);
  if (slots.length < 2) return '';
  const nums = slots.map(s => s.team.number);

  // Collect all matches across all slots, deduplicated by ID
  const matchPool = new Map();
  for (const s of slots) {
    for (const m of s.allMatches) {
      if (!matchPool.has(m.id)) matchPool.set(m.id, m);
    }
  }

  // Keep only matches where ≥2 compared teams appear
  const shared = [...matchPool.values()].filter(m => {
    const present = (m.alliances || []).flatMap(a => (a.teams || []).map(t => t.team?.name));
    return nums.filter(n => present.includes(n)).length >= 2;
  });

  const title = nums.length === 2
    ? `Head-to-Head: ${esc(nums[0])} vs ${esc(nums[1])}`
    : `Shared Matches — ${nums.join(', ')}`;

  if (!shared.length) return `
    <div class="stats-section">
      <div class="section-title">${title}</div>
      <p class="empty">No matches found where 2 or more of these teams appeared together this season.</p>
    </div>`;

  shared.sort((a, b) =>
    (a.event?.name || '').localeCompare(b.event?.name || '') ||
    (a.round - b.round) || (a.matchnum - b.matchnum)
  );

  // Pairwise W/L tracker: key = sorted "numA|numB"
  const pairKey = (a, b) => [a, b].sort().join('|');
  const pairs = {};
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const k = pairKey(nums[i], nums[j]);
      pairs[k] = { numA: [nums[i], nums[j]].sort()[0], numB: [nums[i], nums[j]].sort()[1], wA: 0, wB: 0, ties: 0 };
    }
  }

  // Build match table rows
  const rows = shared.map(m => {
    const alliances = m.alliances || [];
    const scored = matchIsScored(m);
    const teamAl = {};
    for (const a of alliances) {
      for (const t of (a.teams || [])) {
        if (t.team?.name) teamAl[t.team.name] = a;
      }
    }

    // Per-team outcome cells
    const teamCells = nums.map(num => {
      const al = teamAl[num];
      if (!al) return `<td class="h2h-absent">—</td>`;
      const oppAl = alliances.find(a => a.color !== al.color);
      const dot = al.color === 'red' ? '<span class="h2h-dot-red">●</span>' : '<span class="h2h-dot-blue">●</span>';
      if (!scored || !oppAl) return `<td>${dot}</td>`;
      const mine = al.score, opp = oppAl.score;
      if (mine > opp)  return `<td class="h2h-win">${dot} W</td>`;
      if (mine < opp)  return `<td class="h2h-loss">${dot} L</td>`;
      return `<td class="h2h-tie">${dot} T</td>`;
    });

    // Update pairwise records for opposing teams that both appeared
    if (scored) {
      const present = nums.filter(n => teamAl[n]);
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          const nA = present[i], nB = present[j];
          const alA = teamAl[nA], alB = teamAl[nB];
          if (!alA || !alB || alA.color === alB.color) continue;
          const k = pairKey(nA, nB);
          const rec = pairs[k];
          const sA = alA.score, sB = alB.score;
          const aIsFirst = rec.numA === nA;
          if (sA > sB) { aIsFirst ? rec.wA++ : rec.wB++; }
          else if (sA < sB) { aIsFirst ? rec.wB++ : rec.wA++; }
          else { rec.ties++; }
        }
      }
    }

    const redAl  = alliances.find(a => a.color === 'red');
    const blueAl = alliances.find(a => a.color === 'blue');
    const scoreStr = scored
      ? `<span class="h2h-score-red">${redAl?.score ?? '?'}</span>–<span class="h2h-score-blue">${blueAl?.score ?? '?'}</span>`
      : '—';

    return `<tr>
      <td class="h2h-event-cell">${esc(m.event?.name || '—')}</td>
      <td class="h2h-match-cell">${esc(ROUND_NAMES[m.round] || 'Round')} ${m.round === 2 ? m.matchnum : ''}</td>
      <td class="h2h-score-cell">${scoreStr}</td>
      ${teamCells.join('')}
    </tr>`;
  }).join('');

  // Pairwise rivalry cards
  const pairCards = Object.values(pairs).map(p => {
    const total = p.wA + p.wB + p.ties;
    if (!total) return '';
    const pA = (p.wA / total * 100).toFixed(1);
    const pT = (p.ties / total * 100).toFixed(1);
    const pB = (p.wB / total * 100).toFixed(1);
    return `
      <div class="h2h-pair-card">
        <div class="h2h-pair-header">
          <span class="h2h-pair-num">${esc(p.numA)}</span>
          <span class="h2h-pair-sep">vs</span>
          <span class="h2h-pair-num">${esc(p.numB)}</span>
        </div>
        <div class="h2h-bar-wrap">
          <span class="h2h-bar-label">${p.wA}W</span>
          <div class="h2h-bar">
            <div class="h2h-bar-a" style="width:${pA}%"></div>
            <div class="h2h-bar-t" style="width:${pT}%"></div>
            <div class="h2h-bar-b" style="width:${pB}%"></div>
          </div>
          <span class="h2h-bar-label">${p.wB}W</span>
        </div>
        <div class="h2h-pair-sub">${p.ties ? p.ties + 'T · ' : ''}${total} match${total > 1 ? 'es' : ''}</div>
      </div>`;
  }).filter(Boolean).join('');

  return `
    <div class="stats-section">
      <div class="section-title">${title}</div>
      ${pairCards ? `<div class="h2h-pair-grid">${pairCards}</div>` : ''}
      <div class="table-wrap"><table class="h2h-table">
        <thead><tr>
          <th>Event</th><th>Match</th><th>Score</th>
          ${nums.map(n => `<th>${esc(n)}</th>`).join('')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="h2h-legend">● red/blue = alliance &nbsp;·&nbsp; W/L/T = outcome &nbsp;·&nbsp; — = not in match</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE SCORES VIEW
// ═══════════════════════════════════════════════════════════════════════════

let liveState = {
  timer: null,         // setInterval handle
  seenMatchIds: new Set(),
  programId: 1,
  feed: [],            // { evName, evId, match, ts }
};

async function openLiveView() {
  showView('view-live');
  renderLiveControls();
  await refreshLiveFeed(true);
  // Start polling every 60s; clear any prior interval
  if (liveState.timer) clearInterval(liveState.timer);
  liveState.timer = setInterval(() => refreshLiveFeed(false), 60000);
}

function renderLiveControls() {
  const el = document.getElementById('live-controls');
  if (!el) return;
  el.innerHTML = `
    <div class="live-controls-row">
      <select id="live-prog-select" class="season-select">
        <option value="1">V5RC (VRC)</option>
        <option value="41">VIQRC</option>
        <option value="4">VEXU</option>
      </select>
      <button class="btn-secondary" id="live-refresh-btn">↻ Refresh now</button>
      <span class="live-pulse" id="live-pulse"></span>
    </div>`;
  const sel = el.querySelector('#live-prog-select');
  sel.value = String(liveState.programId);
  sel.addEventListener('change', async () => {
    liveState.programId = +sel.value;
    liveState.seenMatchIds = new Set();
    liveState.feed = [];
    await refreshLiveFeed(true);
  });
  el.querySelector('#live-refresh-btn').addEventListener('click', () => refreshLiveFeed(false));
}

async function refreshLiveFeed(initial) {
  const feedEl = document.getElementById('live-feed');
  const pulse  = document.getElementById('live-pulse');
  if (!feedEl) return;

  if (initial) {
    setStatus('live', 'Finding ongoing events…');
    feedEl.innerHTML = '';
  }
  if (pulse) { pulse.textContent = 'Refreshing…'; pulse.classList.add('active'); }

  try {
    const pid = liveState.programId;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    // Fetch events happening today (start <= today <= end)
    const evData = await apiFetch(
      `/events?program[]=${pid}&start=${dateStr}&end=${dateStr}&per_page=250&page=1`
    );
    const events = evData.data || [];

    if (initial && !events.length) {
      clearStatus('live');
      feedEl.innerHTML = '<p class="empty">No events found happening today. Try a different program.</p>';
      if (pulse) { pulse.textContent = ''; pulse.classList.remove('active'); }
      return;
    }

    // For each event fetch recent matches (capped at 3 concurrent to avoid rate-limit)
    const newMatches = [];
    const tasks = events.map(ev => async () => {
      try {
        const divs = await apiFetch(`/events/${ev.id}/divisions?per_page=10`);
        const divList = divs.data || [];
        for (const div of divList) {
          const mData = await apiFetch(`/events/${ev.id}/divisions/${div.id}/matches?per_page=50&page=1`);
          for (const m of (mData.data || [])) {
            if (!matchIsScored(m)) continue;
            if (liveState.seenMatchIds.has(m.id)) continue;
            liveState.seenMatchIds.add(m.id);
            newMatches.push({ evName: ev.name, evId: ev.id, evSku: ev.sku, match: m, ts: Date.now() });
          }
        }
      } catch (_) {}
    });
    await promisePool(tasks, 3);

    if (newMatches.length) {
      // Newest first within each batch
      newMatches.sort((a, b) => (b.match.matchnum - a.match.matchnum));
      liveState.feed = [...newMatches, ...liveState.feed].slice(0, 200);
    }

    clearStatus('live');
    renderLiveFeed(feedEl, events.length, initial && !liveState.feed.length);

  } catch (err) {
    setStatus('live', `Error: ${err.message}`, 'error');
  }

  if (pulse) {
    pulse.textContent = 'Updated ' + new Date().toLocaleTimeString();
    pulse.classList.remove('active');
  }
}

function renderLiveFeed(feedEl, eventCount, noData) {
  if (noData || !liveState.feed.length) {
    feedEl.innerHTML = `<p class="empty">No scored matches found yet across ${eventCount} event(s) today. Checking again in 60s.</p>`;
    return;
  }

  // Group by event
  const byEvent = {};
  for (const entry of liveState.feed) {
    if (!byEvent[entry.evId]) byEvent[entry.evId] = { name: entry.evName, sku: entry.evSku, id: entry.evId, matches: [] };
    byEvent[entry.evId].matches.push(entry);
  }

  feedEl.innerHTML = Object.values(byEvent).map(ev => {
    const rows = ev.matches.map(entry => {
      const m = entry.match;
      const alliances = m.alliances || [];
      const red  = alliances.find(a => a.color === 'red');
      const blue = alliances.find(a => a.color === 'blue');
      const redTeams  = (red?.teams  || []).map(t => t.team?.name).filter(Boolean).join(' / ');
      const blueTeams = (blue?.teams || []).map(t => t.team?.name).filter(Boolean).join(' / ');
      const redWon  = red?.score  > blue?.score;
      const blueWon = blue?.score > red?.score;
      const roundLabel = ROUND_NAMES[m.round] || 'Match';
      const matchLabel = m.round === 2 ? `Q${m.matchnum}` : roundLabel;
      return `<tr class="live-match-row">
        <td class="live-match-label">${esc(matchLabel)}</td>
        <td class="live-alliance live-red ${redWon ? 'live-winner' : ''}">
          <span class="live-teams">${esc(redTeams)}</span>
          <span class="live-score">${red?.score ?? '?'}</span>
        </td>
        <td class="live-vs">vs</td>
        <td class="live-alliance live-blue ${blueWon ? 'live-winner' : ''}">
          <span class="live-score">${blue?.score ?? '?'}</span>
          <span class="live-teams">${esc(blueTeams)}</span>
        </td>
        <td class="live-age">${timeAgo(entry.ts)}</td>
      </tr>`;
    }).join('');

    return `
      <div class="live-event-block">
        <div class="live-event-name">
          <button class="live-event-link" data-eid="${ev.id}">${esc(ev.name)}</button>
        </div>
        <div class="table-wrap">
          <table class="live-table">
            <thead><tr>
              <th>Match</th>
              <th class="live-red-head">Red</th>
              <th></th>
              <th class="live-blue-head">Blue</th>
              <th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  // Wire event links
  feedEl.querySelectorAll('.live-event-link[data-eid]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const evData = await apiFetch(`/events/${btn.dataset.eid}`);
        const ev = evData.data?.[0] || evData;
        if (ev?.id) openEventDetail(ev);
      } catch (_) {}
    });
  });
}

// Stop polling when leaving the live view
function stopLivePolling() {
  if (liveState.timer) { clearInterval(liveState.timer); liveState.timer = null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// HEAD TO HEAD PREDICTOR
// ═══════════════════════════════════════════════════════════════════════════

let h2hState     = { red: [null, null], blue: [null, null] };
let h2hTeamData  = {}; // name → { name, opr, ccwm, dpr, winRate, skillsCombined, source, timeline[] }
let h2hSeason    = { programId: 1, seasonId: null, seasons: [] };
let h2hSliderPos = null; // null = max (full season); number = event index cutoff

async function openH2HView() {
  showView('view-h2h');
  // Init season list on first open
  if (!h2hSeason.seasons.length) {
    await loadH2HSeasons(h2hSeason.programId);
  }
  renderH2HPanel();
}

async function loadH2HSeasons(programId) {
  const list = await fetchProgramSeasons(programId);
  h2hSeason.programId = programId;
  h2hSeason.seasons   = list;
  h2hSeason.seasonId  = list[0]?.id || null;
}

async function fetchH2HTeamData(teamNum) {
  const key = teamNum.toUpperCase().trim();

  // If an event is loaded and this team is in it, use live event data (no timeline)
  const eventName = Object.keys(cachedOPR).find(n =>
    n.toUpperCase() === key || n.replace(/\s+/g,'').toUpperCase() === key.replace(/\s+/g,'')
  );
  if (eventName && currentEvent) {
    const opr  = cachedOPR[eventName] || {};
    const rank = cachedEventRankings[eventName] || {};
    const sk   = cachedEventSkills[eventName] || {};
    return {
      name: eventName, source: 'event', timeline: [],
      opr: opr.opr || 0, ccwm: opr.ccwm || 0, dpr: opr.dpr || 0,
      winRate: rank.winRate ?? 0.5, skillsCombined: sk.combined || 0,
      wins: rank.wins || 0, losses: rank.losses || 0, ties: rank.ties || 0,
    };
  }

  const json = await apiFetch(`/teams?number[]=${encodeURIComponent(teamNum)}&myTeams=false`);
  const team = json.data?.[0];
  if (!team) return null;
  // Always use team.number as the key — it matches t.team.name inside match alliance data.
  // team.name on the /teams endpoint may be the org name (e.g. "BLRS"), not the number.
  const teamKey = team.number || teamNum;

  // Resolve season: prefer the user-selected season when the program matches,
  // otherwise fall back to auto-detecting from the team's own events.
  const teamProgId = team.program?.id;
  let sid = (teamProgId && teamProgId !== h2hSeason.programId) ? null : h2hSeason.seasonId;

  const autoDetectSid = async () => {
    const evs = await fetchAllPages(`/teams/${team.id}/events`);
    const byS = {};
    evs.forEach(e => { if (e.season?.id) byS[e.season.id] = e.season; });
    return Object.values(byS).sort((a, b) => b.id - a.id)[0]?.id || null;
  };

  if (!sid) sid = await autoDetectSid();
  if (!sid) return { name: teamKey, source: 'season', timeline: [], opr: 0, ccwm: 0, dpr: 0, winRate: 0.5, skillsCombined: 0, wins: 0, losses: 0, ties: 0 };

  let [allMatches, rankings, skills, teamEvents] = await Promise.all([
    fetchAllPages(`/teams/${team.id}/matches?season[]=${sid}`),
    fetchAllPages(`/teams/${team.id}/rankings?season[]=${sid}`),
    fetchAllPages(`/teams/${team.id}/skills?season[]=${sid}`),
    fetchAllPages(`/teams/${team.id}/events?season[]=${sid}`),
  ]);

  // If we got no qual matches with the selected season, auto-detect and retry once.
  if (!allMatches.some(m => m.round === 2) && sid === h2hSeason.seasonId) {
    const autoSid = await autoDetectSid();
    if (autoSid && autoSid !== sid) {
      sid = autoSid;
      [allMatches, rankings, skills, teamEvents] = await Promise.all([
        fetchAllPages(`/teams/${team.id}/matches?season[]=${sid}`),
        fetchAllPages(`/teams/${team.id}/rankings?season[]=${sid}`),
        fetchAllPages(`/teams/${team.id}/skills?season[]=${sid}`),
        fetchAllPages(`/teams/${team.id}/events?season[]=${sid}`),
      ]);
    }
  }

  // Group by event ID
  const matchesByEvent = {};
  allMatches.forEach(m => {
    if (m.round !== 2) return;
    const eid = m.event?.id;
    if (eid) (matchesByEvent[eid] = matchesByEvent[eid] || []).push(m);
  });
  const rankByEvent = {};
  rankings.forEach(r => { if (r.event?.id) rankByEvent[r.event.id] = r; });
  const skillsByEvent = {};
  skills.forEach(s => {
    const eid = s.event?.id; if (!eid) return;
    if (!skillsByEvent[eid]) skillsByEvent[eid] = { driver: 0, prog: 0 };
    if (s.type === 'driver')      skillsByEvent[eid].driver = Math.max(skillsByEvent[eid].driver, s.score || 0);
    else if (s.type === 'programming') skillsByEvent[eid].prog = Math.max(skillsByEvent[eid].prog, s.score || 0);
  });

  // Sort events chronologically; fall back to events without start date at the end
  const sortedEvents = teamEvents
    .filter(e => e.id)
    .sort((a, b) => {
      if (a.start && b.start) return new Date(a.start) - new Date(b.start);
      if (a.start) return -1;
      if (b.start) return 1;
      return 0;
    });

  // Compute per-team score contribution for a set of matches.
  // Uses direct average-score approach (always works; more robust than OPR system solve).
  function computeScoreContrib(evMs) {
    const scored = evMs.filter(m => matchIsScored(m));
    if (!scored.length) return { opr: 0, ccwm: 0 };
    let ownTotal = 0, oppTotal = 0, n = 0;
    for (const m of scored) {
      const als = m.alliances || [];
      const myA = als.find(a =>
        (a.teams || []).some(t => t.team?.name === teamKey)
      );
      if (!myA || myA.score == null) continue;
      const oppA = als.find(a => a !== myA);
      // Divide by number of present teammates to get per-player contribution
      const sz = Math.max(1, (myA.teams || []).filter(t => t.team?.name).length);
      ownTotal += myA.score / sz;
      if (oppA?.score != null) oppTotal += oppA.score / sz;
      n++;
    }
    if (!n) return { opr: 0, ccwm: 0 };
    return { opr: ownTotal / n, ccwm: (ownTotal - oppTotal) / n };
  }

  // Build timeline
  const timeline = [];
  let cumW = 0, cumL = 0, cumT = 0, bestDriver = 0, bestProg = 0;
  for (const ev of sortedEvents) {
    const eid  = ev.id;
    const evMs = matchesByEvent[eid] || [];
    const evR  = rankByEvent[eid];
    const evSk = skillsByEvent[eid] || { driver: 0, prog: 0 };

    const { opr, ccwm } = computeScoreContrib(evMs);

    const eW = evR?.wins || 0, eL = evR?.losses || 0, eT = evR?.ties || 0;
    cumW += eW; cumL += eL; cumT += eT;
    bestDriver = Math.max(bestDriver, evSk.driver);
    bestProg   = Math.max(bestProg, evSk.prog);

    const cumTotal = cumW + cumL + cumT;
    const shortDate = ev.start ? ev.start.slice(0, 10) : '';
    timeline.push({
      eventId: eid,
      eventName: ev.name || `Event ${timeline.length + 1}`,
      date: shortDate,
      opr, ccwm, dpr: Math.max(0, opr - ccwm),
      wins: eW, losses: eL, ties: eT,
      skillsCombined: evSk.driver + evSk.prog,
      cumWins: cumW, cumLosses: cumL, cumTies: cumT,
      cumWinRate: cumTotal > 0 ? cumW / cumTotal : null,
    });
  }

  // Full-season averages from events that had real match data
  const validEntries = timeline.filter(t => t.opr > 0);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const cumTotal = cumW + cumL + cumT;

  // Weight recent events more (last 3 events carry double weight for current form)
  const recentN = Math.min(3, validEntries.length);
  const recentEntries = validEntries.slice(-recentN);
  const olderEntries  = validEntries.slice(0, validEntries.length - recentN);
  const weightedOPR  = (avg(recentEntries.map(t => t.opr))  * 2 * recentN
                      + avg(olderEntries.map(t => t.opr))   * olderEntries.length)
                     / Math.max(1, 2 * recentN + olderEntries.length);
  const weightedCCWM = (avg(recentEntries.map(t => t.ccwm)) * 2 * recentN
                      + avg(olderEntries.map(t => t.ccwm))  * olderEntries.length)
                     / Math.max(1, 2 * recentN + olderEntries.length);

  return {
    name: teamKey, source: 'season', timeline,
    opr:  validEntries.length ? weightedOPR : 0,
    ccwm: validEntries.length ? weightedCCWM : 0,
    dpr:  Math.max(0, (validEntries.length ? weightedOPR - weightedCCWM : 0)),
    winRate: cumTotal > 0 ? cumW / cumTotal : 0.5,
    skillsCombined: bestDriver + bestProg,
    wins: cumW, losses: cumL, ties: cumT,
  };
}

// Return stats for a team at a specific event-index cutoff (1-based).
function h2hDataAtPos(name, pos) {
  const d = h2hTeamData[name];
  if (!d) return null;
  if (!d.timeline || !d.timeline.length) return d;

  const events = d.timeline.slice(0, Math.max(1, pos));
  const validOPRs = events.filter(e => e.opr > 0);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgOPR  = avg(validOPRs.map(e => e.opr));
  const avgCCWM = avg(validOPRs.map(e => e.ccwm));
  const last = events[events.length - 1];
  const cumTotal = last.cumWins + last.cumLosses + last.cumTies;

  return {
    ...d,
    opr:  avgOPR,
    ccwm: avgCCWM,
    dpr:  Math.max(0, avgOPR - avgCCWM),
    winRate: cumTotal > 0 ? last.cumWins / cumTotal : 0.5,
    skillsCombined: events.reduce((m, e) => Math.max(m, e.skillsCombined), 0),
    wins: last.cumWins, losses: last.cumLosses, ties: last.cumTies,
  };
}

// Max events across all loaded teams (for slider range).
function h2hMaxPos() {
  return Math.max(1, ...Object.values(h2hTeamData).map(d => d.timeline?.length || 0));
}

// Current effective slider position (default = max).
function h2hEffectivePos() {
  const max = h2hMaxPos();
  return h2hSliderPos === null ? max : Math.min(h2hSliderPos, max);
}

// Inline SVG sparkline for a stat key over a team's timeline.
function renderSparkline(timeline, key, currentPos, w = 90, h = 28) {
  if (!timeline || timeline.length < 2) return '';
  const vals = timeline.map(t => t[key] ?? null);
  const valid = vals.filter(v => v != null && v > 0);
  if (!valid.length) return '';

  const minV = Math.min(...valid) * 0.88;
  const maxV = Math.max(...valid) * 1.08;
  const range = maxV - minV || 1;
  const pad = 3;

  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = v != null ? pad + (1 - (v - minV) / range) * (h - pad * 2) : null;
    return { x, y };
  }).filter(p => p.y != null);

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const currIdx = Math.min(currentPos - 1, timeline.length - 1);
  const currPt  = pts[currIdx] || pts[pts.length - 1];

  // Area fill
  const areaPath = `${path} L${pts[pts.length - 1].x.toFixed(1)},${(h - pad).toFixed(1)} L${pts[0].x.toFixed(1)},${(h - pad).toFixed(1)} Z`;

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="h2h-spark">
    <defs>
      <linearGradient id="sg-${name}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#sg-${name})" />
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
    ${currIdx < pts.length - 1
      ? `<circle cx="${pts[pts.length-1].x.toFixed(1)}" cy="${pts[pts.length-1].y.toFixed(1)}" r="2" fill="var(--text-muted)" opacity="0.35"/>`
      : ''}
    <circle cx="${currPt.x.toFixed(1)}" cy="${currPt.y.toFixed(1)}" r="3.5"
            fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>
  </svg>`;
}

// Build a normalized stat cache for exactly the given team names using h2hTeamData.
// pos = slider position (1-based); null/undefined = full season.
function buildH2HMiniCache(names, pos) {
  const raw = {};
  for (const name of names) {
    if (!name) continue;
    const ev = cachedOPR[name];
    if (ev) {
      const rank = cachedEventRankings[name] || {};
      const sk   = cachedEventSkills[name] || {};
      raw[name] = {
        opr:    ev.opr || 0,
        ccwm:   ev.ccwm || 0,
        dpr:    ev.dpr || 0,
        wr:     rank.winRate ?? 0.5,
        skills: sk.combined || 0,
        form:   ev.opr || 0,
        consist: 0.5,
      };
    } else {
      const d = (pos != null && h2hTeamData[name]?.timeline?.length)
        ? h2hDataAtPos(name, pos)
        : h2hTeamData[name];
      if (!d) continue;
      raw[name] = {
        opr:    d.opr || 0,
        ccwm:   d.ccwm || 0,
        dpr:    d.dpr || 0,
        wr:     d.winRate ?? 0.5,
        skills: d.skillsCombined || 0,
        form:   d.opr || 0,
        consist: 0.5,
      };
    }
  }

  const keys = Object.keys(raw);
  if (!keys.length) return {};

  // Min-max normalize within these teams
  const dims = ['opr', 'ccwm', 'dpr', 'skills', 'form'];
  const mm = {};
  for (const dim of dims) {
    const vals = keys.map(n => raw[n][dim]).filter(isFinite);
    mm[dim] = { min: Math.min(...vals), max: Math.max(...vals) };
  }

  const cache = {};
  for (const name of keys) {
    const r = raw[name];
    const n01 = (dim, invert = false) => {
      const { min, max } = mm[dim];
      const v = max > min ? (r[dim] - min) / (max - min) : 0.5;
      return invert ? 1 - v : v;
    };
    cache[name] = {
      opr_n:    n01('opr'),
      ccwm_n:   n01('ccwm'),
      dpr_n:    n01('dpr', true),
      wr:       Math.max(0, Math.min(1, r.wr)),
      skills_n: n01('skills'),
      form_n:   n01('form'),
      consist_n: 0.5,
    };
  }
  return cache;
}

// Predict a H2H match using current predTuning weights.
// Merges event cache (if available) with the H2H mini-cache, slider-position-aware.
function predictH2H(redSlots, blueSlots) {
  const redNames  = redSlots.filter(Boolean);
  const blueNames = blueSlots.filter(Boolean);
  if (!redNames.length || !blueNames.length) return null;

  const allNames = [...redNames, ...blueNames];
  const pos = h2hEffectivePos();

  const eventCache = getPredStatCache();
  const miniCache  = buildH2HMiniCache(allNames, pos);
  const combined   = {};
  for (const name of allNames) {
    combined[name] = eventCache[name] || miniCache[name] || null;
  }

  const ALLIANCE_SIZE = 2; // standard VEX alliance size
  const getOPR = name => {
    const d = h2hTeamData[name]?.timeline?.length
      ? h2hDataAtPos(name, pos)
      : h2hTeamData[name];
    if (d && d.opr > 0) return d.opr;
    return effectiveOPR(name);
  };
  // Sum OPRs; scale to full alliance size if fewer teams added
  const rawRed  = redNames.reduce((s, n) => s + getOPR(n), 0);
  const rawBlue = blueNames.reduce((s, n) => s + getOPR(n), 0);
  const oprRed  = rawRed  * (ALLIANCE_SIZE / Math.max(1, redNames.length));
  const oprBlue = rawBlue * (ALLIANCE_SIZE / Math.max(1, blueNames.length));

  // Multi-stat strength for win direction + confidence
  const strRed  = redNames.reduce((s, n)  => s + teamStrength(n, combined), 0);
  const strBlue = blueNames.reduce((s, n) => s + teamStrength(n, combined), 0);
  const total   = strRed + strBlue;

  if (total <= 0) {
    const winner = oprRed > oprBlue ? 'red' : oprBlue > oprRed ? 'blue' : 'tie';
    return { redScore: Math.max(0, Math.round(oprRed)), blueScore: Math.max(0, Math.round(oprBlue)), winner, confidence: 55 };
  }

  const diff  = Math.abs(strRed - strBlue);
  const ts    = predTuning.tanhScale > 0 ? predTuning.tanhScale : 0.22;
  const noise = Math.max(0, Math.min(0.5, predTuning.noise ?? 0.05));
  const baseProb = 0.5 + 0.45 * Math.tanh(diff / (total * ts));
  const adjProb  = (1 - noise) * baseProb + noise * 0.5;
  const confidence = Math.min(87, Math.round(adjProb * 100));

  return {
    redScore:  Math.max(0, Math.round(oprRed)),
    blueScore: Math.max(0, Math.round(oprBlue)),
    winner:    strRed > strBlue ? 'red' : strBlue > strRed ? 'blue' : 'tie',
    confidence,
  };
}

function renderH2HTeamCard(alliance, idx, data) {
  if (!data) return '';
  const pos = h2hEffectivePos();
  const hasTimeline = data.timeline?.length >= 2;
  const statsNow = hasTimeline ? h2hDataAtPos(data.name, pos) : data;
  const isSliding = hasTimeline && h2hSliderPos != null && h2hSliderPos < data.timeline.length;

  const fmt = (v, digits = 1) => (v != null && v > 0) ? (+v).toFixed(digits) : '—';
  const opr   = fmt(statsNow.opr);
  const ccwm  = statsNow.ccwm != null && (statsNow.ccwm !== 0 || statsNow.opr > 0) ? (+statsNow.ccwm).toFixed(1) : '—';
  const wr    = statsNow.winRate != null ? Math.round(statsNow.winRate * 100) + '%' : '—';
  const sk    = statsNow.skillsCombined > 0 ? statsNow.skillsCombined : '—';
  const wlt   = statsNow.wins + statsNow.losses + statsNow.ties > 0
    ? `${statsNow.wins}W-${statsNow.losses}L-${statsNow.ties}T` : '—';
  const src   = data.source === 'event' ? 'event data' : 'season data';

  const delta = (cur, full) => {
    if (!isSliding) return '';
    const c = parseFloat(cur), f = parseFloat(full);
    if (!isFinite(c) || !isFinite(f) || Math.abs(c - f) < 0.05) return '';
    const diff = c - f;
    return `<span class="h2h-delta ${diff > 0 ? 'h2h-delta-pos' : 'h2h-delta-neg'}">${diff > 0 ? '+' : ''}${diff.toFixed(1)}</span>`;
  };

  const oprSpark = hasTimeline ? renderSparkline(data.timeline, 'opr',        pos, 80, 26) : '';
  const wrSpark  = hasTimeline ? renderSparkline(data.timeline, 'cumWinRate',  pos, 80, 26) : '';

  return `
    <div class="h2h-team-card h2h-card-${alliance}">
      <div class="h2h-card-header">
        <span class="h2h-card-name">${data.name}</span>
        <span class="h2h-card-src">${src}</span>
        <button class="h2h-remove-btn" data-alliance="${alliance}" data-idx="${idx}" title="Remove">✕</button>
      </div>
      <div class="h2h-stats-grid">
        <div class="h2h-stat">
          <span class="h2h-stat-val">${opr}${delta(opr, fmt(data.opr))}</span>
          <span class="h2h-stat-lbl">OPR</span>
          ${oprSpark ? `<div class="h2h-spark-wrap">${oprSpark}</div>` : ''}
        </div>
        <div class="h2h-stat">
          <span class="h2h-stat-val">${ccwm}${delta(ccwm, fmt(data.ccwm))}</span>
          <span class="h2h-stat-lbl">CCWM</span>
          ${wrSpark ? `<div class="h2h-spark-wrap">${wrSpark}</div>` : ''}
        </div>
        <div class="h2h-stat"><span class="h2h-stat-val">${wr}</span><span class="h2h-stat-lbl">Win %</span></div>
        <div class="h2h-stat"><span class="h2h-stat-val">${sk}</span><span class="h2h-stat-lbl">Skills</span></div>
        <div class="h2h-stat h2h-stat-wide"><span class="h2h-stat-val">${wlt}</span><span class="h2h-stat-lbl">W-L-T</span></div>
      </div>
    </div>`;
}

function renderH2HAddSlot(alliance, idx) {
  return `
    <div class="h2h-add-slot" id="h2h-slot-${alliance}-${idx}">
      <input type="text" class="h2h-input" id="h2h-input-${alliance}-${idx}"
        placeholder="Team number…" autocomplete="off" />
      <button class="btn-primary h2h-add-btn" data-alliance="${alliance}" data-idx="${idx}">Add</button>
    </div>`;
}

function renderH2HPredSection() {
  const pred = predictH2H(h2hState.red, h2hState.blue);
  if (!pred) return `<div class="h2h-pred-placeholder">Add at least one team to each alliance to predict.</div>`;

  const isTie    = pred.winner === 'tie';
  const redWin   = pred.winner === 'red';
  const redBarPct = redWin ? pred.confidence : (isTie ? 50 : 100 - pred.confidence);
  const confClass = pred.confidence >= 70 ? 'h2h-conf-high' : pred.confidence >= 60 ? 'h2h-conf-mid' : 'h2h-conf-low';
  const winnerLabel = isTie ? '⚖ Toss-up' : (redWin ? '🔴 Red favored' : '🔵 Blue favored');

  return `
    <div class="h2h-pred-section">
      <div class="h2h-pred-label">Match Prediction</div>
      <div class="h2h-scores-row">
        <div class="h2h-score-box h2h-score-red${redWin ? ' h2h-score-winner' : ''}">${pred.redScore}</div>
        <div class="h2h-score-vs">—</div>
        <div class="h2h-score-box h2h-score-blue${pred.winner === 'blue' ? ' h2h-score-winner' : ''}">${pred.blueScore}</div>
      </div>
      <div class="h2h-bar-row">
        <span class="h2h-bar-side h2h-bar-side-red">Red ${redBarPct}%</span>
        <div class="h2h-win-bar">
          <div class="h2h-win-fill-red" style="width:${redBarPct}%"></div>
          <div class="h2h-win-fill-blue" style="width:${100 - redBarPct}%"></div>
        </div>
        <span class="h2h-bar-side h2h-bar-side-blue">${100 - redBarPct}% Blue</span>
      </div>
      <div class="h2h-pred-footer">
        <span class="${confClass}">Confidence: ${pred.confidence}%</span>
        <span class="h2h-winner-label">${winnerLabel}</span>
      </div>
    </div>`;
}

function getH2HTimelineLabel(pos) {
  const max = h2hMaxPos();
  if (pos >= max) return 'Full season';
  for (const d of Object.values(h2hTeamData)) {
    const ev = d.timeline?.[pos - 1];
    if (ev?.eventName) {
      const short = ev.eventName.length > 30 ? ev.eventName.slice(0, 30) + '…' : ev.eventName;
      const dateStr = ev.date ? ` · ${ev.date.slice(5, 10)}` : '';
      return `Through: ${short}${dateStr}`;
    }
  }
  return `Event ${pos} of ${max}`;
}

function renderH2HTimeline() {
  const max = h2hMaxPos();
  if (max <= 1) return '';
  const pos = h2hEffectivePos();
  return `
    <div class="h2h-timeline-section">
      <div class="h2h-timeline-header">
        <span class="h2h-timeline-title">Season Timeline</span>
        <span class="h2h-timeline-pos" id="h2h-timeline-pos">${getH2HTimelineLabel(pos)}</span>
      </div>
      <div class="h2h-timeline-row">
        <span class="h2h-timeline-end">Ev 1</span>
        <input type="range" id="h2h-slider" class="h2h-slider"
               min="1" max="${max}" value="${pos}" step="1" />
        <span class="h2h-timeline-end">Full ▶</span>
      </div>
    </div>`;
}

function renderH2HSeasonPicker() {
  const programs = [{ id: 1, label: 'V5RC' }, { id: 4, label: 'VEXU' }, { id: 41, label: 'VIQRC' }];
  const progOpts = programs.map(p =>
    `<option value="${p.id}"${p.id === h2hSeason.programId ? ' selected' : ''}>${p.label}</option>`
  ).join('');
  const seasonOpts = h2hSeason.seasons.map(s =>
    `<option value="${s.id}"${s.id === h2hSeason.seasonId ? ' selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  return `
    <div class="h2h-season-row">
      <label class="h2h-season-label">Program</label>
      <select class="season-picker-sel" id="h2h-prog-sel">${progOpts}</select>
      <label class="h2h-season-label">Season</label>
      <select class="season-picker-sel" id="h2h-season-sel">${seasonOpts || '<option>Loading…</option>'}</select>
      <span class="h2h-season-note">Teams added above will use this season's data.</span>
    </div>`;
}

function renderH2HAllianceBlock(alliance) {
  const title = alliance === 'red' ? '🔴 Red Alliance' : '🔵 Blue Alliance';
  let slots = '';
  for (let i = 0; i < 2; i++) {
    const name = h2hState[alliance][i];
    const data = name ? h2hTeamData[name] : null;
    if (name && data) slots += renderH2HTeamCard(alliance, i, data);
    else if (!name)   slots += renderH2HAddSlot(alliance, i);
  }
  return `<div class="h2h-alliance h2h-alliance-${alliance}"><div class="h2h-alliance-title">${title}</div>${slots}</div>`;
}

function renderH2HMainContent() {
  return `
    ${renderH2HAllianceBlock('red')}
    <div class="h2h-center">${renderH2HPredSection()}</div>
    ${renderH2HAllianceBlock('blue')}`;
}

function renderH2HPanel() {
  const root = document.getElementById('h2h-root');
  if (!root) return;
  root.innerHTML = `
    ${renderH2HSeasonPicker()}
    <div class="h2h-layout" id="h2h-main-layout">${renderH2HMainContent()}</div>
    ${renderH2HTimeline()}`;
  wireH2H(root);
}

function wireH2HDynamic(root) {
  root.querySelectorAll('.h2h-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      h2hState[btn.dataset.alliance][parseInt(btn.dataset.idx, 10)] = null;
      renderH2HPanel();
    });
  });

  root.querySelectorAll('.h2h-add-btn').forEach(btn => {
    const alliance = btn.dataset.alliance;
    const idx = parseInt(btn.dataset.idx, 10);
    const input = root.querySelector(`#h2h-input-${alliance}-${idx}`);

    const doAdd = async () => {
      const num = input?.value.trim();
      if (!num) return;
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const data = await fetchH2HTeamData(num);
        if (!data) {
          btn.textContent = 'Not found';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Add'; }, 1800);
          return;
        }
        h2hTeamData[data.name] = data;
        h2hState[alliance][idx] = data.name;
        h2hSliderPos = null;
        renderH2HPanel();
      } catch (_) {
        btn.textContent = 'Error';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Add'; }, 1800);
      }
    };

    btn.addEventListener('click', doAdd);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  });
}

function wireH2H(root) {
  const progSel = root.querySelector('#h2h-prog-sel');
  if (progSel) {
    progSel.addEventListener('change', async () => {
      await loadH2HSeasons(+progSel.value);
      h2hState = { red: [null, null], blue: [null, null] };
      h2hTeamData = {}; h2hSliderPos = null;
      renderH2HPanel();
    });
  }

  const seasonSel = root.querySelector('#h2h-season-sel');
  if (seasonSel) {
    seasonSel.addEventListener('change', () => {
      h2hSeason.seasonId = +seasonSel.value;
      h2hState = { red: [null, null], blue: [null, null] };
      h2hTeamData = {}; h2hSliderPos = null;
      renderH2HPanel();
    });
  }

  const slider = root.querySelector('#h2h-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      const max = h2hMaxPos();
      const val = parseInt(slider.value, 10);
      h2hSliderPos = val >= max ? null : val;
      const posEl = root.querySelector('#h2h-timeline-pos');
      if (posEl) posEl.textContent = getH2HTimelineLabel(h2hSliderPos === null ? max : val);
      const layout = root.querySelector('#h2h-main-layout');
      if (layout) { layout.innerHTML = renderH2HMainContent(); wireH2HDynamic(root); }
    });
  }

  wireH2HDynamic(root);
}
