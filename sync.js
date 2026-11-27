const { createClient } = require('@supabase/supabase-js');

const SHARPAPI_KEY = process.env.SHARPAPI_KEY;
const PANDASCORE_KEY = process.env.PANDASCORE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gwluwyobukouxylviskn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_KEY');
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
  if (!res.ok) throw new Error(`SharpAPI HTTP ${res.status} on ${path}: ${text.slice(0, 150)}`);
  return JSON.parse(text);
}

async function fetchPanda(path) {
  const res = await fetch(`https://api.pandascore.co${path}`, {
    headers: {
      Authorization: `Bearer ${PANDASCORE_KEY}`,
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PandaScore HTTP ${res.status} on ${path}: ${text.slice(0, 150)}`);
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

// Отсекаем из SharpAPI весь киберспорт и виртуальные симуляторы
function isExcludedFromSharp(sportName = '', leagueName = '', eventName = '') {
  const s = `${sportName} ${leagueName} ${eventName}`.toLowerCase();
  return (
    s.includes('esport') ||
    s.includes('esoccer') ||
    s.includes('efootball') ||
    s.includes('ebasketball') ||
    s.includes('ehockey') ||
    s.includes('etennis') ||
    s.includes('gg league') ||
    s.includes('battle') ||
    s.includes('fifa') ||
    s.includes('nba 2k') ||
    s.includes('nba2k') ||
    s.includes('counter') ||
    s.includes('cs2') ||
    s.includes('csgo') ||
    s.includes('dota') ||
    s.includes('valorant') ||
    s.includes('league of legends')
  );
}

function mapClassicCategory(sportName = '', leagueName = '') {
  const s = `${sportName} ${leagueName}`.toLowerCase();
  if (s.includes('football') && !s.includes('american') && !s.includes('aussie')) return 'Футбол';
  if (s.includes('soccer') || s.includes('copa') || s.includes('liga') || s.includes('premier') || s.includes('uefa') || s.includes('serie a') || s.includes('bundesliga')) return 'Футбол';
  if (s.includes('hockey') || s.includes('nhl') || s.includes('khl')) return 'Хоккей';
  if (s.includes('basket') || s.includes('nba') || s.includes('euroleague')) return 'Баскетбол';
  if (s.includes('tennis') || s.includes('atp') || s.includes('wta')) return 'Теннис';
  if (s.includes('mma') || s.includes('ufc') || s.includes('box')) return 'MMA / Бокс';
  if (s.includes('baseball') || s.includes('mlb')) return 'Бейсбол';
  if (s.includes('american_football') || s.includes('nfl') || s.includes('ncaa')) return 'Амер. футбол';
  if (s.includes('cricket')) return 'Крикет';
  if (s.includes('rugby')) return 'Регби';
  return 'Спорт';
}

function inferFormat(category = '', tournamentName = '') {
  const t = String(tournamentName).toLowerCase();
  if (t.includes('bo5')) return 'BO5';
  if (t.includes('bo1')) return 'BO1';
  if (t.includes('bo3')) return 'BO3';
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
  if (Number.isFinite(n) && n > 1.01 && n < 50) return Number(n.toFixed(2));
  return null;
}

function computeEsportsOdds(matchId, team1Id, team2Id, numberOfGames = 3) {
  const seed = Math.abs((Number(matchId) * 2654435761 + Number(team1Id || 1) * 31 - Number(team2Id || 2) * 17) % 1000);
  const spread = numberOfGames === 1 ? 0.16 : 0.22;
  const p1Prob = 0.5 - spread + (seed / 1000) * (spread * 2);
  const p2Prob = 1 - p1Prob;
  const margin = 1.06;

  const p1 = Math.max(1.18, Math.min(4.8, Number((margin / p1Prob).toFixed(2))));
  const p2 = Math.max(1.18, Math.min(4.8, Number((margin / p2Prob).toFixed(2))));
  return { p1, p2 };
}

// 1. PandaScore: ТОЛЬКО CS2, Dota 2, Valorant и League of Legends
async function fetchPandaEsports() {
  if (!PANDASCORE_KEY) {
    console.warn('PANDASCORE_KEY is missing, skipping esports.');
    return [];
  }

  const endpoints = [
    { path: '/csgo/matches/upcoming?sort=begin_at&per_page=30', category: 'CS2', prefix: 'cs2' },
    { path: '/dota2/matches/upcoming?sort=begin_at&per_page=25', category: 'Dota 2', prefix: 'dota2' },
    { path: '/valorant/matches/upcoming?sort=begin_at&per_page=20', category: 'Valorant', prefix: 'val' },
    { path: '/lol/matches/upcoming?sort=begin_at&per_page=20', category: 'LoL', prefix: 'lol' }
  ];

  const results = [];

  for (const ep of endpoints) {
    try {
      const list = await fetchPanda(ep.path);
      console.log(`PandaScore ${ep.category}: fetched ${list.length} upcoming matches.`);

      for (const m of list) {
        const opp1 = m.opponents?.[0]?.opponent;
        const opp2 = m.opponents?.[1]?.opponent;
        if (!opp1?.name || !opp2?.name) continue;
        if (opp1.name.toUpperCase() === 'TBD' || opp2.name.toUpperCase() === 'TBD') continue;

        const startTime = m.begin_at || m.scheduled_at;
        if (!startTime) continue;

        const leagueName = m.league?.name || '';
        const serieName = m.serie?.full_name || m.serie?.name || '';
        const tournament = [leagueName, serieName].filter(Boolean).join(' — ') || `${ep.category} Tournament`;

        const gamesCount = Number(m.number_of_games) || 3;
        const format = gamesCount === 1 ? 'BO1' : gamesCount === 5 ? 'BO5' : gamesCount === 2 ? 'BO2' : 'BO3';
        const { p1, p2 } = computeEsportsOdds(m.id, opp1.id, opp2.id, gamesCount);

        results.push({
          id: `ps_${ep.prefix}_${m.id}`,
          external_id: `ps_${m.id}`,
          title: `${opp1.name} vs ${opp2.name}`,
          category: ep.category,
          tournament,
          format,
          start_time: startTime,
          status: 'prematch',
          outcomes: [
            { name: 'П1', odd: p1 },
            { name: 'П2', odd: p2 }
          ],
          extra_markets: []
        });
      }
    } catch (err) {
      console.warn(`PandaScore ${ep.category} error: ${err.message}`);
    }
    await sleep(250);
  }

  return results;
}

// 2. SharpAPI: ТОЛЬКО обычный спорт (футбол, баскетбол, хоккей, теннис и др., без киберспорта)
async function fetchSharpClassicSports() {
  if (!SHARPAPI_KEY) return [];

  const eventsTimeMap = new Map();
  try {
    const rawEvents = await fetchSharp('/events?limit=500');
    for (const ev of extractArray(rawEvents)) {
      const id = String(ev.id ?? ev.event_id ?? '');
      const start = ev.start_time || ev.commence_time || ev.starts_at || ev.date || null;
      if (id && start) eventsTimeMap.set(id, start);
    }
  } catch (err) {
    console.warn('SharpAPI /events warn:', err.message);
  }

  await sleep(250);

  let oddsList = [];
  try {
    const rawOdds = await fetchSharp('/odds/best?market_type=moneyline&limit=600');
    oddsList = extractArray(rawOdds);
  } catch (err) {
    console.warn('SharpAPI /odds/best warn:', err.message);
    return [];
  }

  const grouped = new Map();

  for (const item of oddsList) {
    const market = String(item.market_type ?? '').toLowerCase();
    if (market.includes('spread') || market.includes('handicap') || market.includes('total') || market.includes('over') || market.includes('under')) {
      continue;
    }
    if (item.is_main_line === false) continue;
    if (isExcludedFromSharp(item.sport, item.league, item.event_name)) continue;

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

  const results = [];
  for (const [evId, g] of grouped.entries()) {
    if (!g.p1 || !g.p2) continue;

    const tournament = formatLeagueName(g.league || g.sport || 'Турнир');
    const category = mapClassicCategory(g.sport, g.league);
    const outcomes = [{ name: 'П1', odd: g.p1 }];
    if (g.draw) outcomes.push({ name: 'Х', odd: g.draw });
    outcomes.push({ name: 'П2', odd: g.p2 });

    results.push({
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

  return results;
}

(async function main() {
  try {
    const esportsMatches = await fetchPandaEsports();
    const classicMatches = await fetchSharpClassicSports();

    const combined = [...esportsMatches, ...classicMatches].slice(0, 150);
    if (combined.length === 0) {
      console.log('No matches to sync.');
      return;
    }

    const { error } = await sb.rpc('admin_upsert_events', { p_events: combined });
    if (error) {
      throw new Error('Supabase admin_upsert_events error: ' + error.message);
    }
    console.log(`Synced ${combined.length} total matches (Esports [CS2/Dota2/Val/LoL]: ${esportsMatches.length}, Classic Sports: ${classicMatches.length}).`);
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
})();
