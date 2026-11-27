const { createClient } = require('@supabase/supabase-js');

const SHARPAPI_KEY = process.env.SHARPAPI_KEY;
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

async function fetchGamma(path) {
  const res = await fetch(`https://gamma-api.polymarket.com${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'BetLove-Sync/1.0'
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gamma API HTTP ${res.status} on ${path}: ${text.slice(0, 150)}`);
  return JSON.parse(text);
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  return raw.data || raw.events || raw.odds || raw.items || [];
}

function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function priceToOdd(priceRaw) {
  const p = Number(priceRaw);
  if (!Number.isFinite(p) || p <= 0.01 || p >= 0.99) return null;
  const odd = Number((1 / p).toFixed(2));
  return odd >= 1.02 && odd <= 50 ? odd : null;
}

function detectEsportsCategory(raw = '') {
  const s = String(raw).toLowerCase();
  if (s.includes('counter-strike') || s.includes('counter strike') || /\bcs2\b|\bcsgo\b/.test(s)) return 'CS2';
  if (s.includes('dota')) return 'Dota 2';
  if (s.includes('valorant')) return 'Valorant';
  if (s.includes('league of legends') || s.includes('league-of-legends') || /\blol\b/.test(s)) return 'LoL';
  return null;
}

function parseMatchTitle(title = '') {
  const clean = String(title)
    .replace(/^.*?(?:CS2|Dota 2|Valorant|LoL|Counter-Strike)\s*:\s*/i, '')
    .replace(/\s*\((?:BO\d|Best of \d)\)\s*/gi, '')
    .trim();

  const parts = clean.split(/\s+(?:vs\.?|v\.?|—|-)\s+/i);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { team1: parts[0].trim(), team2: parts[1].trim() };
  }
  return null;
}

// 1. Polymarket Gamma API: живые рыночные коэффициенты для CS2, Dota 2, Valorant и LoL (без ключа)
async function fetchPolymarketEsports() {
  const tagQueries = new Map(); // tagId -> category

  try {
    const sports = await fetchGamma('/sports');
    for (const sp of extractArray(sports)) {
      const label = `${sp.sport || ''} ${sp.label || ''} ${sp.slug || ''}`;
      const cat = detectEsportsCategory(label);
      if (cat && sp.tags) {
        const tagList = String(sp.tags).split(',').map((t) => t.trim()).filter(Boolean);
        for (const t of tagList) {
          if (/^\d+$/.test(t)) tagQueries.set(t, cat);
        }
      }
    }
  } catch (err) {
    console.warn('Gamma /sports warn:', err.message);
  }

  // Резервные слаги на случай, если /sports не отдал теги
  const fallbackSlugs = [
    { slug: 'cs2', category: 'CS2' },
    { slug: 'counter-strike-2', category: 'CS2' },
    { slug: 'dota-2', category: 'Dota 2' },
    { slug: 'valorant', category: 'Valorant' },
    { slug: 'league-of-legends', category: 'LoL' }
  ];

  const rawEventsMap = new Map();

  for (const [tagId, cat] of tagQueries.entries()) {
    try {
      const list = await fetchGamma(`/events?tag_id=${tagId}&active=true&closed=false&limit=100`);
      for (const ev of extractArray(list)) {
        rawEventsMap.set(String(ev.id), { ev, hintCategory: cat });
      }
    } catch (err) {
      console.warn(`Gamma tag_id=${tagId} warn:`, err.message);
    }
    await sleep(150);
  }

  for (const fb of fallbackSlugs) {
    try {
      const list = await fetchGamma(`/events?tag_slug=${fb.slug}&active=true&closed=false&limit=100`);
      for (const ev of extractArray(list)) {
        if (!rawEventsMap.has(String(ev.id))) {
          rawEventsMap.set(String(ev.id), { ev, hintCategory: fb.category });
        }
      }
    } catch (err) {
      console.warn(`Gamma tag_slug=${fb.slug} warn:`, err.message);
    }
    await sleep(150);
  }

  const results = [];

  for (const [evId, { ev, hintCategory }] of rawEventsMap.entries()) {
    const title = String(ev.title || '').trim();
    const tagsText = (ev.tags || []).map((t) => `${t.label || ''} ${t.slug || ''}`).join(' ');
    const category = detectEsportsCategory(`${title} ${ev.slug || ''} ${tagsText}`) || hintCategory;
    if (!category) continue;

    // Отсекаем долгосрочные аутрайты ("Who will win the Major?"), берём только матчи X vs Y
    const teams = parseMatchTitle(title);
    if (!teams) continue;

    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    // Ищем главный рынок победителя матча (где 2 исхода: команда 1 и команда 2)
    let mainMarket = markets.find((m) => {
      if (m.closed) return false;
      const outcomes = parseJsonArray(m.outcomes);
      const prices = parseJsonArray(m.outcomePrices);
      return outcomes.length === 2 && prices.length === 2 && !/map|handicap|total|over|under|kill/i.test(m.question || '');
    });

    if (!mainMarket) {
      mainMarket = markets.find((m) => {
        if (m.closed) return false;
        const outcomes = parseJsonArray(m.outcomes);
        const prices = parseJsonArray(m.outcomePrices);
        return outcomes.length === 2 && prices.length === 2;
      });
    }

    if (!mainMarket) continue;

    const outcomesArr = parseJsonArray(mainMarket.outcomes);
    const pricesArr = parseJsonArray(mainMarket.outcomePrices);

    let p1 = priceToOdd(pricesArr[0]);
    let p2 = priceToOdd(pricesArr[1]);

    // Сверяем порядок исходов с названиями команд в заголовке
    const out0 = String(outcomesArr[0] || '').toLowerCase();
    const out1 = String(outcomesArr[1] || '').toLowerCase();
    const t1Low = teams.team1.toLowerCase();
    const t2Low = teams.team2.toLowerCase();

    if ((out0.includes(t2Low) || t2Low.includes(out0)) && (out1.includes(t1Low) || t1Low.includes(out1))) {
      [p1, p2] = [p2, p1];
    }

    if (!p1 || !p2) continue;

    const startTime = ev.startTime || ev.endDate || new Date(Date.now() + 7200000).toISOString();
    const seriesTitle = ev.series?.[0]?.title || ev.ticker || `${category} Pro Match`;
    const formatMatch = `${title} ${mainMarket.question || ''}`.match(/\bBO[1235]\b/i);
    const format = formatMatch ? formatMatch[0].toUpperCase() : 'BO3';

    results.push({
      id: `pm_${category.toLowerCase().replace(/\s+/g, '')}_${evId}`,
      external_id: `pm_${evId}`,
      title: `${teams.team1} vs ${teams.team2}`,
      category,
      tournament: String(seriesTitle).trim(),
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

  console.log(`Polymarket Esports: synced ${results.length} real matches (CS2/Dota2/Val/LoL).`);
  return results;
}

function formatLeagueName(raw = '') {
  return String(raw)
    .replace(/_-_/g, ' — ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

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

// 2. SharpAPI: реальный классический спорт
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

  console.log(`SharpAPI Classic Sports: synced ${results.length} real matches.`);
  return results;
}

(async function main() {
  try {
    const esportsMatches = await fetchPolymarketEsports();
    const classicMatches = await fetchSharpClassicSports();

    const combined = [...esportsMatches, ...classicMatches].slice(0, 160);
    if (combined.length === 0) {
      console.log('No matches to sync.');
      return;
    }

    const { error } = await sb.rpc('admin_upsert_events', { p_events: combined });
    if (error) {
      throw new Error('Supabase admin_upsert_events error: ' + error.message);
    }
    console.log(`Synced ${combined.length} total matches (Polymarket Esports: ${esportsMatches.length}, SharpAPI Sports: ${classicMatches.length}).`);
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
})();
