const API_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIzIiwianRpIjoiYTRhZWJlYmU2ZTdhM2Y1ZDA2OWNhYjNiNjc0ZmUwNGYwYTJlNzkzM2QxNjI0MTg5ODY5ZjJjM2RiZmM3MzYwMzY3NzYyYTMwMDYwMDk5YWYiLCJpYXQiOjE3NzY5MDQxOTAuNTgzMzIzLCJuYmYiOjE3NzY5MDQxOTAuNTgzMzI0OSwiZXhwIjoyNzIzNjc1MzkwLjU3MzA3MzksInN1YiI6IjE0NTI5MCIsInNjb3BlcyI6W119.fyQ5Rlf3Ql4r7UlPLrTzTkAf1uwdWlirx2LML1yXSvf7d0IPPnPsOq9FFbdrD3qgTMpF8WFAB_I9oQgIPGPv-GgaHW-0NbyoeS4hXmj6kzz3pesLUPn9i02iePdi0A8BMroRdhljwXW9AjMDYEdebc5K6vz0zeKrXhliYa8wyEmsCm59LSA8CKGVgQ71gqXexzJftezM4ZlMP0l6WW8_xjCsQzoN2GI4gqPVCEVr7Py8HjUzy19vWX2diYTvWJoc87OLEdXRC17VzfjzmostPrjbwiIuVhoJUmi4GAEQHJe61tHGUbNGbeylNSXTEgCJXo7sxuSWA24EWpKSJ4Ud6QDgypxWI3vqf9-V2ZEfVddxRR6Tuw3oiFz5_F1Tbxrv2t45Qsc-Db-tRv_90tsMr_ABt-V_AxMalvXpVivHGHj1ePGlDjqifKNQvsMQ5uxT0oM__XseOWUeSw6ES2270Il1iqnPaCuM686nkcQnVRwU-Lw3u9ECJ68gfAyQaeD_slunNhdYfqsEymlJR3Yth77ZKIciv1cMCk-urRTTxkb1Ykc1CC8vr3WaTLBqXn-KSZjMQrhWugHLDVDjIBIgdQl3Yl2914diNrZXosEKQ_S_AouEhDUu0-oUwBm2vX0XhHBlVsguD4t0X4sNp6HpxGV_JFkwQqj8_dSyVkzjUNA';
const BASE = 'https://www.robotevents.com/api/v2';

const ROUND_NAMES = { 1: 'Practice', 2: 'Qualifications', 3: 'Quarterfinals', 4: 'Semifinals', 5: 'Finals', 6: 'Round of 16' };

// ── State ─────────────────────────────────────────────────────────────────
let currentTeam        = null;
let loadedSeasons      = [];
let loadedEvents       = [];
let currentEvent       = null;
let activeDiv          = null;
let activeEventTab     = 'rankings';
let cachedEventMatches = []; // all matches for current event+division
let cachedOPR          = {}; // { teamName: { opr, dpr, ccwm } }

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
const VIEWS = ['view-search', 'view-event', 'view-seasons', 'view-stats'];
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
      cachedEventMatches = [];
      cachedOPR = {};
      await loadEventTabContent();
    });
  });
}

function renderDetailTabBar() {
  const tabs = [
    { id: 'rankings', label: 'Rankings' },
    { id: 'matches',  label: 'Matches'  },
    { id: 'awards',   label: 'Awards'   },
    { id: 'skills',   label: 'Skills'   },
    { id: 'teams',    label: 'Teams'    },
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
        html = renderEventRankings(data);
        break;
      }
      case 'matches': {
        if (!did) { html = '<p class="empty">No divisions found.</p>'; break; }
        cachedEventMatches = await fetchAllPages(`/events/${eid}/divisions/${did}/matches`);
        // Compute OPR from scored qualification matches
        cachedOPR = computeOPR(cachedEventMatches.filter(m => m.round === 2));
        html = renderMatches(cachedEventMatches);
        break;
      }
      case 'awards': {
        const data = await fetchAllPages(`/events/${eid}/awards`);
        html = renderEventAwards(data);
        break;
      }
      case 'skills': {
        const data = await fetchAllPages(`/events/${eid}/skills`);
        html = renderEventSkills(data);
        break;
      }
      case 'teams': {
        const data = await fetchAllPages(`/events/${eid}/teams`);
        html = renderEventTeams(data);
        break;
      }
    }

    clearStatus('event-tab');
    el.innerHTML = html;

    // Team link navigation
    el.querySelectorAll('.team-link[data-num]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation(); // prevent match-row click
        const num = btn.dataset.num;
        if (!num || num === 'undefined') return;
        setStatus('event-tab', `Looking up team ${esc(num)}…`);
        try {
          const json = await apiFetch(`/teams?number[]=${encodeURIComponent(num)}&myTeams=false`);
          const team = json.data?.[0];
          if (team) { clearStatus('event-tab'); openSeasonsView(team); }
          else setStatus('event-tab', `Team ${esc(num)} not found.`, 'error');
        } catch (err) {
          setStatus('event-tab', `Error: ${err.message}`, 'error');
        }
      });
    });

    // Match row click → show detail with OPR/DPR/CCWM
    el.querySelectorAll('.match-row').forEach(row => {
      row.addEventListener('click', () => toggleMatchDetail(row));
    });

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

      const redTeams  = (red.teams  || []).map(t => esc(t.team?.name || '?')).join(' / ');
      const blueTeams = (blue.teams || []).map(t => esc(t.team?.name || '?')).join(' / ');

      // Use typeof check — works even when m.scored is undefined/false
      const redScore  = typeof red.score  === 'number' ? red.score  : '—';
      const blueScore = typeof blue.score === 'number' ? blue.score : '—';
      const hasScore  = typeof red.score === 'number' && typeof blue.score === 'number';
      const redWon    = hasScore && red.score  > blue.score;
      const blueWon   = hasScore && blue.score > red.score;

      const matchId = m.round === 2 ? `Q${m.matchnum}`
        : m.round === 1 ? `P${m.matchnum}`
        : `${m.instance}-${m.matchnum}`;

      return `<tr class="match-row" data-idx="${m._idx}">
        <td class="match-id-cell">${matchId}</td>
        <td class="td-red">${redTeams || '—'}</td>
        <td class="td-score ${redWon ? 'td-score-red' : hasScore && blueWon ? 'td-score-muted' : ''}">${redScore}</td>
        <td class="match-vs">–</td>
        <td class="td-score ${blueWon ? 'td-score-blue' : hasScore && redWon ? 'td-score-muted' : ''}">${blueScore}</td>
        <td class="td-blue">${blueTeams || '—'}</td>
        <td class="match-chevron">›</td>
      </tr>`;
    }).join('');

    return `
      <div class="stats-section">
        <div class="section-title">${roundName}</div>
        <p class="match-hint">Click a row to see OPR · DPR · CCWM</p>
        <div class="table-wrap">
          <table class="match-table">
            <thead><tr>
              <th>Match</th>
              <th style="color:#9B1C1C">Red Alliance</th>
              <th style="color:#9B1C1C">Score</th>
              <th></th>
              <th style="color:#1E3A8A">Score</th>
              <th style="color:#1E3A8A">Blue Alliance</th>
              <th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
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
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const num = btn.dataset.num;
      if (!num || num === 'undefined') return;
      setStatus('event-tab', `Looking up team ${esc(num)}…`);
      try {
        const json = await apiFetch(`/teams?number[]=${encodeURIComponent(num)}&myTeams=false`);
        const team = json.data?.[0];
        if (team) { clearStatus('event-tab'); openSeasonsView(team); }
        else setStatus('event-tab', `Team ${esc(num)} not found.`, 'error');
      } catch (err) {
        setStatus('event-tab', `Error: ${err.message}`, 'error');
      }
    });
  });
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

  const hasScore = typeof red.score === 'number' && typeof blue.score === 'number';
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
    </div>`;
}

// ── OPR / DPR / CCWM (least-squares) ──────────────────────────────────────
function computeOPR(qualMatches) {
  // Build team index from scored matches only
  const teamNames = [];
  const teamIdx   = {};

  qualMatches.forEach(m => {
    (m.alliances || []).forEach(a => {
      if (typeof a.score !== 'number') return;
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
    if (typeof red.score !== 'number' || typeof blue.score !== 'number') return;

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
  const worldSkillsRank = skills.length
    ? Math.min(...skills.map(s => s.rank).filter(n => n != null))
    : null;

  el.innerHTML = [
    metricsHTML(events.length, bestRank, worldSkillsRank, awards.length),
    teamRankingsHTML(rankings, eventMap),
    teamSkillsHTML(driver, prog, bestDriver, bestProg),
    teamAwardsHTML(awards),
  ].join('');
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
    return `<tr>
      <td style="color:var(--text-muted);font-size:.82rem">${date}</td>
      <td style="white-space:normal;min-width:160px">${esc(r.event?.name || '—')}</td>
      <td><span class="rank-badge ${cls}">#${r.rank}</span></td>
      <td>${r.wins ?? '—'}–${r.losses ?? '—'}–${r.ties ?? '—'}</td>
      <td style="color:var(--text-muted);font-size:.8rem">${pts || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="stats-section">
      <div class="section-title">Event Rankings</div>
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
  const driverWorldRank = driver.length ? Math.min(...driver.map(s => s.rank).filter(n => n != null)) : null;
  const progWorldRank   = prog.length   ? Math.min(...prog.map(s => s.rank).filter(n => n != null))   : null;
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
  const items = awards.map(a => `
    <div class="award-item">
      <div class="award-title">🏆 ${esc(a.title)}</div>
      <div class="award-event-name">${esc(a.event?.name || '—')}</div>
    </div>`).join('');
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
