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
  if (s.includes('football') || s.includes('soccer') || s.includes('copa') || s.includes('liga')) return 'Футбол';
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

function toDecimalOdd(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  if (n > 1.01 && n < 50) return Number(n.toFixed(2));
  if (n >= 100) return Number((1 + n / 100).toFixed(2));
  if (n <= -100) return Number((1 + 100 / Math.abs(n)).toFixed(2));
  return null;
}

function isMoneylineMarket(marketStr = '') {
  const m = String(marketStr).toLowerCase();
  if (!m) return true;
  if (m.includes('spread') || m.includes('handicap') || m.includes('total') || m.includes('over') || m.includes('under')) {
    return false;
  }
  return m.includes('moneyline') || m.includes('h2h') || m.includes('winner') || m.includes('1x2') || m.includes('match');
}

async function syncUpcomingFixtures() {
  // 1. Загружаем справочник событий с реальными именами команд и временем старта
  const eventsMap = new Map();
  try {
    const rawEvents = await fetchSharp('/events?limit=100');
    const evList = extractArray(rawEvents);
    if (evList[0]) {
      console.log('Sample /events item:', JSON.stringify(evList[0]).slice(0, 400));
    }
    for (const ev of evList) {
      const id = String(ev.id ?? ev.event_id ?? '');
      if (!id) continue;
      eventsMap.set(id, {
        home: ev.home_team || ev.home_name || ev.team_1 || ev.participant_1 || '',
        away: ev.away_team || ev.away_name || ev.team_2 || ev.participant_2 || '',
        sport: ev.sport || ev.sport_name || ev.sport_key || '',
        league: ev.league || ev.league_name || ev.tournament || '',
        start_time: ev.start_time || ev.commence_time || ev.starts_at || null
      });
    }
    console.log(`Loaded ${eventsMap.size} events metadata from /events.`);
  } catch (err) {
    console.warn('Could not load /events:', err.message);
  }

  await sleep(350);

  // 2. Загружаем котировки
  let rawOdds = null;
  for (const endpoint of ['/odds/best?limit=100', '/odds/snapshot?limit=100']) {
    try {
      rawOdds = await fetchSharp(endpoint);
      console.log(`Loaded odds from ${endpoint}`);
      break;
    } catch (err) {
      console.warn(`Skip ${endpoint}: ${err.message}`);
    }
  }

  if (!rawOdds) throw new Error('Failed to fetch odds from SharpAPI');

  const oddsList = extractArray(rawOdds);
  if (oddsList[0]) {
    console.log('Sample odds item:', JSON.stringify(oddsList[0]).slice(0, 500));
  }

  // Группируем исходы по event_id, разделяя П1 (home) и П2 (away)
  const grouped = new Map();

  for (const item of oddsList) {
    const evId = String(item.event_id ?? item.id ?? '');
    if (!evId) continue;

    const meta = eventsMap.get(evId) || {};
    const homeName = item.home_team || meta.home || '';
    const awayName = item.away_team || meta.away || '';
    const marketName = item.market_type || item.market || item.market_key || '';

    if (!isMoneylineMarket(marketName)) continue;

    if (!grouped.has(evId)) {
      grouped.set(evId, {
        homeName,
        awayName,
        sport: item.sport || meta.sport || '',
        league: item.league || meta.league || '',
        start_time: item.start_time || meta.start_time || null,
        p1: null,
        p2: null,
        draw: null
      });
    }
    const entry = grouped.get(evId);
    if (!entry.homeName && homeName) entry.homeName = homeName;
    if (!entry.awayName && awayName) entry.awayName = awayName;

    // Вариант A: плоская запись (одна строка = один исход)
    const oddVal = toDecimalOdd(item.price ?? item.odds ?? item.decimal_odds ?? item.american_odds);
    const side = String(item.side ?? item.selection ?? item.outcome ?? item.outcome_name ?? '').toLowerCase();

    if (oddVal && side) {
      if (side === 'home' || side === '1' || (entry.homeName && side === entry.homeName.toLowerCase())) {
        if (!entry.p1) entry.p1 = oddVal;
      } else if (side === 'away' || side === '2' || (entry.awayName && side === entry.awayName.toLowerCase())) {
        if (!entry.p2) entry.p2 = oddVal;
      } else if (side === 'draw' || side === 'x' || side === 'tie') {
        if (!entry.draw) entry.draw = oddVal;
      }
    }

    // Вариант B: вложенные поля home_odds / away_odds или массив outcomes у одного букмекера
    const hOdd = toDecimalOdd(item.home_odds ?? item.home_price ?? item.p1);
    const aOdd = toDecimalOdd(item.away_odds ?? item.away_price ?? item.p2);
    const dOdd = toDecimalOdd(item.draw_odds ?? item.draw_price);
    if (hOdd && aOdd) {
      entry.p1 = hOdd;
      entry.p2 = aOdd;
      if (dOdd) entry.draw = dOdd;
    }

    if (Array.isArray(item.outcomes) && item.outcomes.length >= 2) {
      for (const o of item.outcomes) {
        const oPrice = toDecimalOdd(o.price ?? o.odds ?? o.decimal);
        const oSide = String(o.side ?? o.name ?? o.label ?? '').toLowerCase();
        if (!oPrice) continue;
        if (oSide === 'home' || oSide === '1' || (entry.homeName && oSide === entry.homeName.toLowerCase())) {
          entry.p1 = oPrice;
        } else if (oSide === 'away' || oSide === '2' || (entry.awayName && oSide === entry.awayName.toLowerCase())) {
          entry.p2 = oPrice;
        } else if (oSide === 'draw' || oSide === 'x') {
          entry.draw = oPrice;
        }
      }
    }
  }

  const payload = [];
  for (const [evId, g] of grouped.entries()) {
    if (!g.p1 || !g.p2) continue;
    // Пропускаем события без реальных имён команд, чтобы не плодить "Команда 1 vs Команда 2"
    if (!g.homeName || !g.awayName) continue;

    const tournament = formatLeagueName(g.league || g.sport || 'Турнир');
    const category = mapCategory(g.sport, g.league);
    const outcomes = [{ name: 'П1', odd: g.p1 }];
    if (g.draw) outcomes.push({ name: 'Х', odd: g.draw });
    outcomes.push({ name: 'П2', odd: g.p2 });

    payload.push({
      id: 'ext_' + evId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      external_id: evId,
      title: `${g.homeName} vs ${g.awayName}`,
      category,
      tournament,
      format: inferFormat(category, tournament),
      start_time: g.start_time || new Date(Date.now() + 3600000).toISOString(),
      status: 'prematch',
      outcomes,
      extra_markets: []
    });
  }

  if (payload.length === 0) {
    console.log('No matched events with both team names and valid P1/P2 odds — check Sample logs above.');
    return;
  }

  const { error } = await sb.rpc('admin_upsert_events', { p_events: payload.slice(0, 30) });
  if (error) {
    throw new Error('Supabase admin_upsert_events error: ' + error.message);
  }
  console.log(`Synced ${Math.min(payload.length, 30)} matches with real team names and P1/P2 odds.`);
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
