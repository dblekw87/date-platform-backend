import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Downloads two years of US daily bars, one whole-market day per request.
 *
 * Per-symbol history would be ten thousand requests a year. The grouped
 * endpoint returns every stock that traded on a given date in one response, so
 * a session costs one call and the whole backfill is bounded by the number of
 * trading days rather than by the number of listings — which matters because
 * the listings that matter most here are the ones that no longer exist.
 *
 * Delisted symbols are the reason for using this source at all. A stock that
 * ran 700% and was gone a year later is absent from anything that lists what is
 * currently tradable, and training without those teaches the model that a surge
 * is a happy ending.
 *
 * Usage:
 *   npm run us:backfill                          # two years back to yesterday
 *   npm run us:backfill -- --from=2025-01-01
 *   npm run us:backfill -- --from=2026-08-01 --to=2026-08-13
 */

const config = readConfig();

if (!config.massive.apiKey) {
  console.error("MASSIVE_API_KEY is not set. Add it to date-platform-backend/.env and rerun.");
  process.exit(1);
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));

  return found ? found.slice(prefix.length) : fallback;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return isoDate(date);
}

// Weekends are skipped outright rather than discovered. Holidays still cost one
// request each, but they are recorded so the cost is paid only once.
function isWeekend(iso) {
  return [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
}

const today = isoDate(new Date());
const to = readArg("to", shiftDays(today, -1));
const from = readArg("from", shiftDays(to, -730));

const intervalMs = Math.ceil(60_000 / Math.max(config.massive.requestsPerMinute, 1));
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, attempt = 1) {
  const waitMs = lastRequestAt + intervalMs - Date.now();

  if (waitMs > 0) await sleep(waitMs);

  lastRequestAt = Date.now();

  const response = await fetch(`${config.massive.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.massive.apiKey}` }
  });

  // A 429 means the configured pace is wrong for this plan rather than that the
  // request was bad, so it backs off and keeps going instead of failing the run.
  if (response.status === 429 && attempt <= 5) {
    console.log(`  rate limited, waiting 60s (attempt ${attempt})`);
    await sleep(60_000);

    return request(path, attempt + 1);
  }

  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText} for ${path}`);

    error.status = response.status;

    throw error;
  }

  return response.json();
}

/**
 * Reverse splits first, because without them the labelling cannot tell a stock
 * that doubled from a stock whose share count was cut in half.
 */
async function backfillSplits() {
  let path = `/v3/reference/splits?limit=1000&execution_date.gte=${from}&execution_date.lte=${to}`;
  let total = 0;

  while (path) {
    const page = await request(path);
    const rows = page.results ?? [];

    if (rows.length > 0) {
      await query(
        config,
        `INSERT INTO us_splits (symbol, execution_date, split_from, split_to)
         SELECT symbol, execution_date, split_from, split_to
         FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[])
           AS t(symbol, execution_date, split_from, split_to)
         ON CONFLICT (symbol, execution_date) DO NOTHING`,
        [
          rows.map((row) => row.ticker),
          rows.map((row) => row.execution_date),
          rows.map((row) => row.split_from),
          rows.map((row) => row.split_to)
        ]
      );
      total += rows.length;
    }

    path = page.next_url ? new URL(page.next_url).pathname + new URL(page.next_url).search : null;
  }

  console.log(`splits: ${total} rows`);
}

async function loadDoneDates() {
  // ::text so Postgres formats the day. Read as a JS Date it would be local
  // midnight, and toISOString would hand back the day before east of UTC - the
  // same shift that had the scheduler re-fetching its newest session hourly.
  const result = await query(
    config,
    "SELECT session_date::text AS session_date FROM us_backfill_progress WHERE session_date BETWEEN $1 AND $2",
    [from, to]
  );

  return new Set(result.rows.map((row) => row.session_date));
}

async function saveBars(sessionDate, bars) {
  if (bars.length > 0) {
    await query(
      config,
      `INSERT INTO us_daily_bars
         (symbol, session_date, open, high, low, close, volume, vwap, trade_count)
       SELECT symbol, $1::date, open, high, low, close, volume, vwap, trade_count
       FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::numeric[],
                   $6::numeric[], $7::numeric[], $8::numeric[], $9::int[])
         AS t(symbol, open, high, low, close, volume, vwap, trade_count)
       ON CONFLICT (symbol, session_date) DO NOTHING`,
      [
        sessionDate,
        bars.map((bar) => bar.T),
        bars.map((bar) => bar.o ?? null),
        bars.map((bar) => bar.h ?? null),
        bars.map((bar) => bar.l ?? null),
        bars.map((bar) => bar.c ?? null),
        bars.map((bar) => bar.v ?? null),
        bars.map((bar) => bar.vw ?? null),
        bars.map((bar) => bar.n ?? null)
      ]
    );
  }

  await query(
    config,
    `INSERT INTO us_backfill_progress (session_date, bar_count)
     VALUES ($1, $2)
     ON CONFLICT (session_date) DO UPDATE SET bar_count = EXCLUDED.bar_count, fetched_at = now()`,
    [sessionDate, bars.length]
  );
}

console.log(`backfilling ${from} → ${to} at ${config.massive.requestsPerMinute}/min`);

await backfillSplits();

const done = await loadDoneDates();
const dates = [];

for (let cursor = from; cursor <= to; cursor = shiftDays(cursor, 1)) {
  if (!isWeekend(cursor) && !done.has(cursor)) dates.push(cursor);
}

console.log(`${dates.length} sessions to fetch (${done.size} already stored)`);
console.log(`estimated ${Math.ceil((dates.length * intervalMs) / 60_000)} minutes`);

let index = 0;

for (const sessionDate of dates) {
  index += 1;

  let page;

  try {
    // adjusted=false keeps the price as it traded. See 005_us_daily_bars.sql for
    // why history is stored raw rather than on today's share basis.
    page = await request(`/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}?adjusted=false`);
  } catch (error) {
    // The plan's history window is a rolling two years, so the oldest requested
    // days sit just outside it and answer 403. That is the edge of what this key
    // can see rather than a broken run, and the window slides forward daily, so
    // the date is left unrecorded for a later pass to pick up.
    if (error.status === 403) {
      console.log(`[${index}/${dates.length}] ${sessionDate} outside the plan's history window`);
      continue;
    }

    throw error;
  }

  const bars = (page.results ?? []).filter((bar) => bar.T);

  await saveBars(sessionDate, bars);

  console.log(`[${index}/${dates.length}] ${sessionDate} ${bars.length} bars`);
}

console.log("done");
process.exit(0);
