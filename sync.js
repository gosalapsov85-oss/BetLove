const { createClient } = require('@supabase/supabase-js');

const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gwluwyobukouxylviskn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!ODDSPAPI_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('Missing ODDSPAPI_KEY or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function mapCategory(sportName = '', slug = '') {
  const s = `${sportName} ${slug}`.toLowerCase();
  if (s.includes('counter') || s.includes('cs2') || s.includes('cs:go')) return 'CS2';
  if (s.includes('dota')) return 'Dota 2';
  if (s.includes('football') || s.includes('soccer')) return 'Футбол';
  if (s.includes('hockey') || s.includes('ice')) return 'Хоккей';
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

function extractRealOdds(oddsPayload) {
  const bookmakersObj = oddsPayload?.bookmakerOdds;
  if (!bookmakersObj || typeof bookmakersObj !== 'object') return null;

  for (const bmData of Object.values(bookmakersObj)) {
    if (!bmData || bmData.suspended || bmData.bookmakerIsActive === false) continue;
    const markets = bmData.markets;
    if (!markets || typeof markets !== 'object') continue;

    for (const mkt of Object.values(markets)) {
      if (!mkt || mkt.marketActive === false || !mkt.outcomes) continue;
      const list = Object.values(mkt.outcomes)
        .filter((o) => o && o.active !== false && typeof o.price === 'number' && o.price > 1)
        .sort((a, b) => (a.outcomeId ?? 0) - (b.outcomeId ?? 0));

      if (list.length >= 2) {
        return [
          { name: 'П1', odd: Number(list[0].price.toFixed(2)) },
          { name: 'П2', odd: Number(list[1].price.toFixed(2)) }
        ];
      }
    }
  }
  return null;
}

async function syncUpcomingFixtures() {
  const now = new Date();
  const to = new Date(now.getTime() + 48 * 3600 * 1000);
  const url = `https://api.oddspapi.io/v4/fixtures?apiKey=${encodeURIComponent(ODDSPAPI_KEY)}&from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to.toISOString())}&statusId=0&hasOdds=true`;

  const fixtures = await fetchJson(url);
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    console.log('No upcoming fixtures with odds found.');
    return;
  }

  const payload = [];
  for (const fx of fixtures.slice(0, 8)) {
    await sleep(1200);
    const fixtureIdStr = String(fx.fixtureId);
    const oddsUrl = `https://api.oddspapi.io/v4/odds?apiKey=${encodeURIComponent(ODDSPAPI_KEY)}&fixtureId=${encodeURIComponent(fixtureIdStr)}`;

    let outcomes = null;
    try {
      const oddsData = await fetchJson(oddsUrl);
      outcomes = extractRealOdds(oddsData);
    } catch (err) {
      console.warn(`Skip odds for ${fixtureIdStr}: ${err.message}`);
      continue;
    }

    if (!outcomes) continue;

    const p1 = fx.participant1Name || 'Команда 1';
    const p2 = fx.participant2Name || 'Команда 2';
    const category = mapCategory(fx.sportName, fx.tournamentSlug);
    const tournament = fx.tournamentName || 'Турнир';

    payload.push({
      id: 'ext_' + fixtureIdStr.replace(/[^a-zA-Z0-9_-]/g, '_'),
      external_id: fixtureIdStr,
      title: `${p1} vs ${p2}`,
      category,
      tournament,
      format: inferFormat(category, tournament),
      start_time: fx.startTime || new Date(Date.now() + 3600000).toISOString(),
      status: 'prematch',
      outcomes,
      extra_markets: []
    });
  }

  if (payload.length === 0) {
    console.log('No fixtures with usable real odds found.');
    return;
  }

  const { error } = await sb.rpc('admin_upsert_events', { p_events: payload });
  if (error) {
    throw new Error('Supabase admin_upsert_events error: ' + error.message);
  }
  console.log(`Synced ${payload.length} upcoming fixtures with real odds.`);
}

async function settleFinishedFixtures() {
  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const to = new Date().toISOString();
  const url = `https://api.oddspapi.io/v4/fixtures?apiKey=${encodeURIComponent(ODDSPAPI_KEY)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&statusId=2`;

  const finished = await fetchJson(url);
  if (!Array.isArray(finished) || finished.length === 0) {
    console.log('No recently finished fixtures.');
    return;
  }

  const { data: openEvents, error: evErr } = await sb
    .from('events')
    .select('id, external_id, status')
    .neq('status', 'finished')
    .not('external_id', 'is', null);

  if (evErr) throw new Error('Load open events error: ' + evErr.message);
  if (!openEvents || openEvents.length === 0) return;

  const openMap = new Map(openEvents.map((e) => [String(e.external_id), e.id]));

  for (const fx of finished) {
    const localEventId = openMap.get(String(fx.fixtureId));
    if (!localEventId) continue;

    let winnerIndex = -1;
    if (typeof fx.winnerParticipantId === 'number') {
      if (fx.winnerParticipantId === fx.participant1Id) winnerIndex = 0;
      else if (fx.winnerParticipantId === fx.participant2Id) winnerIndex = 1;
    } else if (fx.scores && typeof fx.scores === 'object') {
      const s1 = Number(fx.scores.participant1 ?? fx.scores.home ?? NaN);
      const s2 = Number(fx.scores.participant2 ?? fx.scores.away ?? NaN);
      if (!Number.isNaN(s1) && !Number.isNaN(s2)) {
        if (s1 > s2) winnerIndex = 0;
        else if (s2 > s1) winnerIndex = 1;
      }
    }

    const { error: settleErr } = await sb.rpc('admin_settle_event', {
      p_event_id: localEventId,
      p_winner_index: winnerIndex,
      p_score: ''
    });

    if (settleErr) {
      console.error(`Failed to settle ${localEventId}:`, settleErr.message);
    } else {
      console.log(`Settled ${localEventId} with winnerIndex=${winnerIndex}`);
    }
    await sleep(300);
  }
}

(async function main() {
  try {
    await syncUpcomingFixtures();
    await sleep(2200);
    await settleFinishedFixtures();
    console.log('Sync completed successfully.');
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
})();
  }
})();
