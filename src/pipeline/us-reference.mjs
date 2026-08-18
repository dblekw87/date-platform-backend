import { massiveRequest } from "./massive.mjs";
import { query } from "../db/client.mjs";

/**
 * Keeps the US universe snapshot from going stale on its own.
 *
 * us_tickers is who was listed on a given day, and it was only ever written by
 * a backfill somebody ran by hand - nine snapshots in two years, the newest
 * 2026-08-13. Nothing scheduled touched it.
 *
 * That is the shape of failure this project keeps finding. On 2026-08-18 the
 * eligible half of the share-count watchlist had been evaluating to zero rows
 * because it joined this table on an exact date that a daily series would never
 * match; the as-of join fixed the join, but a snapshot that stops advancing
 * still slowly stops describing the market. New listings never appear and
 * delisted ones never leave, and neither shows up as an error.
 *
 * Monthly is enough. Instrument types almost never change and the universe
 * moves at the pace of listings, so this is about not falling months behind
 * rather than about being current to the day.
 */

const universeMaxAgeDays = 30;
// Massive dates the universe, so a snapshot has to name a settled day rather
// than today - the same plan that answers 403 for a session in progress.
const universeLagDays = 3;

export async function newestUniverseDate(config) {
  const result = await query(config, "SELECT max(as_of)::text AS as_of FROM us_tickers");

  return result.rows[0]?.as_of ?? null;
}

export function isUniverseStale(newest, today) {
  if (!newest) return true;

  const age = (new Date(`${today}T00:00:00Z`) - new Date(`${newest}T00:00:00Z`)) / 86400000;

  return age >= universeMaxAgeDays;
}

export function universeSnapshotDate(today) {
  const date = new Date(`${today}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() - universeLagDays);

  return date.toISOString().slice(0, 10);
}

async function saveTickers(config, asOf, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO us_tickers (symbol, as_of, cik, name, type, primary_exchange, active)
    SELECT symbol, $2::date, cik, name, type, primary_exchange, active
    FROM unnest($1::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::boolean[])
      AS t(symbol, cik, name, type, primary_exchange, active)
    ON CONFLICT (symbol, as_of) DO UPDATE
      SET cik = EXCLUDED.cik, name = EXCLUDED.name, type = EXCLUDED.type,
          primary_exchange = EXCLUDED.primary_exchange, active = EXCLUDED.active
  `, [
    rows.map((row) => row.ticker),
    asOf,
    rows.map((row) => (row.cik ? Number(row.cik) : null)),
    rows.map((row) => row.name ?? null),
    rows.map((row) => row.type ?? null),
    rows.map((row) => row.primary_exchange ?? null),
    rows.map((row) => row.active ?? null)
  ]);

  return result.rowCount;
}

export async function refreshUsUniverse(config, asOf, { log = () => {} } = {}) {
  let path = `/v3/reference/tickers?market=stocks&date=${asOf}&limit=1000&sort=ticker`;
  let total = 0;

  while (path) {
    const page = await massiveRequest(config, path);
    const rows = (page.results ?? []).filter((row) => row.ticker);

    total += await saveTickers(config, asOf, rows);

    path = page.next_url ? new URL(page.next_url).pathname + new URL(page.next_url).search : null;
  }

  log(`us universe · ${asOf} ${total} symbols`);

  return total;
}
