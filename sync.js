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

function mapCategory(sportName = '', leagueName = '') {
  const s = `${sportName} ${leagueName}`.toLowerCase();
  if (s.includes('counter') || s.includes('cs2') || s.includes('cs:go') || s.includes('csgo') || s.includes('esport')) return 'CS2';
  if (s.includes('dota')) return 'Dota 2';
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
  if (category === 'CS2' || category === 'Dota 2') return 'BO3';
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

async function discoverEsportsKeys() {
  const keys = new Set(['esports', 'cs2', 'dota2', 'counter-strike']);
  try {
    const raw = await fetchSharp('/sports');
    const list = extractArray(raw);
    console.log('Available /sports:', JSON.stringify(list).slice(0, 700));
    for (const s of list) {
      const id = String(s.id ?? s.key ?? s.slug ?? s.name ?? '').toLowerCase();
      if (id.includes('esport') || id.includes('cs') || id.includes('counter') || id.includes('dota') || id.includes('gaming')) {
        keys.add(String(s.id ?? s.key ?? s.slug ?? s.name));
      }
    }
  } catch (err) {
    console.warn('Could not fetch /sports:', err.message);
  }
  return Array.from(keys);
}

async function fetchAllOdds(esportsKeys) {
  const all = [];
  const urls = [];

  for (const sport of esportsKeys) {
    urls.push(`/odds/best?sport=${encodeURIComponent(sport)}&limit=300`);
  }
  urls.push('/odds/best?market_type=moneyline&limit=500');
  urls.push('/odds/best?limit=500');

  for (const u of urls) {
    try {
      const raw = await fetchSharp(u);
      const list = extractArray(raw);
      all.push(...list);
      console.log(`Fetched ${list.length} rows from ${u}`);
    } catch (err) {
      console.warn(`Skip ${u}: ${err.message}`);
    }
    await sleep(250);
  }
  return all;
}

async function syncUpcomingFixtures() {
  const esportsKeys = await discoverEsportsKeys();
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

  const oddsList = await fetchAllOdds(esportsKeys);
  console.log(`Total odds entries collected: ${oddsList.length}`);

  const grouped = new Map();

  for (const item of oddsList) {
    const market = String(item.market_type ?? '').toLowerCase();
    if (market.includes('spread') || market.includes('handicap') || market.includes('total') || market.includes('over') || market.includes('under')) {
      continue;
    }
    if (item.is_main_line === false) continue;

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

  // Киберспорт ставим в начало списка, чтобы не обрезался лимитом батча
  payload.sort((a, b) => {
    const aEsp = a.category === 'CS2' || a.category === 'Dota 2' ? 0 : 1;
    const bEsp = b.category === 'CS2' || b.category === 'Dota 2' ? 0 : 1;
    return aEsp - bEsp;
  });

  if (payload.length === 0) {
    console.log('No complete moneyline matches assembled.');
    return;
  }

  const batch = payload.slice(0, 120);
  const { error } = await sb.rpc('admin_upsert_events', { p_events: batch });
  if (error) {
    throw new Error('Supabase admin_upsert_events error: ' + error.message);
  }
  console.log(`Synced ${batch.length} matches (CS2/Dota prioritized).`);
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
