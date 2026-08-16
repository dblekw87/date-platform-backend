import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Fetches five-minute bars for surge days, premarket and after hours included.
 *
 * One request per stock per day, which is the expensive shape, so the set is
 * chosen rather than swept: the biggest events first, because the question is
 * what a large move looks like as it happens and the +500% days are the ones
 * worth spending requests on.
 *
 * Resumable — every pair attempted is recorded, empty results included, so a
 * rerun continues instead of paying again for days that had no extended-hours
 * prints.
 *
 * Usage:
 *   npm run us:intraday                # 400 largest events not yet fetched
 *   npm run us:intraday -- --limit=100
 *   npm run us:intraday -- --min-gain=1.0 --limit=800
 */

const config = readConfig();

if (!config.massive.apiKey) {
  console.error("MASSIVE_API_KEY is not set. Add it to date-platform-backend/.env and rerun.");
  process.exit(1);
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));

  return found ? Number(found.slice(prefix.length)) : fallback;
}

const limit = readArg("limit", 400);
const minGain = readArg("min-gain", 2.0);

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

  if (response.status === 429 && attempt <= 5) {
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

// Eastern time decides the phase, and Eastern is what the exchange runs on, so
// the offset is read from the clock rather than assumed — it moves twice a year.
const easternTime = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "America/New_York"
});

function phaseOf(timestamp) {
  const parts = easternTime.formatToParts(new Date(timestamp));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const minute = (value("hour") % 24) * 60 + value("minute");

  if (minute < 9 * 60 + 30) return "pre";
  if (minute < 16 * 60) return "regular";

  return "post";
}

async function saveBars(symbol, sessionDate, bars) {
  if (bars.length > 0) {
    await query(
      config,
      `INSERT INTO us_intraday_bars
         (symbol, session_date, observed_at, phase, open, high, low, close, volume)
       SELECT $1, $2::date, observed_at, phase, open, high, low, close, volume
       FROM unnest($3::timestamptz[], $4::text[], $5::numeric[], $6::numeric[],
                   $7::numeric[], $8::numeric[], $9::numeric[])
         AS t(observed_at, phase, open, high, low, close, volume)
       ON CONFLICT (symbol, observed_at) DO NOTHING`,
      [
        symbol,
        sessionDate,
        bars.map((bar) => new Date(bar.t).toISOString()),
        bars.map((bar) => phaseOf(bar.t)),
        bars.map((bar) => bar.o ?? null),
        bars.map((bar) => bar.h ?? null),
        bars.map((bar) => bar.l ?? null),
        bars.map((bar) => bar.c ?? null),
        bars.map((bar) => bar.v ?? null)
      ]
    );
  }

  await query(
    config,
    `INSERT INTO us_intraday_progress (symbol, session_date, bar_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol, session_date) DO UPDATE
       SET bar_count = EXCLUDED.bar_count, fetched_at = now()`,
    [symbol, sessionDate, bars.length]
  );
}

const targets = await query(
  config,
  `SELECT e.symbol, to_char(e.session_date, 'YYYY-MM-DD') AS session_date, e.gain
   FROM us_surge_events e
   WHERE e.gain >= $1
     AND NOT EXISTS (
       SELECT 1 FROM us_intraday_progress p
       WHERE p.symbol = e.symbol AND p.session_date = e.session_date
     )
   ORDER BY e.gain DESC
   LIMIT $2`,
  [minGain, limit]
);

console.log(`${targets.rowCount} event days to fetch at ${config.massive.requestsPerMinute}/min`);
console.log(`estimated ${Math.ceil((targets.rowCount * intervalMs) / 60_000)} minutes`);

let index = 0;

for (const target of targets.rows) {
  index += 1;

  try {
    const page = await request(
      `/v2/aggs/ticker/${target.symbol}/range/5/minute/${target.session_date}/${target.session_date}`
      + "?adjusted=false&limit=500&sort=asc"
    );
    const bars = page.results ?? [];

    await saveBars(target.symbol, target.session_date, bars);

    console.log(`[${index}/${targets.rowCount}] ${target.symbol} ${target.session_date} ${bars.length} bars`);
  } catch (error) {
    // A delisted ticker answers 404 rather than an empty result. Recording it as
    // fetched keeps a rerun from paying for the same absence again.
    if (error.status === 404 || error.status === 403) {
      await saveBars(target.symbol, target.session_date, []);
      console.log(`[${index}/${targets.rowCount}] ${target.symbol} ${target.session_date} unavailable`);
      continue;
    }

    throw error;
  }
}

console.log("done");
process.exit(0);
