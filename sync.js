const { createClient } = require('@supabase/supabase-js');

const SHARPAPI_KEY = process.env.SHARPAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gwluwyobukouxylviskn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SHARPAPI_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SHARPAPI_KEY or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSharp(path) {
  const res = await fetch(`https://api.sharpapi.io/api/v1${path}`, {
    headers: {
      'X-API-Key': SHARPAPI_KEY,
      Authorization: `Bearer ${SHARPAPI_KEY}`,
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  return raw.data || raw.events || raw.odds || raw.sports || raw.items || [];
}

function formatLeagueName(raw = '') {
  return String(raw)
    .replace(/_-_/g, ' — ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function isVirtualSportsSim(sportName = '', leagueName = '', eventName = '') {
  const s = `${sportName} ${leagueName} ${eventName}`.toLowerCase();
  return (
    s.includes('esoccer') ||
    s.includes('efootball') ||
    s.includes('ebasketball') ||
    s.includes('ehockey') ||
    s.includes('etennis') ||
    s.includes('gg league') ||
    s.includes('battle') ||
    s.includes('fifa') ||
    s.includes('nba 2k') ||
    s.includes('nba2k')
  );
}

function mapCategory(sportName = '', leagueName = '') {
  const s = `${sportName} ${leagueName}`.toLowerCase();
  if (s.includes('counter') || s.includes('cs2') || s.includes('cs:go') || s.includes('csgo') || s.includes('blast') || s.includes('esl') || s.includes('iem') || s.includes('pgl') || s.includes('cct')) return 'CS2';
  if (s.includes('dota') || s.includes('dreamleague') || s.includes('international')) return 'Dota 2';
  if (s.includes('valorant') || s.includes('lol') || s.includes('league of legends') || s.includes('esport')) return 'Киберспорт';
  if (s.includes('football') || s.includes('soccer') || s.includes('copa') || s.includes('liga') || s.includes('premier')) return 'Футбол';
  if (s.includes('hockey') || s.includes('nhl') || s.includes('khl')) return 'Хоккей';
  if (s.includes('basket') || s.includes('nba')) return 'Баскетбол';
  if (s.includes('tennis') || s.includes('atp') || s.includes('wta')) return 'Теннис';
  if (s.includes('mma') || s.includes('ufc') || s.includes('box')) return 'MMA / Бокс';
  return 'Другое';
}

function inferFormat(category = '', tournamentName = '') {
  const t = String(tournamentName).toLowerCase();
  if (t.includes('bo5')) return 'BO5';
  if (t.includes('bo1')) return 'BO1';
  if (t.includes('bo3')) return 'BO3';
  if (category === 'CS2' || category === 'Dota 2' || category === 'Киберспорт') return 'BO3';
  if (category === 'Теннис') return 'Сеты';
  return 'Матч';
}

function parseTeams(eventName = '') {
  const str = String(eventName).trim();
  if (!str) return null;
  if (str.includes(' @ ')) {
    const [away, home] = str.split(' @ ').map((s) => s.trim());
    if (home && away) return { team1: home, team2: away };
  }
  const vsMatch = str.split(/\s+(?:vs\.?|v\.?|-)\s+/i);
  if (vsMatch.length === 2 && vsMatch[0] && vsMatch[1]) {
    return { team1: vsMatch[0].trim(), team2: vsMatch[1].trim() };
  }
  return null;
}

function getDecimalOdd(item) {
  const raw =
    item?.best_odds?.decimal ??
    item?.consensus_odds?.decimal ??
    item?.decimal ??
    item?.odds?.decimal;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 1.01 && n < 50) {
    return Number(n.toFixed(2));
  }
  return null;
}

async function fetchAllOdds() {
  const all = [];
  const urls = [
    '/odds/best?sport=esports&limit=1000',
    '/odds/best?sport=cs2&limit=500',
    '/odds/best?sport=dota2&limit=500',
    '/odds/best?market_type=moneyline&limit=500'
  ];

  const seenEsportsLeagues = new Set();

  for (const u of urls) {
    try {
      const raw = await fetchSharp(u);
      const list = extractArray(raw);
      all.push(...list);
      for (const item of list) {
        if (String(item.sport || '').toLowerCase().includes('esport') && item.league) {
          seenEsportsLeagues.add(item.league);
        }
      }
      console.log(`Fetched ${list.length} rows from ${u}`);
    } catch (err) {
      console.warn(`Skip ${u}: ${err.message}`);
    }
    await sleep(250);
  }

  console.log('Esports leagues in SharpAPI:', Array.from(seenEsportsLeagues).join(', ') || 'none');
  return all;
}

async function syncUpcomingFixtures() {
  const eventsTimeMap = new Map();
  try {
    const rawEvents = await fetchSharp('/events?limit=500');
    for (const ev of extractArray(rawEvents)) {
      const id = String(ev.id ?? ev.event_id ?? '');
      const start = ev.start_time || ev.commence_time || ev.starts_at || ev.date || null;
      if (id && start) eventsTimeMap.set(id, start);
    }
  } catch (err) {
    console.warn('Could not load /events:', err.message);
  }

  await sleep(250);

  const oddsList = await fetchAllOdds();
  const grouped = new Map();

  for (const item of oddsList) {
    const market = String(item.market_type ?? '').toLowerCase();
    if (market.includes('spread') || market.includes('handicap') || market.includes('total') || market.includes('over') || market.includes('under')) {
      continue;
    }
    if (item.is_main_line === false) continue;

    if (isVirtualSportsSim(item.sport, item.league, item.event_name)) continue;

    const evId = String(item.event_id ?? '');
    if (!evId) continue;

    const teams = parseTeams(item.event_name);
    if (!teams) continue;

    const odd = getDecimalOdd(item);
    if (!odd) continue;

    if (!grouped.has(evId)) {
      grouped.set(evId, {
        team1: teams.team1,
        team2: teams.team2,
        sport: item.sport || '',
        league: item.league || '',
        start_time: item.start_time || eventsTimeMap.get(evId) || null,
        p1: null,
        p2: null,
        draw: null
      });
    }

    const entry = grouped.get(evId);
    const sel = String(item.selection ?? '').trim().toLowerCase();
    const t1 = entry.team1.toLowerCase();
    const t2 = entry.team2.toLowerCase();

    if (sel === t1 || sel.includes(t1) || t1.includes(sel)) {
      entry.p1 = odd;
    } else if (sel === t2 || sel.includes(t2) || t2.includes(sel)) {
      entry.p2 = odd;
    } else if (sel === 'draw' || sel === 'tie' || sel === 'x') {
      entry.draw = odd;
    }
  }

  const payload = [];
  for (const [evId, g] of grouped.entries()) {
    if (!g.p1 || !g.p2) continue;

    const tournament = formatLeagueName(g.league || g.sport || 'Турнир');
    const category = mapCategory(g.sport, g.league);
    const outcomes = [{ name: 'П1', odd: g.p1 }];
    if (g.draw) outcomes.push({ name: 'Х', odd: g.draw });
    outcomes.push({ name: 'П2', odd: g.p2 });

    payload.push({
      id: 'ext_' + evId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      external_id: evId,
      title: `${g.team1} vs ${g.team2}`,
      category,
      tournament,
      format: inferFormat(category, tournament),
      start_time: g.start_time || new Date(Date.now() + 7200000).toISOString(),
      status: 'prematch',
      outcomes,
      extra_markets: []
    });
  }

  payload.sort((a, b) => {
    const rank = (c) => (c === 'CS2' ? 0 : c === 'Dota 2' ? 1 : c === 'Киберспорт' ? 2 : 3);
    return rank(a.category) - rank(b.category);
  });

  if (payload.length === 0) {
    console.log('No complete matches assembled.');
    return;
  }

  const batch = payload.slice(0, 120);
  const { error } = await sb.rpc('admin_upsert_events', { p_events: batch });
  if (error) {
    throw new Error('Supabase admin_upsert_events error: ' + error.message);
  }
  console.log(`Synced ${batch.length} real matches (virtual e-sports sims excluded).`);
}

(async function main() {
  try {
    await syncUpcomingFixtures();
    console.log('Sync completed successfully.');
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
})();
