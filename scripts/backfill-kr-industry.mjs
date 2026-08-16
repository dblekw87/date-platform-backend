import { readConfig } from "../src/config.mjs";
import { listRegisteredStockCodes, resolveIndustryThemes } from "../src/providers/industry.mjs";

/**
 * Asks DART what business every listed domestic company is in, once.
 *
 * The counterpart to us:industry, and it exists for the same reason: the board
 * resolves this lazily for the leaders it cannot name, which is enough for any
 * one day and leaves the market itself unanswered. A stock that has never led
 * has never been asked about, so the first day it leads it arrives unlabelled
 * and waits on a DART call inside the board build.
 *
 * Runs in batches because resolveIndustryThemes saves its cache once per call.
 * Handing it the whole universe would mean one write at the end and nothing kept
 * if the pass broke halfway; fifty at a time is resumable, since a symbol
 * already cached is never looked up again.
 *
 * The pacing matters more here than on the US side. DART bills against a daily
 * request quota rather than a rate limit, so the cost of this pass is a fixed
 * share of the day's allowance — roughly 2,700 of it — and it should be run
 * when nothing else needs the key, not alongside a board build.
 *
 * Usage:
 *   npm run kr:industry
 *   npm run kr:industry -- --limit=300
 */

const batchSize = 50;
const batchSpacingMs = 400;

function readOption(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : undefined;
}

async function main() {
  const config = readConfig();

  if (!config.dart.apiKey) {
    console.error("DART_API_KEY is not set — nothing to ask.");
    process.exit(1);
  }

  const limit = Number(readOption("limit")) || undefined;
  const codes = await listRegisteredStockCodes(config);
  const universe = limit ? codes.slice(0, limit) : codes;

  console.log(`kr industry backfill · ${universe.length} listed companies`);

  let resolved = 0;

  for (let index = 0; index < universe.length; index += batchSize) {
    const batch = universe.slice(index, index + batchSize);

    try {
      resolved += Object.keys(await resolveIndustryThemes(config, batch)).length;
    } catch (error) {
      // A failed batch leaves its symbols uncached, so the next run retries them.
      console.warn(`batch at ${index} failed`, error instanceof Error ? error.message : error);
    }

    if ((index + batchSize) % 500 === 0) {
      console.log(`  ${Math.min(index + batchSize, universe.length)}/${universe.length} · themed ${resolved}`);
    }

    await new Promise((wait) => setTimeout(wait, batchSpacingMs));
  }

  console.log(`done · ${resolved} of ${universe.length} carry a theme`);
}

await main();
process.exit(0);
