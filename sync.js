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
  return raw.data || raw.events || raw.odds || raw.items || [];
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
  if (s.includes('counter') || s.includes('cs2') || s.includes('cs:go') || s.includes('esport')) return 'CS2';
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

async function fetchAllOdds() {
  const all = [];
  // Пробуем забрать до 3 страниц или большой лимит с фильтром по moneyline
  const urls = [
    '/odds/best?market_type=moneyline&limit=500',
    '/odds/best?market_type=moneyline&limit=500&offset=500',
    '/odds/best?limit=500'
  ];

  for (const u of urls) {
    try {
      const raw = await fetchSharp(u);
      const list = extractArray(raw);
      all.push(...list);
      console.log(`Fetched ${list.length} rows from ${u}`);
      if (list.length < 100 && u.includes('offset=500')) break;
    } catch (err) {
      console.warn(`Skip ${u}: ${err.message}`);
    }
    await sleep(300);
  }
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
    console.log(`Loaded ${eventsTimeMap.size} event timestamps from /events.`);
  } catch (err) {
    console.warn('Could not load /events:', err.message);
  }

  await sleep(300);

  const oddsList = await fetchAllOdds();
  console.log(`Total odds entries collected: ${oddsList.length}`);

  const grouped = new Map();

  for (const item of oddsList) {
    const market = String(item.market_type ?? '').toLowerCase();
    if (market !== 'moneyline' && market !== 'h2h' && market !== '1x2' && market !== 'winner') continue;
    if (item.is_main_line === false) continue;

    const evId = String(item.event_id ?? '');
    if (!evId) continue;
