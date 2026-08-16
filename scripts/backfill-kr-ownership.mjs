import { readConfig } from "../src/config.mjs";
import { listRegisteredStockCodes } from "../src/providers/industry.mjs";
import { loadOwnershipEdges, saveOwnershipEdges } from "../src/providers/ownership.mjs";
import { createRuntimeState } from "../src/providers/runtime-state.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Builds the 지분 그래프 for the whole domestic market, once a year.
 *
 * Every listed company is asked what equity stakes it holds. The answer is an
 * annual figure out of the 사업보고서, so this is not something a board build
 * ever waits on — it runs by hand after the March filing season and again when
 * a year's numbers are wanted.
 *
 * Cost is a request per company against DART's 20,000/day quota, so a full pass
 * is about a fifth of the day's allowance and should not share the day with
 * kr:industry. Measured at roughly fifteen companies a second with no throttling
 * observed, which puts a whole-market pass near four minutes.
 *
 * Resumable: companies already stored for the year are skipped, so a broken run
 * costs only what it had not reached. --force re-asks about them, which is what
 * to use when filings have been amended.
 *
 * Usage:
 *   npm run kr:ownership
 *   npm run kr:ownership -- --year=2024
 *   npm run kr:ownership -- --limit=200 --force
 */

const spacingMs = 60;

function readOption(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : undefined;
}

async function storedHolders(config, businessYear) {
  const result = await query(
    config,
    "SELECT DISTINCT holder_symbol FROM kr_ownership_edges WHERE business_year = $1",
    [businessYear]
  );

  return new Set(result.rows.map((row) => row.holder_symbol));
}

async function main() {
  const config = readConfig();

  if (!config.dart.apiKey) {
    console.error("DART_API_KEY is not set — nothing to ask.");
    process.exit(1);
  }

  // The annual report for a year lands the following March, so asking about the
  // current year before then returns 013 for everybody.
  const businessYear = Number(readOption("year")) || new Date().getFullYear() - 1;
  const limit = Number(readOption("limit")) || undefined;
  const force = process.argv.includes("--force");

  const { byStockCode } = await createRuntimeState("dart-corp-index-v2", () => ({ byStockCode: {} })).read();
  const codes = await listRegisteredStockCodes(config);
  const done = force ? new Set() : await storedHolders(config, businessYear);
  const universe = codes
    .filter((symbol) => /^\d{6}$/.test(symbol) && byStockCode[symbol]?.corpCode && !done.has(symbol))
    .slice(0, limit);

  console.log(`kr ownership backfill · ${businessYear} · ${universe.length} companies to ask${done.size > 0 ? ` (${done.size} already stored)` : ""}`);

  let asked = 0;
  let withHoldings = 0;
  let edges = 0;
  let failed = 0;

  for (const holderSymbol of universe) {
    try {
      const holdings = await loadOwnershipEdges(config, {
        businessYear,
        corpCode: byStockCode[holderSymbol].corpCode,
        holderSymbol
      });

      if (holdings.length > 0) {
        edges += await saveOwnershipEdges(config, holdings);
        withHoldings += 1;
      }
    } catch (error) {
      // Left unstored so the next run retries it.
      failed += 1;

      if (failed <= 5) console.warn(`  ${holderSymbol} failed`, error instanceof Error ? error.message : error);
    }

    asked += 1;

    if (asked % 500 === 0) console.log(`  ${asked}/${universe.length} · holders ${withHoldings} · edges ${edges} · failed ${failed}`);

    await new Promise((wait) => setTimeout(wait, spacingMs));
  }

  console.log(`done · ${withHoldings} of ${asked} disclose stakes · ${edges} edges · ${failed} failed`);
}

await main();
process.exit(0);
