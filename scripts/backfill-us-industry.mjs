import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { recordCompanyIndustry } from "../src/providers/us-industry.mjs";

/**
 * Asks SEC what business every listed US company is in, once.
 *
 * The board resolves this lazily for the handful of leaders it cannot name, and
 * that is enough to keep 개별 종목 off the screen on any given day. It is not
 * enough to answer the question for the market: a stock that has never led is
 * never asked about, so the first day it leads it arrives unlabelled and waits
 * on a network call inside the board build.
 *
 * Funds are left out. ETFs, closed-end funds and trusts register under investing
 * office codes that say nothing about what they hold, and the theme map screens
 * them by name before it ever reaches an industry. Warrants, units, rights and
 * preferred shares are left out for the opposite reason: they share the CIK of
 * the common stock, so they are already covered by it.
 *
 * Resumable. Companies already recorded are skipped, so an interrupted run is
 * continued by starting it again.
 *
 * Usage:
 *   npm run us:industry
 *   npm run us:industry -- --types=CS
 *   npm run us:industry -- --limit=500
 *   npm run us:industry -- --retry-missing
 */

// SEC asks for no more than ten requests a second across all of a client's
// traffic. This is a third of that, which finishes 5,500 companies in about
// twelve minutes and leaves room for the board to keep serving alongside it.
const requestSpacingMs = 130;

const defaultTypes = ["ADRC", "CS"];

function readOption(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * Companies still to ask about.
 *
 * `--retry-missing` re-asks the ones already recorded without an SIC. Most of
 * those are genuine — a trust has no industry to report — but a lookup that
 * failed mid-run is stored the same way, and this is how those are picked up.
 */
async function readPendingCiks(config, { limit, retryMissing, types }) {
  const result = await query(
    config,
    `SELECT DISTINCT t.cik
       FROM us_tickers t
       LEFT JOIN us_company_industry i ON i.cik = t.cik
      WHERE t.cik IS NOT NULL
        AND t.type = ANY($1)
        AND t.as_of = (SELECT max(as_of) FROM us_tickers)
        AND (i.cik IS NULL ${retryMissing ? "OR i.sic IS NULL" : ""})
      ORDER BY t.cik
      ${limit ? "LIMIT " + Number(limit) : ""}`,
    [types]
  );

  return result.rows.map((row) => Number(row.cik));
}

async function main() {
  const config = readConfig();
  const types = (readOption("types") ?? defaultTypes.join(",")).split(",").map((type) => type.trim()).filter(Boolean);
  const pending = await readPendingCiks(config, {
    limit: readOption("limit"),
    retryMissing: hasFlag("retry-missing"),
    types
  });

  console.log(`us industry backfill · ${pending.length} companies · types ${types.join(",")}`);

  let recorded = 0;
  let withoutSic = 0;
  let failed = 0;

  for (const [index, cik] of pending.entries()) {
    try {
      const sic = await recordCompanyIndustry(config, cik);

      recorded += 1;
      if (!sic) withoutSic += 1;
    } catch (error) {
      failed += 1;
      // One company that will not answer is not a reason to stop: the run is
      // resumable, so anything missed here is picked up by the next pass.
      if (failed <= 5) console.warn(`cik ${cik} failed`, error instanceof Error ? error.message : error);
    }

    if ((index + 1) % 250 === 0) {
      console.log(`  ${index + 1}/${pending.length} · recorded ${recorded} · no sic ${withoutSic} · failed ${failed}`);
    }

    await new Promise((resolve) => setTimeout(resolve, requestSpacingMs));
  }

  console.log(`done · recorded ${recorded} · no sic ${withoutSic} · failed ${failed}`);
}

await main();
process.exit(0);
