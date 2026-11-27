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
  return raw.data || raw.events || raw.odds || raw.scores || raw.items || [];
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
  if (!Number.isFinite(p) || p <= 0.02 || p >= 0.98) return null;
  // Букмекерская маржа ~7% (множитель 0.93)
  const odd = Number((0.93 / p).toFixed(2));
  return odd >= 1.03 && odd <= 35 ? odd : null;
}

function detectEsportsCategory(raw = '') {
  const s = String(raw).toLowerCase();
  if (s.includes('counter-strike') || s.includes('counter strike') || /\bcs2\b|\bcsgo\b|\bcs-2\b/.test(s)) return 'CS2';
  if (s.includes('dota')) return 'Dota 2';
  if (s.includes('valorant')) return 'Valorant';
  if (s.includes('league of legends') || s.includes('league-of-legends') || /\blol\b/.test(s)) return 'LoL';
  return null;
}

function parseMatchTitle(title = '') {
  let clean = String(title)
    .replace(/^.*?(?:CS2|CS:GO|Dota 2|Valorant|LoL|Counter-Strike(?:\s*2)?)\s*:\s*/i, '')
    .replace(/\s*\((?:BO\d|Best of \d|Map \d)\)\s*/gi, '')
    .trim();

  let extractedTournament = '';
  const dashSplit = clean.split(/\s+[-—]\s+/);
  if (dashSplit.length >= 2 && /\b(?:vs\.?|v\.?)\b/i.test(dashSplit[0])) {
    clean = dashSplit[0].trim();
    extractedTournament = dashSplit.slice(1).join(' — ').trim();
  }

  const parts = clean.split(/\s+(?:vs\.?|v\.?)\s+/i);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return {
      team1: parts[0].trim(),
      team2: parts[1].trim(),
      extractedTournament
    };
  }
  return null;
}

function pickPolymarketMainMarket(ev) {
  const markets = Array.isArray(ev?.markets) ? ev.markets : [];
  let mainMarket = markets.find((m) => {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    const q = String(m.question || '');
    return (
      outcomes.length === 2 &&
      prices.length === 2 &&
      !/map\s*\d|game\s*\d|handicap|spread|total|over|under|kill|round|pistol/i.test(q)
    );
  });

  if (!mainMarket) {
    mainMarket = markets.find((m) => {
      const outcomes = parseJsonArray(m.outcomes);
      const prices = parseJsonArray(m.outcomePrices);
      return outcomes.length === 2 && prices.length === 2;
    });
  }
  return mainMarket || null;
}

// 1. Polymarket Gamma API: живые рыночные коэффициенты с маржой для CS2, Dota 2, Valorant и LoL
async function fetchPolymarketEsports() {
  const tagQueries = new Map();

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

  const fallbackSlugs = [
    { slug: 'counter-strike', category: 'CS2' },
    { slug: 'counter-strike-2', category: 'CS2' },
    { slug: 'cs2', category: 'CS2' },
    { slug: 'cs-2', category: 'CS2' },
    { slug: 'dota-2', category: 'Dota 2' },
    { slug: 'dota', category: 'Dota 2' },
    { slug: 'valorant', category: 'Valorant' },
    { slug: 'league-of-legends', category: 'LoL' },
    { slug: 'lol', category: 'LoL' },
    { slug: 'esports', category: null }
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
    await sleep(120);
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
    await sleep(120);
  }

  const results = [];
  const counts = { CS2: 0, 'Dota 2': 0, Valorant: 0, LoL: 0 };
  const nowMs = Date.now();

  for (const [evId, { ev, hintCategory }] of rawEventsMap.entries()) {
    if (ev.closed || ev.archived) continue;

    const title = String(ev.title || '').trim();
    const tagsText = (ev.tags || []).map((t) => `${t.label || ''} ${t.slug || ''}`).join(' ');
    const seriesText = (ev.series || []).map((s) => `${s.title || ''} ${s.slug || ''}`).join(' ');
    const category = detectEsportsCategory(`${title} ${ev.slug || ''} ${tagsText} ${seriesText}`) || hintCategory;
    if (!category) continue;

    const parsed = parseMatchTitle(title);
    if (!parsed) continue;

    const mainMarket = pickPolymarketMainMarket(ev);
    if (!mainMarket || mainMarket.closed) continue;

    const rawStart = mainMarket.gameStartTime || ev.gameStartTime || ev.eventDate || ev.startTime || ev.endDate;
    if (!rawStart) continue;
    const startMs = new Date(rawStart).getTime();
    if (!Number.isFinite(startMs)) continue;

    if (startMs < nowMs - 4 * 3600 * 1000) continue;

    const outcomesArr = parseJsonArray(mainMarket.outcomes);
    const pricesArr = parseJsonArray(mainMarket.outcomePrices);

    let p1 = priceToOdd(pricesArr[0]);
    let p2 = priceToOdd(pricesArr[1]);

    const out0 = String(outcomesArr[0] || '').toLowerCase();
    const out1 = String(outcomesArr[1] || '').toLowerCase();
    const t1Low = parsed.team1.toLowerCase();
    const t2Low = parsed.team2.toLowerCase();

    if ((out0.includes(t2Low) || t2Low.includes(out0)) && (out1.includes(t1Low) || t1Low.includes(out1))) {
      [p1, p2] = [p2, p1];
    }

    if (!p1 || !p2) continue;

    const vol = Number(mainMarket.volumeNum ?? mainMarket.volume ?? ev.volume ?? 0);
    if (p1 === 1.86 && p2 === 1.86 && vol < 5) continue;

    const tournament = parsed.extractedTournament || ev.series?.[0]?.title || `${category} Pro Match`;
    const formatMatch = `${title} ${mainMarket.question || ''}`.match(/\bBO[1235]\b/i);
    const format = formatMatch ? formatMatch[0].toUpperCase() : 'BO3';

    counts[category] = (counts[category] || 0) + 1;

    results.push({
      id: `pm_${category.toLowerCase().replace(/\s+/g, '')}_${evId}`,
      external_id: `pm_${evId}`,
      title: `${parsed.team1} vs ${parsed.team2}`,
      category,
      tournament: String(tournament).trim(),
      format,
      start_time: new Date(startMs).toISOString(),
      status: 'prematch',
      outcomes: [
        { name: 'П1', odd: p1 },
        { name: 'П2', odd: p2 }
      ],
      extra_markets: []
    });
  }

  console.log(`Polymarket Esports: synced ${results.length} matches -> CS2: ${counts.CS2}, Dota 2: ${counts['Dota 2']}, Valorant: ${counts.Valorant}, LoL: ${counts.LoL}`);
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
  const nowMs = Date.now();

  for (const [evId, g] of grouped.entries()) {
    if (!g.p1 || !g.p2) continue;

    const startMs = g.start_time ? new Date(g.start_time).getTime() : nowMs + 7200000;
    if (Number.isFinite(startMs) && startMs < nowMs - 4 * 3600 * 1000) continue;

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
      start_time: new Date(startMs).toISOString(),
      status: 'prematch',
      outcomes,
      extra_markets: []
    });
  }

  console.log(`SharpAPI Classic Sports: synced ${results.length} real matches.`);
  return results;
}

// 3. Авторасчёт завершённых матчей с Polymarket и SharpAPI
async function settlePolymarketEvent(dbEv) {
  const rawExt = String(dbEv.external_id || dbEv.id.split('_').pop() || '');
  const pmId = rawExt.replace(/^pm_/, '');
  if (!pmId) return false;

  const ev = await fetchGamma(`/events/${pmId}`);
  if (!ev) return false;

  const mainMarket = pickPolymarketMainMarket(ev);
  if (!mainMarket) return false;

  const isClosed = Boolean(ev.closed || mainMarket.closed);
  if (!isClosed) return false;

  const outcomesArr = parseJsonArray(mainMarket.outcomes);
  const pricesArr = parseJsonArray(mainMarket.outcomePrices).map(Number);
  if (outcomesArr.length < 2 || pricesArr.length < 2) return false;

  let rawWinnerIdx = -1;
  if (pricesArr[0] >= 0.95 && pricesArr[1] <= 0.05) rawWinnerIdx = 0;
  else if (pricesArr[1] >= 0.95 && pricesArr[0] <= 0.05) rawWinnerIdx = 1;
  else return false;

  // Проверяем, не менялись ли команды местами при импорте
  const parsed = parseMatchTitle(dbEv.title);
  let winnerIdx = rawWinnerIdx;
  if (parsed) {
    const out0 = String(outcomesArr[0] || '').toLowerCase();
    const out1 = String(outcomesArr[1] || '').toLowerCase();
    const t1Low = parsed.team1.toLowerCase();
    const t2Low = parsed.team2.toLowerCase();
    const swapped = (out0.includes(t2Low) || t2Low.includes(out0)) && (out1.includes(t1Low) || t1Low.includes(out1));
    if (swapped) winnerIdx = rawWinnerIdx === 0 ? 1 : 0;
  }

  const { data, error } = await sb.rpc('admin_settle_event', {
    p_event_id: dbEv.id,
    p_winner_index: winnerIdx,
    p_score: ''
  });

  if (error) {
    console.warn(`Settle Polymarket ${dbEv.id} error:`, error.message);
    return false;
  }

  console.log(`Auto-settled Polymarket [${dbEv.title}] -> outcome #${winnerIdx} (bets: ${data?.settled || 0})`);
  return true;
}

function parseSharpScoreWinner(dbEv, scoreObj) {
  if (!scoreObj || typeof scoreObj !== 'object') return null;

  const st = String(scoreObj.status || scoreObj.state || '').toLowerCase();
  const isCompleted =
    scoreObj.completed === true ||
    scoreObj.is_final === true ||
    st.includes('final') ||
    st.includes('finish') ||
    st.includes('ended') ||
    st.includes('closed') ||
    st.includes('complete');

  if (!isCompleted) return null;

  let homeScore = Number(scoreObj.home_score ?? scoreObj.score_home ?? scoreObj.home?.score);
  let awayScore = Number(scoreObj.away_score ?? scoreObj.score_away ?? scoreObj.away?.score);

  if ((!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) && Array.isArray(scoreObj.scores) && scoreObj.scores.length >= 2) {
    const parsed = parseMatchTitle(dbEv.title);
    if (parsed) {
      const t1 = parsed.team1.toLowerCase();
      const t2 = parsed.team2.toLowerCase();
      for (const sItem of scoreObj.scores) {
        const name = String(sItem.name || sItem.team || '').toLowerCase();
        const val = Number(sItem.score);
        if (!Number.isFinite(val)) continue;
        if (name.includes(t1) || t1.includes(name)) homeScore = val;
        else if (name.includes(t2) || t2.includes(name)) awayScore = val;
      }
    }
  }

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;

  const outcomesCount = Array.isArray(dbEv.outcomes) ? dbEv.outcomes.length : 2;
  const scoreStr = `${homeScore}:${awayScore}`;

  if (homeScore > awayScore) return { winnerIndex: 0, score: scoreStr };
  if (awayScore > homeScore) return { winnerIndex: outcomesCount === 3 ? 2 : 1, score: scoreStr };
  // Ничья: если в линии есть исход Х (3 исхода), побеждает индекс 1; иначе возврат (-1)
  return { winnerIndex: outcomesCount === 3 ? 1 : -1, score: scoreStr };
}

async function autoSettleFinishedEvents() {
  const { data: openEvents, error } = await sb
    .from('events')
    .select('id, external_id, title, start_time, status, outcomes')
    .neq('status', 'finished')
    .lt('start_time', new Date().toISOString())
    .limit(120);

  if (error || !openEvents || openEvents.length === 0) return;

  const pmEvents = openEvents.filter((e) => String(e.id).startsWith('pm_'));
  const sharpEvents = openEvents.filter((e) => String(e.id).startsWith('ext_'));

  let settledCount = 0;

  // 1. Закрываем завершённые матчи Polymarket
  for (const ev of pmEvents) {
    try {
      const ok = await settlePolymarketEvent(ev);
      if (ok) settledCount++;
    } catch (err) {
      console.warn(`Polymarket check ${ev.id} warn:`, err.message);
    }
    await sleep(120);
  }

  // 2. Закрываем завершённые матчи SharpAPI
  if (SHARPAPI_KEY && sharpEvents.length > 0) {
    const scoresMap = new Map();
    try {
      const rawScores = await fetchSharp('/scores?daysFrom=2&limit=500');
      for (const sc of extractArray(rawScores)) {
        const id = String(sc.event_id ?? sc.id ?? '');
        if (id) scoresMap.set(id, sc);
      }
    } catch (err) {
      console.warn('SharpAPI /scores warn:', err.message);
    }

    for (const ev of sharpEvents) {
      try {
        const extId = String(ev.external_id || ev.id.replace(/^ext_/, ''));
        let scoreObj = scoresMap.get(extId);

        if (!scoreObj) {
          try {
            const single = await fetchSharp(`/events/${extId}`);
            scoreObj = single?.data || single;
          } catch {}
          await sleep(100);
        }

        const verdict = parseSharpScoreWinner(ev, scoreObj);
        if (!verdict) continue;

        const { data, error: settleErr } = await sb.rpc('admin_settle_event', {
          p_event_id: ev.id,
          p_winner_index: verdict.winnerIndex,
          p_score: verdict.score
        });

        if (!settleErr) {
          settledCount++;
          console.log(`Auto-settled SharpAPI [${ev.title}] (${verdict.score}) -> outcome #${verdict.winnerIndex} (bets: ${data?.settled || 0})`);
        }
      } catch (err) {
        console.warn(`SharpAPI settle ${ev.id} warn:`, err.message);
      }
    }
  }

  if (settledCount > 0) {
    console.log(`Auto-settle completed: closed ${settledCount} finished matches.`);
  }
}

(async function main() {
  try {
    // Сначала рассчитываем уже завершившиеся матчи
    await autoSettleFinishedEvents();

    // Затем подтягиваем свежие коэффициенты и новые матчи
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
