const API_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIzIiwianRpIjoiYTRhZWJlYmU2ZTdhM2Y1ZDA2OWNhYjNiNjc0ZmUwNGYwYTJlNzkzM2QxNjI0MTg5ODY5ZjJjM2RiZmM3MzYwMzY3NzYyYTMwMDYwMDk5YWYiLCJpYXQiOjE3NzY5MDQxOTAuNTgzMzIzLCJuYmYiOjE3NzY5MDQxOTAuNTgzMzI0OSwiZXhwIjoyNzIzNjc1MzkwLjU3MzA3MzksInN1YiI6IjE0NTI5MCIsInNjb3BlcyI6W119.fyQ5Rlf3Ql4r7UlPLrTzTkAf1uwdWlirx2LML1yXSvf7d0IPPnPsOq9FFbdrD3qgTMpF8WFAB_I9oQgIPGPv-GgaHW-0NbyoeS4hXmj6kzz3pesLUPn9i02iePdi0A8BMroRdhljwXW9AjMDYEdebc5K6vz0zeKrXhliYa8wyEmsCm59LSA8CKGVgQ71gqXexzJftezM4ZlMP0l6WW8_xjCsQzoN2GI4gqPVCEVr7Py8HjUzy19vWX2diYTvWJoc87OLEdXRC17VzfjzmostPrjbwiIuVhoJUmi4GAEQHJe61tHGUbNGbeylNSXTEgCJXo7sxuSWA24EWpKSJ4Ud6QDgypxWI3vqf9-V2ZEfVddxRR6Tuw3oiFz5_F1Tbxrv2t45Qsc-Db-tRv_90tsMr_ABt-V_AxMalvXpVivHGHj1ePGlDjqifKNQvsMQ5uxT0oM__XseOWUeSw6ES2270Il1iqnPaCuM686nkcQnVRwU-Lw3u9ECJ68gfAyQaeD_slunNhdYfqsEymlJR3Yth77ZKIciv1cMCk-urRTTxkb1Ykc1CC8vr3WaTLBqXn-KSZjMQrhWugHLDVDjIBIgdQl3Yl2914diNrZXosEKQ_S_AouEhDUu0-oUwBm2vX0XhHBlVsguD4t0X4sNp6HpxGV_JFkwQqj8_dSyVkzjUNA';
const BASE = 'https://www.robotevents.com/api/v2';

const ROUND_NAMES = { 1: 'Practice', 2: 'Qualifications', 3: 'Quarterfinals', 4: 'Semifinals', 5: 'Finals', 6: 'Round of 16' };

// RobotEvents uses score = -1 as a sentinel for "not yet played" — treat anything < 0 as unscored
function isScored(score) { return typeof score === 'number' && score >= 0; }

// ── State ─────────────────────────────────────────────────────────────────
let currentTeam        = null;
let loadedSeasons      = [];
let loadedEvents       = [];
let currentEvent       = null;
let activeDiv          = null;
let activeEventTab     = 'rankings';
let cachedEventMatches  = []; // all matches for current event+division
let cachedOPR           = {}; // { teamName: { opr, dpr, ccwm } }
let cachedSeasonOPR     = {}; // { teamName: opr } — from prior events this season
let cachedEventRankings = {}; // { teamName: { rank, wins, losses, ties, winRate, wp } }
let cachedEventSkills   = {}; // { teamName: { driver, prog, combined, normalized } }
let currentTeamAtEvent  = null;
let predWeights         = JSON.parse(localStorage.getItem('predWeights') || 'null') || { opr: 50, ranking: 25, skills: 25 };
let showMatchPredictions = JSON.parse(localStorage.getItem('showMatchPredictions') || 'false');

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
  });
})();

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
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
const VIEWS = ['view-search', 'view-event', 'view-seasons', 'view-stats', 'view-team-event', 'view-map'];
function showView(id) {
  VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    if (which === 'map') { openMapView(); return; }
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
document.getElementById('back-to-event-from-team').addEventListener('click', () => showView('view-event'));
document.getElementById('back-from-map').addEventListener('click', () => showView(mapState.sourceView));

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
      'VIQRC': (s4.data  || []).sort((a, b) => b.id - a.id),
      'VEXU':  (s41.data || []).sort((a, b) => b.id - a.id),
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
  cachedEventMatches  = [];
  cachedOPR           = {};
  cachedSeasonOPR     = {};
  cachedEventRankings = {};
  cachedEventSkills   = {};

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
  document.getElementById('event-detail-hero').innerHTML = `
    <div class="event-hero">
      <div class="event-hero-name">${esc(ev.name)}</div>
      <div class="event-hero-meta">
        ${mf('Date', date)} ${mf('Location', loc)} ${mf('Program', ev.program?.name || '—')}
        ${mf('Season', ev.season?.name || '—')} ${mf('Level', ev.level || '—')} ${mf('Code', ev.sku || '—')}
      </div>
    </div>`;
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
      cachedEventMatches  = [];
      cachedOPR           = {};
      cachedSeasonOPR     = {};
      cachedEventRankings = {};
      cachedEventSkills   = {};
      await loadEventTabContent();
    });
  });
}

function renderDetailTabBar() {
  const tabs = [
    { id: 'rankings', label: 'Rankings' },
    { id: 'matches',  label: 'Matches'  },
    { id: 'simulate', label: 'Sim'      },
    { id: 'awards',   label: 'Awards'   },
    { id: 'skills',   label: 'Skills'   },
    { id: 'teams',    label: 'Teams'    },
    { id: 'map',      label: 'Map'      },
  ];
  document.getElementById('event-tabs-bar').innerHTML = `
    <div class="detail-tabs">
      ${tabs.map(t => `
        <button class="detail-tab ${t.id === activeEventTab ? 'active' : ''}" data-tab="${t.id}">
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

function attachMatchTabListeners(el) {
  // Prediction show/hide toggle
  const showToggle = el.querySelector('#pred-show-toggle');
  if (showToggle) {
    showToggle.addEventListener('click', () => {
      showMatchPredictions = !showMatchPredictions;
      showToggle.classList.toggle('active', showMatchPredictions);
      localStorage.setItem('showMatchPredictions', JSON.stringify(showMatchPredictions));
      reRenderMatchContainer(el);
    });
  }
  attachWeightListeners(el, () => reRenderMatchContainer(el));
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

  // Sim tab controls
  let simN = 100;
  el.querySelectorAll('.sim-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.sim-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      simN = +btn.dataset.n;
    });
  });
  const runBtn = el.querySelector('#sim-run-btn');
  if (runBtn) {
    runBtn.addEventListener('click', () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      setTimeout(() => {
        const results = runRankingSimulation(simN);
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
      }, 0); // defer to let UI update
    });
  }
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
        cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2));
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
        html = renderPredWeightsPanel() + '<div id="matches-table-container">' + renderMatches(cachedEventMatches) + '</div>';
        break;
      }
      case 'simulate': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        if (!cachedEventMatches.length) {
          cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
          cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2));
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
      case 'awards': {
        const data = await fetchAllPages(`/events/${eid}/awards`);
        html = renderEventAwards(data);
        break;
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
    return `<tr>
      <td><span class="rank-badge ${cls}">#${r.rank}</span></td>
      <td><button class="team-link" data-num="${esc(r.team?.name)}">${esc(r.team?.name)}</button></td>
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
        result[name] = vals.opr * weight;
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

// ── Effective OPR: current event → season fallback → rankings/skills proxy ─
function effectiveOPR(name) {
  const opr = cachedOPR[name]?.opr;
  if (opr != null && opr > 0) return opr;
  const seasonOpr = cachedSeasonOPR[name];
  if (seasonOpr != null && seasonOpr > 0) return seasonOpr;
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
  const allOPRVals = Object.values(cachedOPR).map(o => o.opr);
  const hasOPRData = allOPRVals.some(v => v > 1);
  const maxOPR     = Math.max(1, ...allOPRVals);
  const hasSeasonOPR = Object.keys(cachedSeasonOPR).length > 0;
  const maxSeasonOPR = hasSeasonOPR ? Math.max(1, ...Object.values(cachedSeasonOPR)) : 1;
  const BASELINE     = hasSeasonOPR ? maxSeasonOPR : 30;
  return str * (hasOPRData ? maxOPR : BASELINE);
}

// ── Match prediction (weighted: OPR + rankings + skills) ──────────────────
function predictMatch(m) {
  const alliances = m.alliances || [];
  const red  = alliances.find(a => a.color === 'red')  || alliances[0] || {};
  const blue = alliances.find(a => a.color === 'blue') || alliances[1] || {};
  const redTeams  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
  const blueTeams = (blue.teams || []).map(t => t.team?.name).filter(Boolean);

  const hasOPR  = Object.keys(cachedOPR).length > 0;
  const hasRank = Object.keys(cachedEventRankings).length > 0;
  const hasSk   = Object.keys(cachedEventSkills).length > 0;
  if (!hasOPR && !hasRank && !hasSk) return null;

  const w    = predWeights;
  const wOPR  = hasOPR  ? w.opr     : 0;
  const wRank = hasRank ? w.ranking : 0;
  const wSk   = hasSk   ? w.skills  : 0;
  const wTot  = wOPR + wRank + wSk;
  if (wTot === 0) return null;

  const allOPRVals = Object.values(cachedOPR).map(o => o.opr);
  const maxOPR     = Math.max(1, ...allOPRVals);

  function teamStrength(name) {
    let s = 0;
    if (wOPR  > 0) s += ((cachedOPR[name]?.opr || 0) / maxOPR) * wOPR;
    if (wRank > 0) s += (cachedEventRankings[name]?.winRate ?? 0.5) * wRank;
    if (wSk   > 0) s += (cachedEventSkills[name]?.normalized  || 0) * wSk;
    return s / wTot;
  }

  const redStr  = redTeams.reduce((s, n) => s + teamStrength(n), 0);
  const blueStr = blueTeams.reduce((s, n) => s + teamStrength(n), 0);
  const diff    = Math.abs(redStr - blueStr);
  const tot     = redStr + blueStr;
  const confidence = tot > 0 ? Math.min(90, Math.round(50 + (diff / tot) * 80)) : 50;

  const rawRed   = redTeams.reduce((s, n)  => s + effectiveOPR(n), 0);
  const rawBlue  = blueTeams.reduce((s, n) => s + effectiveOPR(n), 0);
  const canScore = hasOPR || hasRank || hasSk;
  const redScore  = canScore ? Math.max(0, Math.round(rawRed))  : null;
  const blueScore = canScore ? Math.max(0, Math.round(rawBlue)) : null;

  return {
    redScore, blueScore,
    winner: redStr > blueStr ? 'red' : blueStr > redStr ? 'blue' : 'tie',
    confidence,
  };
}

// ── Prediction weights panel ───────────────────────────────────────────────
function renderPredWeightsPanel() {
  const w   = predWeights;
  const on  = showMatchPredictions;
  const row = (label, key) =>
    '<div class="weight-row">' +
    '<label class="weight-label">' + label + '</label>' +
    '<input type="range" class="weight-slider" min="0" max="100" value="' + w[key] + '" data-key="' + key + '" />' +
    '<span class="weight-val" data-key="' + key + '">' + w[key] + '</span>' +
    '</div>';
  return '<div class="pred-controls-bar">' +
    '<button id="pred-show-toggle" class="pred-toggle-btn' + (on ? ' active' : '') + '">Show Predictions</button>' +
    '<button class="pred-weights-toggle" id="pred-weights-toggle">⚙ Weights <span class="pred-chevron">▼</span></button>' +
    '</div>' +
    '<div class="pred-weights-body hidden" id="pred-weights-body">' +
    row('Current Event (OPR)', 'opr') +
    row('Win Rate (Rankings)',  'ranking') +
    row('Skills Scores',        'skills') +
    '</div>';
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

      const hasScore = isScored(red.score) && isScored(blue.score);
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

  const hasScore = isScored(red.score) && isScored(blue.score);
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
          ? 'OPR / DPR / CCWM calculated from all scored qualification matches via least-squares.'
          : 'No scored qualification matches yet — OPR cannot be calculated.'}
      </p>
      ${pred ? buildPredPanel(pred, hasScore ? (red.score > blue.score ? 'red' : blue.score > red.score ? 'blue' : 'tie') : null) : ''}
      ${renderPredEvolutionChart(computePredictionHistory(m))}
    </div>`;
}

// ── Rankings Simulation ────────────────────────────────────────────────────

function runRankingSimulation(nSims) {
  // Build the division team set exclusively from the division's match schedule
  // so we never accidentally include teams from other divisions or events.
  const divTeamNames = new Set();
  for (const m of cachedEventMatches) {
    if (m.round !== 2) continue;
    for (const a of (m.alliances || [])) {
      for (const t of (a.teams || [])) {
        if (t.team?.name) divTeamNames.add(t.team.name);
      }
    }
  }

  // Seed team state from current division rankings
  const teams = {};
  for (const [name, r] of Object.entries(cachedEventRankings)) {
    if (!divTeamNames.has(name)) continue; // exclude cross-division contamination
    const played = r.wins + r.losses + r.ties;
    const wpFromRecord = r.wins * 2 + r.ties;
    const surplus = Math.max(0, (r.wp || 0) - wpFromRecord);
    teams[name] = {
      wp: r.wp || 0,
      sp: 0,
      awpRate: played > 0 ? Math.min(0.9, surplus / played) : 0.2,
    };
  }
  // Add division teams not yet in rankings (no matches played)
  for (const name of divTeamNames) {
    if (!teams[name]) teams[name] = { wp: 0, sp: 0, awpRate: 0.2 };
  }

  const unscored = cachedEventMatches.filter(m =>
    m.round === 2 && !(m.alliances || []).every(a => isScored(a.score))
  );

  // Accumulate rank sums over N simulations
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

  const numTeams = Object.keys(teams).length;
  const playoffCutoff = Math.min(16, Math.max(4, Math.floor(numTeams * 0.3)));

  for (let sim = 0; sim < nSims; sim++) {
    // Clone team WP/AP/SP from current state
    const simTeams = {};
    for (const [n, t] of Object.entries(teams)) {
      simTeams[n] = { wp: t.wp, ap: 0, sp: 0, awpRate: t.awpRate };
    }

    for (const m of unscored) {
      const alliances = m.alliances || [];
      const red  = alliances.find(a => a.color === 'red')  || alliances[0];
      const blue = alliances.find(a => a.color === 'blue') || alliances[1];
      if (!red || !blue) continue;

      const pred = predictMatch(m);
      if (!pred) continue;

      // Stochastic outcome: confidence drives win probability
      const conf = pred.confidence / 100;
      const rand = Math.random();
      let winner; // 'red', 'blue', or 'tie'
      if (pred.winner === 'tie') {
        winner = rand < 0.1 ? 'red' : rand < 0.2 ? 'blue' : 'tie';
      } else {
        const favWins = rand < conf;
        winner = favWins ? pred.winner : (pred.winner === 'red' ? 'blue' : 'red');
        if (rand < 0.05) winner = 'tie'; // small tie probability
      }

      const redNames  = (red.teams  || []).map(t => t.team?.name).filter(Boolean);
      const blueNames = (blue.teams || []).map(t => t.team?.name).filter(Boolean);

      const addWP = (names, wps) => {
        for (const n of names) {
          if (!simTeams[n]) simTeams[n] = { wp: 0, ap: 0, sp: 0, awpRate: 0.2 };
          simTeams[n].wp += wps;
          // AWP only for teams that earned match points (winners/ties); losers get 0
          if (wps > 0 && Math.random() < simTeams[n].awpRate) simTeams[n].wp += 1;
        }
      };

      // SP = losing alliance's predicted score
      const redSP  = pred.redScore  ?? 0;
      const blueSP = pred.blueScore ?? 0;

      if (winner === 'red') {
        addWP(redNames, 2); addWP(blueNames, 0);
        for (const n of redNames)  { if (simTeams[n]) simTeams[n].sp += blueSP; }
        for (const n of blueNames) { if (simTeams[n]) simTeams[n].sp += blueSP; }
        redNames.forEach(n  => { if (winSums[n]  != null) winSums[n]++;  });
        blueNames.forEach(n => { if (lossSums[n] != null) lossSums[n]++; });
      } else if (winner === 'blue') {
        addWP(blueNames, 2); addWP(redNames, 0);
        for (const n of redNames)  { if (simTeams[n]) simTeams[n].sp += redSP; }
        for (const n of blueNames) { if (simTeams[n]) simTeams[n].sp += redSP; }
        blueNames.forEach(n => { if (winSums[n]  != null) winSums[n]++;  });
        redNames.forEach(n  => { if (lossSums[n] != null) lossSums[n]++; });
      } else {
        addWP(redNames, 1); addWP(blueNames, 1);
        for (const n of redNames)  { if (simTeams[n]) simTeams[n].sp += blueSP; }
        for (const n of blueNames) { if (simTeams[n]) simTeams[n].sp += redSP; }
        [...redNames, ...blueNames].forEach(n => { if (tieSums[n] != null) tieSums[n]++; });
      }
    }

    // Sort by WP → AP → SP and record ranks
    const sorted = Object.entries(simTeams)
      .sort(([, a], [, b]) => b.wp - a.wp || b.ap - a.ap || b.sp - a.sp);
    sorted.forEach(([name], i) => {
      const r = i + 1;
      rankSums[name]    = (rankSums[name]  || 0) + r;
      wpSums[name]      = (wpSums[name]    || 0) + simTeams[name].wp;
      rankCounts[name][r] = (rankCounts[name][r] || 0) + 1;
    });
  }

  const playoffProb = name => {
    let c = 0;
    for (let r = 1; r <= playoffCutoff; r++) c += (rankCounts[name][r] || 0);
    return Math.round((c / nSims) * 100);
  };

  // Build results: average rank, WP, rank distribution, and playoff probability
  return Object.keys(rankSums)
    .map(name => ({
      name,
      avgRank:    rankSums[name] / nSims,
      avgWP:      +(wpSums[name] / nSims).toFixed(1),
      current:    cachedEventRankings[name] || null,
      rankCounts: rankCounts[name],
      playoffPct: playoffProb(name),
      avgWins:    +(winSums[name] / nSims).toFixed(1),
      avgLosses:  +(lossSums[name] / nSims).toFixed(1),
      avgTies:    +(tieSums[name] / nSims).toFixed(1),
      numTeams,
      playoffCutoff,
    }))
    .sort((a, b) => a.avgRank - b.avgRank);
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
    const isPlayed = isScored(red.score) && isScored(blue.score);

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
    !(m.alliances || []).every(a => isScored(a.score))
  ).length;

  if (!quals.length && !Object.keys(cachedEventRankings).length) {
    return '<div class="stats-section"><p class="empty">No match data available for simulation.</p></div>';
  }

  const simOptions = [10, 100, 500, 1000];
  const defaultSim = 100;

  const controls =
    '<div class="sim-controls">' +
    '<span class="sim-label">Simulations:</span>' +
    simOptions.map(n =>
      '<button class="sim-count-btn' + (n === defaultSim ? ' active' : '') + '" data-n="' + n + '">' + n + '</button>'
    ).join('') +
    '<button class="btn-primary sim-run-btn" id="sim-run-btn">Run Simulation</button>' +
    '</div>';

  const divTeamCount = new Set(
    cachedEventMatches.filter(m => m.round === 2).flatMap(m =>
      (m.alliances || []).flatMap(a => (a.teams || []).map(t => t.team?.name).filter(Boolean))
    )
  ).size;
  const cutoff = Math.min(16, Math.max(4, Math.floor(divTeamCount * 0.3)));

  const info =
    '<p class="sim-info">' + unscoredCount + ' unscored qual match' + (unscoredCount !== 1 ? 'es' : '') +
    ' remaining · Alliance selection cutoff: top ' + cutoff + ' of ' + divTeamCount + ' teams</p>';

  return '<div class="stats-section">' +
    '<div class="section-title">Predicted Final Rankings</div>' +
    info + controls +
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
    const cls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const elimCls = r.playoffPct >= 60 ? 'playoff-high' : r.playoffPct >= 30 ? 'playoff-mid' : 'playoff-low';
    const record  = r.avgWins + '-' + r.avgLosses + (r.avgTies > 0 ? '-' + r.avgTies : '');
    return '<tr>' +
      '<td><span class="rank-badge ' + cls + '">#' + (i + 1) + '</span></td>' +
      '<td><button class="team-link" data-num="' + esc(r.name) + '">' + esc(r.name) + '</button></td>' +
      '<td style="color:var(--text-muted)">' + curRank + '</td>' +
      '<td>' + deltaStr + '</td>' +
      '<td class="' + elimCls + '">' + r.playoffPct + '%</td>' +
      '<td style="color:var(--text-muted);font-size:.8rem">' + record + '</td>' +
      '<td style="font-weight:600">' + r.avgWP + '</td>' +
      '<td>' + renderRankBar(r.rankCounts, nSims, numTeams) + '</td>' +
      '</tr>';
  }).join('');

  return '<div class="table-wrap"><table class="sim-results-table">' +
    '<thead><tr><th>Pred.</th><th>Team</th><th>Now</th><th>Δ</th>' +
    '<th>Elim%</th><th>Record</th><th>Avg WP</th><th>Distribution</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
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

const PROGRAM_IDS = { all: null, v5rc: 1, viqrc: 4, vexu: 41 };

let mapState = { programId: 1, grade: 'all', eventId: null, countryData: {}, leafletMap: null, sourceView: 'view-search' };

function destroyLeafletMap() {
  if (mapState.leafletMap) {
    mapState.leafletMap.remove();
    mapState.leafletMap = null;
  }
}

async function openMapView(eventId) {
  mapState.eventId    = eventId || null;
  mapState.sourceView = eventId ? 'view-event' : 'view-search';
  // Always show all grades for event-specific maps so no teams are accidentally hidden
  if (eventId) mapState.grade = 'all';
  showView('view-map');

  // Default to V5RC on global view so we don't try to load every team on earth
  if (!eventId) mapState.programId = mapState.programId || 1;

  const progKey = Object.entries(PROGRAM_IDS).find(([, v]) => v === mapState.programId)?.[0] || 'v5rc';

  const filterEl = document.getElementById('map-filters');
  filterEl.innerHTML =
    '<div class="map-filters">' +
    (eventId
      ? '<span class="sim-label">Showing teams at: <strong>' + esc(currentEvent?.name || 'Event') + '</strong></span>'
      : '<select class="map-filter-select" id="map-prog-select">' +
        '<option value="all">All Programs</option>' +
        '<option value="v5rc"' + (progKey === 'v5rc' ? ' selected' : '') + '>V5RC</option>' +
        '<option value="viqrc"' + (progKey === 'viqrc' ? ' selected' : '') + '>VIQRC</option>' +
        '<option value="vexu"' + (progKey === 'vexu' ? ' selected' : '') + '>VEXU</option>' +
        '</select>' +
        '<select class="map-filter-select" id="map-grade-select">' +
        '<option value="all"' + (mapState.grade === 'all' ? ' selected' : '') + '>All Grades</option>' +
        '<option value="Middle School"' + (mapState.grade === 'Middle School' ? ' selected' : '') + '>Middle School</option>' +
        '<option value="High School"' + (mapState.grade === 'High School' ? ' selected' : '') + '>High School</option>' +
        '<option value="College"' + (mapState.grade === 'College' ? ' selected' : '') + '>College</option>' +
        '</select>') +
    '</div>';

  if (!eventId) {
    document.getElementById('map-prog-select').addEventListener('change', e => {
      mapState.programId = PROGRAM_IDS[e.target.value] ?? null;
      loadMapData();
    });
    document.getElementById('map-grade-select').addEventListener('change', e => {
      mapState.grade = e.target.value;
      applyMapGradeFilter();
    });
  }

  const panel = document.getElementById('map-country-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';

  await loadMapData();
}

async function getActiveSeasonId(programId) {
  try {
    const json = await apiFetch(`/seasons?program[]=${programId}&active=true&per_page=1`);
    if (json.data?.length) return json.data[0].id;
    const fallback = await apiFetch(`/seasons?program[]=${programId}&per_page=1`);
    return fallback.data?.[0]?.id || null;
  } catch { return null; }
}

async function fetchMapTeams(url, maxPages = 20) {
  const all = [];
  const sep = url.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page++) {
    const json = await apiFetch(`${url}${sep}page=${page}&per_page=250`);
    if (!json.data?.length) break;
    all.push(...json.data);
    if (!json.meta || page >= json.meta.last_page) break;
  }
  return all;
}

async function loadMapData() {
  destroyLeafletMap();
  const container = document.getElementById('map-container');
  container.innerHTML = '<p class="empty" style="padding:20px">Loading team data…</p>';

  try {
    let teams;
    if (mapState.eventId) {
      // Event-specific: fetch all teams at this event (usually < 200, no cap needed)
      teams = await fetchAllPages(`/events/${mapState.eventId}/teams`);
    } else if (mapState.programId) {
      const seasonId = await getActiveSeasonId(mapState.programId);
      const url = `/teams?myTeams=false&registered=true&program[]=${mapState.programId}` +
        (seasonId ? `&season[]=${seasonId}` : '');
      teams = await fetchMapTeams(url, 20); // cap at 20 pages = 5000 teams
    } else {
      // All programs — fetch current registered teams per program in parallel
      const programIds = [1, 4, 41]; // V5RC, VIQRC, VEXU
      const chunks = await Promise.all(programIds.map(async pid => {
        const seasonId = await getActiveSeasonId(pid);
        const url = `/teams?myTeams=false&registered=true&program[]=${pid}` +
          (seasonId ? `&season[]=${seasonId}` : '');
        return fetchMapTeams(url, 10); // 10 pages per program
      }));
      teams = chunks.flat();
    }
    mapState.allTeams = teams;
    mapState.grade    = mapState.grade || 'all';
    buildAndRenderMap(teams);
  } catch (err) {
    container.innerHTML = '<p class="empty">Error loading team data: ' + esc(err.message) + '</p>';
  }
}

function applyMapGradeFilter() {
  if (!mapState.allTeams) return;
  buildAndRenderMap(mapState.allTeams);
}

function buildAndRenderMap(teams) {
  const grade = mapState.grade;
  // Collect teams with coordinates; fall back to country centroid if no lat/lon
  const dots = {}; // key = "lat,lon" (rounded to 2dp) → { lat, lon, teams[] }
  const byCountry = {};

  for (const t of teams) {
    if (grade !== 'all' && t.grade !== grade) continue;
    const country = t.location?.country;
    const teamInfo = { name: t.team_name || t.name || t.number, number: t.number, grade: t.grade, country, programId: t.program?.id };

    // Prefer exact coordinates from API
    let lat = t.location?.coordinates?.lat;
    let lon = t.location?.coordinates?.lon;

    // Fall back to country centroid
    if ((lat == null || lon == null) && country && COUNTRY_COORDS[country]) {
      [lat, lon] = COUNTRY_COORDS[country];
    }

    if (lat != null && lon != null) {
      const key = lat.toFixed(2) + ',' + lon.toFixed(2);
      if (!dots[key]) {
        const city = t.location?.city || '';
        dots[key] = { lat, lon, city, teams: [] };
      }
      dots[key].teams.push(teamInfo);
    }

    // Also aggregate by country for the legend count
    if (country) {
      if (!byCountry[country]) byCountry[country] = { count: 0, teams: [] };
      byCountry[country].count++;
      byCountry[country].teams.push(teamInfo);
    }
  }

  mapState.countryData = byCountry;
  mapState.dots = dots;
  renderLeafletMap(dots, byCountry);
}

function renderLeafletMap(dots, countryData) {
  destroyLeafletMap();
  const container = document.getElementById('map-container');
  container.innerHTML = '';
  container.style.height = '480px';

  if (typeof L === 'undefined') {
    container.innerHTML = '<p class="empty" style="padding:20px">Map library failed to load. Check your internet connection.</p>';
    return;
  }

  const leafletMap = L.map(container, { zoomControl: true, scrollWheelZoom: true });
  mapState.leafletMap = leafletMap;

  L.tileLayer('https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=v2zClPQKX8x55Lzh1OxJ', {
    attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(leafletMap);

  setTimeout(() => {
    leafletMap.invalidateSize();
    leafletMap.setView([20, 10], 2);
  }, 50);

  const maxAtDot = Math.max(1, ...Object.values(dots).map(d => d.teams.length));
  let totalTeams = 0;

  for (const dot of Object.values(dots)) {
    totalTeams += dot.teams.length;
    const count  = dot.teams.length;
    const frac   = count / maxAtDot;
    // Single team: small blue dot. Multiple teams: grows and shifts toward red.
    const radius = count === 1 ? 5 : 5 + Math.sqrt(frac) * 18;
    const hue    = count === 1 ? 210 : Math.round(210 - frac * 180);
    const color  = `hsl(${hue},75%,45%)`;

    const marker = L.circleMarker([dot.lat, dot.lon], {
      radius,
      fillColor:   color,
      color:       '#fff',
      weight:      1,
      opacity:     0.9,
      fillOpacity: 0.8,
    }).addTo(leafletMap);

    const tipLabel = count === 1
      ? '<strong>' + esc(dot.teams[0].number) + '</strong> ' + esc(dot.teams[0].name)
      : '<strong>' + count + ' teams</strong> at this location';
    marker.bindTooltip(tipLabel, { direction: 'top', offset: [0, -4] });
    marker.on('click', () => showMapDotsPanel(dot));
  }

  const total = Object.values(countryData).reduce((s, d) => s + d.count, 0);
  const legendEl = document.getElementById('map-legend');
  legendEl.innerHTML =
    '<div class="map-legend">' +
    '<span>1 team</span><div class="map-legend-bar"></div><span>Many teams</span>' +
    '<span style="margin-left:auto;color:var(--text-muted)">' +
    total.toLocaleString() + ' teams · ' + Object.keys(countryData).length + ' countries</span>' +
    '</div>';
}

function showMapDotsPanel(dot) {
  const panel = document.getElementById('map-country-panel');
  panel.classList.remove('hidden');
  const teams = dot.teams;
  const inEvent = !!mapState.eventId;
  const country = teams[0]?.country || '';
  const city    = dot.city || '';

  const locationLabel = [city, country].filter(Boolean).join(', ') || 'this location';

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

// ── OPR / DPR / CCWM (least-squares) ──────────────────────────────────────
function computeOPR(qualMatches) {
  // Build team index from scored matches only
  const teamNames = [];
  const teamIdx   = {};

  qualMatches.forEach(m => {
    (m.alliances || []).forEach(a => {
      if (!isScored(a.score)) return;
      (a.teams || []).forEach(t => {
        const name = t.team?.name;
        if (name && !(name in teamIdx)) {
          teamIdx[name] = teamNames.length;
          teamNames.push(name);
        }
      });
    });
  });

  const n = teamNames.length;
  if (n === 0) return {};

  // Build normal equations A^T A x = A^T b
  const ATA   = Array.from({ length: n }, () => new Array(n).fill(0));
  const ATb_o = new Array(n).fill(0);
  const ATb_d = new Array(n).fill(0);

  qualMatches.forEach(m => {
    const alliances = m.alliances || [];
    const red  = alliances.find(a => a.color === 'red')  || alliances[0];
    const blue = alliances.find(a => a.color === 'blue') || alliances[1];
    if (!red || !blue) return;
    if (!isScored(red.score) || !isScored(blue.score)) return;

    for (const [ally, ownScore, oppScore] of [
      [red,  red.score,  blue.score],
      [blue, blue.score, red.score ],
    ]) {
      const indices = (ally.teams || [])
        .map(t => teamIdx[t.team?.name])
        .filter(i => i !== undefined);

      indices.forEach(i => {
        ATb_o[i] += ownScore;
        ATb_d[i] += oppScore;
        indices.forEach(j => { ATA[i][j]++; });
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

// ── Event Awards ───────────────────────────────────────────────────────────
function renderEventAwards(awards) {
  if (!awards.length) return `
    <div class="stats-section">
      <div class="section-title">Awards</div>
      <p class="empty">No awards data available.</p>
    </div>`;
  const sorted = [...awards].sort((a, b) => (a.order || 0) - (b.order || 0));
  const items = sorted.map(a => {
    const winners = (a.teams || []).map(t => {
      if (t.team?.name) return `<button class="team-link" data-num="${esc(t.team.name)}" style="font-size:.85rem">${esc(t.team.name)}</button>`;
      if (t.person)     return `<span style="font-size:.85rem">${esc(t.person)}</span>`;
      return '';
    }).filter(Boolean).join(', ');
    const quals = a.qualifications?.length
      ? `<div class="award-qual">Qualifies for: ${esc(a.qualifications.join(', '))}</div>` : '';
    return `<div class="award-item">
      <div class="award-title">🏆 ${esc(a.title)}</div>
      ${winners ? `<div class="award-winner">${winners}</div>` : ''}
      ${quals}
    </div>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Awards (${awards.length})</div>
      <div class="awards-list">${items}</div>
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
  document.getElementById('team-hero').innerHTML = teamHeroHTML(team, false);
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
    const [events, rankings, skills, awards] = await Promise.all([
      fetchAllPages(`/teams/${team.id}/events?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/rankings?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/skills?season[]=${sid}`),
      fetchAllPages(`/teams/${team.id}/awards?season[]=${sid}`),
    ]);
    clearStatus('stats');
    renderTeamStats(events, rankings, skills, awards);
  } catch (err) {
    setStatus('stats', `Error: ${err.message}`, 'error');
  }
}

function renderTeamStats(events, rankings, skills, awards) {
  const el = document.getElementById('stats-content');
  const eventMap = {};
  events.forEach(ev => { eventMap[ev.id] = ev; });

  const bestRank      = rankings.length ? Math.min(...rankings.map(r => r.rank)) : null;
  const driver        = skills.filter(s => s.type === 'driver');
  const prog          = skills.filter(s => s.type === 'programming');
  const bestDriver    = driver.length ? Math.max(...driver.map(s => s.score)) : null;
  const bestProg      = prog.length   ? Math.max(...prog.map(s => s.score))   : null;
  const _skillRanks = skills.map(s => s.rank).filter(n => n != null && n > 0);
  const worldSkillsRank = _skillRanks.length ? Math.min(..._skillRanks) : null;

  el.innerHTML = [
    metricsHTML(events.length, bestRank, worldSkillsRank, awards.length),
    teamRankingsHTML(rankings, eventMap),
    teamSkillsHTML(driver, prog, bestDriver, bestProg),
    teamAwardsHTML(awards),
  ].join('');

  el.querySelectorAll('.clickable-row[data-event-id]').forEach(row => {
    const ev = eventMap[+row.dataset.eventId];
    if (!ev) return;
    row.addEventListener('click', () => openEventDetail(ev));
  });
}

function metricsHTML(evCount, bestRank, worldSkillsRank, awardCount) {
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
      <p class="match-hint">Click an event row to view full event details.</p>
      <div class="table-wrap">
        <table><thead><tr>
          <th>Date</th><th>Event</th><th>Rank</th><th>W–L–T</th><th>Points</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
}

function teamSkillsHTML(driver, prog, bestDriver, bestProg) {
  if (!driver.length && !prog.length) return `
    <div class="stats-section">
      <div class="section-title">Skills</div>
      <p class="empty">No skills data for this season.</p>
    </div>`;
  const _dRanks = driver.map(s => s.rank).filter(n => n != null && n > 0);
  const _pRanks = prog.map(s => s.rank).filter(n => n != null && n > 0);
  const driverWorldRank = _dRanks.length ? Math.min(..._dRanks) : null;
  const progWorldRank   = _pRanks.length ? Math.min(..._pRanks) : null;
  const combined = bestDriver != null && bestProg != null ? bestDriver + bestProg : null;
  const card = (label, score, worldRank) => score != null ? `
    <div class="skill-card">
      <div class="skill-type">${label}</div>
      <div class="skill-score">${score}</div>
      ${worldRank ? `<div class="skill-rank">World Rank #${worldRank}</div>` : ''}
    </div>` : '';
  return `
    <div class="stats-section">
      <div class="section-title">Skills</div>
      <div class="skills-row">
        ${card('Driver', bestDriver, driverWorldRank)}
        ${card('Programming', bestProg, progWorldRank)}
        ${combined != null ? card('Combined', combined, null) : ''}
      </div>
    </div>`;
}

function teamAwardsHTML(awards) {
  if (!awards.length) return `
    <div class="stats-section">
      <div class="section-title">Awards</div>
      <p class="empty">No awards this season.</p>
    </div>`;
  const items = awards.map(a => {
    const evId = a.event?.id ?? '';
    return `<div class="award-item${evId ? ' clickable-row' : ''}" data-event-id="${evId}">
      <div class="award-title">🏆 ${esc(a.title)}</div>
      <div class="award-event-name">${evId ? `<span class="event-link">${esc(a.event?.name || '—')}</span>` : esc(a.event?.name || '—')}</div>
    </div>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Awards (${awards.length})</div>
      <div class="awards-list">${items}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function teamHeroHTML(t, clickable) {
  const loc = [t.location?.city, t.location?.region, t.location?.country].filter(Boolean).join(', ') || '—';
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
  el.classList.remove('hidden', 'error', 'warn');
  el.textContent = msg;
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

  document.getElementById('back-to-event-link').addEventListener('click', () => showView('view-event'));

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
      cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2));
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
      renderPredWeightsPanel() +
      renderScheduleStrengthSection(teamNumber) +
      '<div id="team-sched-container">' + schedHtml + '</div>';

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
    (m.alliances || []).every(a => isScored(a.score))
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
    if (!mine || !opp || !isScored(mine.score) || !isScored(opp.score)) continue;
    if (mine.score > opp.score) wins++;
    else if (mine.score < opp.score) losses++;
    else ties++;
  }

  // Predicted wins in unscored matches
  let predWins = 0, predCount = 0;
  for (const match of teamMatches) {
    const al   = match.alliances || [];
    const mine = al.find(a => (a.teams || []).some(t => t.team?.name === teamNumber));
    if (!mine || isScored(mine.score)) continue;
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
    m.round === 2 && !(m.alliances || []).every(a => isScored(a.score)));
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

    const hasScore = isScored(mine.score) && isScored(opp?.score);
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
