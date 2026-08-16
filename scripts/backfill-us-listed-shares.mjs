import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Reads share counts off the listed security rather than off the filer.
 *
 * One request per ticker, so the universe is chosen: ADRs first, because that
 * is where the SEC number is not merely stale but measuring a different
 * instrument, and a wrong answer there is wrong by a factor of thousands.
 *
 * weighted_shares_outstanding is the field to use. For an ADR,
 * share_class_shares_outstanding still counts ordinary shares — STKH reported
 * 282,250,000 of them against 2,884,206 weighted — and it is the weighted count
 * that market_cap is built from and that the ADS ratio has been applied to.
 *
 * --dates makes the pass point-in-time. Without it the endpoint answers as of
 * today, which is right for tonight's list and wrong for calibration: a stock
 * that reverse split during the window would have its old turnover measured
 * against its new share count.
 *
 * --priority narrows a 3,748-symbol universe to the 1,851 that a candidate list
 * can actually reach: the ones currently small and liquid enough to be ranked,
 * plus every name with a surge in its history. Twelve hours becomes six, and
 * the symbols left out are the ones no ranking would ever surface.
 *
 * Usage:
 *   npm run us:listed-shares
 *   npm run us:listed-shares -- --types=CS --priority
 *   npm run us:listed-shares -- --dates=2025-03-17,2025-09-15,2026-03-16
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

const types = readArg("types", "ADRC").split(",").map((type) => type.trim()).filter(Boolean);
const dates = readArg("dates", "").split(",").map((date) => date.trim()).filter(Boolean);
const limit = Number(readArg("limit", "4000"));
const priority = process.argv.includes("--priority");

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

const today = new Date().toISOString().slice(0, 10);
const prioritySql = `
  WITH latest AS (SELECT max(session_date) AS session_date FROM us_daily_bars),
  eligible AS (
    SELECT b.symbol
    FROM us_daily_bars b
    CROSS JOIN latest l
    JOIN us_tickers u ON u.symbol = b.symbol AND u.as_of = l.session_date AND u.type = ANY($1)
    JOIN LATERAL (
      SELECT sc.shares FROM us_share_counts sc
      WHERE sc.cik = u.cik AND sc.period_end <= b.session_date AND sc.shares >= 100000
      ORDER BY sc.period_end DESC LIMIT 1
    ) s ON true
    WHERE b.session_date = l.session_date
      AND b.close >= 0.1 AND b.close * b.volume >= 100000
      -- The two conditions that decide whether a name can be ranked at all.
      AND b.close * s.shares < 2e9 AND b.volume / s.shares >= 0.01
  ),
  history AS (
    SELECT DISTINCT e.symbol FROM us_surge_events e
    JOIN us_tickers u ON u.symbol = e.symbol AND u.type = ANY($1)
  )
  SELECT symbol FROM eligible UNION SELECT symbol FROM history
  ORDER BY symbol LIMIT $2`;

const everySql = `
  SELECT DISTINCT u.symbol
  FROM us_tickers u
  WHERE u.type = ANY($1)
    AND EXISTS (SELECT 1 FROM us_daily_bars b WHERE b.symbol = u.symbol)
  ORDER BY u.symbol
  LIMIT $2`;

const targets = await query(config, priority ? prioritySql : everySql, [types, limit]);

const passes = dates.length > 0 ? dates : [null];

console.log(`${targets.rowCount} tickers × ${passes.length} pass(es) at ${config.massive.requestsPerMinute}/min`);
console.log(`estimated ${Math.ceil((targets.rowCount * passes.length * intervalMs) / 60_000)} minutes`);

let index = 0;

for (const asOf of passes) {
  for (const { symbol } of targets.rows) {
    index += 1;

    const stored = await query(
      config,
      "SELECT 1 FROM us_listed_shares WHERE symbol = $1 AND as_of = $2",
      [symbol, asOf ?? today]
    );

    if (stored.rowCount > 0) continue;

    try {
      const page = await request(
        `/v3/reference/tickers/${symbol}${asOf ? `?date=${asOf}` : ""}`
      );
      const details = page.results ?? {};
      const shares = details.weighted_shares_outstanding
        ?? details.share_class_shares_outstanding
        ?? null;

      await query(
        config,
        `INSERT INTO us_listed_shares (symbol, as_of, shares, market_cap)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (symbol, as_of) DO UPDATE
           SET shares = EXCLUDED.shares, market_cap = EXCLUDED.market_cap`,
        [symbol, asOf ?? today, shares, details.market_cap ?? null]
      );

      console.log(`[${index}] ${symbol}${asOf ? ` @${asOf}` : ""} shares=${shares ?? "-"} mcap=${details.market_cap ?? "-"}`);
    } catch (error) {
      // A ticker that had not listed yet on the requested date answers 404.
      // Recording nothing leaves the fallback to the SEC count in place.
      if (error.status === 404) {
        console.log(`[${index}] ${symbol}${asOf ? ` @${asOf}` : ""} not listed`);
        continue;
      }

      throw error;
    }
  }
}

console.log("done");
process.exit(0);
