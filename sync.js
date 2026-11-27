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

async function tryFetch(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${SHARPAPI_KEY}`,
      'x-api-key': SHARPAPI_KEY,
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
  }
  return JSON.parse(text);
}

function mapCategory(sportName = '', leagueName = '') {
  const s = `${sportName} ${leagueName}`.toLowerCase();
  if (s.includes('counter') || s.includes('cs2') || s.includes('cs:go')) return 'CS2';
  if (s.includes('dota')) return 'Dota 2';
  if (s.includes('football') || s.includes('soccer')) return 'Футбол';
  if (s.includes('hockey')) return 'Хоккей';
  if (s.includes('basket')) return 'Баскетбол';
  if (s.includes('tennis')) return 'Теннис';
  if (s.includes('mma') || s.includes('ufc') || s.includes('box')) return 'MMA / Бокс';
  return 'Другое';
}

function inferFormat(category = '', tournamentName = '') {
  const t = String(tournamentName).toLowerCase();
  if (t.includes('bo5') || t.includes('best of 5')) return 'BO5';
  if (t.includes('bo1') || t.includes('best of 1')) return 'BO1';
  if (t.includes('bo3') || t.includes('best of 3')) return 'BO3';

  if (category === 'CS2' || category === 'Dota 2') return 'BO3';
  if (category === 'Теннис') return 'Сеты';
  return 'Матч';
}

function extractOutcomesFromEvent(ev) {
  const prices = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rawPrice = node.price ?? node.odds ?? node.decimal;
    if (typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 1) {
      if (node.active !== false) {
        prices.push(Number(rawPrice.toFixed(2)));
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ev);

  if (prices.length >= 2) {
    return [
      { name: 'П1', odd: prices[0] },
      { name: 'П2', odd: prices[1] }
    ];
  }
  return null;
}

async function syncUpcomingFixtures() {
  const base = 'https://api.sharpapi.io/api/v1';
  const candidateUrls = [
    `${base}/odds`,
    `${base}/events`,
    `${base}/fixtures`,
    `${base}/games`,
    `${base}/matches`,
    `${base}/sports`,
    `${base}/bookmakers`
  ];

  let rawData = null;
  let workingUrl = '';

  for (const url of candidateUrls) {
    try {
      rawData = await tryFetch(url);
      workingUrl = url;
      console.log(`Working endpoint found: ${workingUrl}`);
      break;
    } catch (err) {
      console.log(`Probe ${url} -> ${err.message}`);
    }
    await sleep(300);
  }

  if (!rawData) {
    throw new Error('None of the candidate SharpAPI endpoints responded with 200 OK.');
  }

  console.log('Sample response:', JSON.stringify(rawData).slice(0, 600));

  const list = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData.data)
      ? rawData.data
      : Array.isArray(rawData.events)
        ? rawData.events
        : [];

  if (list.length === 0) {
    console.log('Response did not contain an event array directly.');
    return;
  }

  const payload = [];
  for (const ev of list.slice(0, 20)) {
    const outcomes = extractOutcomesFromEvent(ev);
    if (!outcomes) continue;

    const extId = String(ev.id ?? ev.eventId ?? ev.gameId ?? '');
    if (!extId) continue;

    const p1 = ev.homeTeam || ev.home_team || ev.team1 || ev.participant1 || 'Команда 1';
    const p2 = ev.awayTeam || ev.away_team || ev.team2 || ev.participant2 || 'Команда 2';
    const sportName = ev.sport || ev.sportName || ev.sport_title || '';
    const tournament = ev.league || ev.tournament || ev.leagueName || sportName || 'Турнир';
    const category = mapCategory(sportName, tournament);

    payload.push({
      id: 'ext_' + extId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      external_id: extId,
      title: `${p1} vs ${p2}`,
      category,
      tournament,
      format: inferFormat(category, tournament),
      start_time: ev.startTime || ev.commence_time || ev.start_time || new Date(Date.now() + 3600000).toISOString(),
      status: 'prematch',
      outcomes,
      extra_markets: []
    });
  }

  if (payload.length === 0) {
    console.log('No events with real odds extracted yet — check Sample response in logs.');
    return;
  }

  const { error } =
