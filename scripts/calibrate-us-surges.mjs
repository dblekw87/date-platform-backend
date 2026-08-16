import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { calibrateUsSurges } from "../src/pipeline/us-calibration.mjs";

/**
 * Rebuilds us_surge_calibration by hand. The nightly pipeline runs the same
 * function; this exists to inspect the result after changing a bucket edge.
 *
 * Usage:
 *   npm run us:calibrate
 */

const config = readConfig();

console.log("building bucket rates from us_daily_bars");
console.log(`${await calibrateUsSurges(config)} buckets`);

const preview = await query(
  config,
  `SELECT turnover_bucket, market_cap_bucket, recency_bucket, filing_bucket,
          observations, round(rate * 100, 2) AS pct
   FROM us_surge_calibration
   WHERE horizon_days = 5 AND observations >= 200
   ORDER BY rate DESC LIMIT 14`
);

for (const row of preview.rows) {
  console.log(
    `  ${row.turnover_bucket.padEnd(10)} ${row.market_cap_bucket.padEnd(11)} ${row.recency_bucket.padEnd(11)} ${row.filing_bucket.padEnd(11)} n=${String(row.observations).padStart(6)}  ${row.pct}%`
  );
}

process.exit(0);
