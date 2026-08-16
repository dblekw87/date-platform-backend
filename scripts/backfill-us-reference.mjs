import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Fills us_tickers and us_share_counts — the two things the price series does
 * not know.
 *
 * Two sources, picked because each returns everybody at once. Asking either one
 * per symbol would be sixteen thousand requests against a five-a-minute key.
 *
 *   Massive /v3/reference/tickers?date=  the universe as it stood that day,
 *                                        delisted names included, with the
 *                                        exchange's own instrument type
 *   SEC     /api/xbrl/frames/dei/...     every filer's share count for one
 *                                        quarter, in a single file, no key
 *
 * The universe is sampled quarterly rather than daily. Share counts only change
 * on a filing and instrument types almost never change, so a daily pass would
 * spend a hundred times the requests to learn the same thing.
 *
 * Usage:
 *   npm run us:reference
 */

const config = readConfig();

if (!config.massive.apiKey) {
  console.error("MASSIVE_API_KEY is not set. Add it to date-platform-backend/.env and rerun.");
  process.exit(1);
}

const universeDates = [
  "2024-09-16", "2024-12-16", "2025-03-17", "2025-06-16", "2025-09-15",
  "2025-12-15", "2026-03-16", "2026-06-15", "2026-08-13"
];

const shareFrames = [
  "CY2024Q2I", "CY2024Q3I", "CY2024Q4I", "CY2025Q1I", "CY2025Q2I",
  "CY2025Q3I", "CY2025Q4I", "CY2026Q1I", "CY2026Q2I", "CY2026Q3I"
];

const intervalMs = Math.ceil(60_000 / Math.max(config.massive.requestsPerMinute, 1));
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function massive(path, attempt = 1) {
  const waitMs = lastRequestAt + intervalMs - Date.now();

  if (waitMs > 0) await sleep(waitMs);

  lastRequestAt = Date.now();

  const response = await fetch(`${config.massive.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.massive.apiKey}` }
  });

  if (response.status === 429 && attempt <= 5) {
    await sleep(60_000);

    return massive(path, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}`);
  }

  return response.json();
}

async function saveTickers(asOf, rows) {
  if (rows.length === 0) return;

  await query(
    config,
    `INSERT INTO us_tickers (symbol, as_of, cik, name, type, primary_exchange, active)
     SELECT symbol, $1::date, cik, name, type, primary_exchange, active
     FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::boolean[])
       AS t(symbol, cik, name, type, primary_exchange, active)
     ON CONFLICT (symbol, as_of) DO NOTHING`,
    [
      asOf,
      rows.map((row) => row.ticker),
      rows.map((row) => (row.cik ? Number(row.cik) : null)),
      rows.map((row) => row.name ?? null),
      rows.map((row) => row.type ?? null),
      rows.map((row) => row.primary_exchange ?? null),
      rows.map((row) => row.active ?? null)
    ]
  );
}

async function backfillUniverse() {
  for (const asOf of universeDates) {
    const stored = await query(config, "SELECT count(*)::int AS n FROM us_tickers WHERE as_of = $1", [asOf]);

    if (stored.rows[0].n > 0) {
      console.log(`universe ${asOf} already stored (${stored.rows[0].n})`);
      continue;
    }

    let path = `/v3/reference/tickers?market=stocks&date=${asOf}&limit=1000&sort=ticker`;
    let total = 0;

    while (path) {
      const page = await massive(path);
      const rows = (page.results ?? []).filter((row) => row.ticker);

      await saveTickers(asOf, rows);
      total += rows.length;

      path = page.next_url ? new URL(page.next_url).pathname + new URL(page.next_url).search : null;
    }

    console.log(`universe ${asOf} ${total} symbols`);
  }
}

async function backfillShareCounts() {
  for (const frame of shareFrames) {
    const response = await fetch(
      `https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/${frame}.json`,
      { headers: { "Accept-Encoding": "gzip", "User-Agent": config.sec.userAgent } }
    );

    // Frames for quarters that have not been filed yet simply do not exist.
    if (response.status === 404) {
      console.log(`shares ${frame} not published`);
      continue;
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${frame}`);
    }

    const body = await response.json();
    const rows = (body.data ?? []).filter((row) => row.cik && row.end && row.val > 0);

    if (rows.length > 0) {
      await query(
        config,
        `INSERT INTO us_share_counts (cik, period_end, shares, accession)
         SELECT cik, period_end, shares, accession
         FROM unnest($1::int[], $2::date[], $3::numeric[], $4::text[])
           AS t(cik, period_end, shares, accession)
         ON CONFLICT (cik, period_end) DO NOTHING`,
        [
          rows.map((row) => row.cik),
          rows.map((row) => row.end),
          rows.map((row) => row.val),
          rows.map((row) => row.accn ?? null)
        ]
      );
    }

    console.log(`shares ${frame} ${rows.length} filers`);

    // SEC asks for ten requests a second at most; this is far under it.
    await sleep(300);
  }
}

await backfillShareCounts();
await backfillUniverse();

console.log("done");
process.exit(0);
