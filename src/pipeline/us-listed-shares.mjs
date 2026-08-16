import { query } from "../db/client.mjs";
import { massiveRequest } from "./massive.mjs";

/**
 * Share counts read off the listed security rather than off the filer.
 *
 * Two things go wrong with the SEC count and they go wrong in opposite
 * directions. For a foreign issuer it counts ordinary shares while an ADS is
 * what trades, which priced Steakholder Foods at $15.7B against a real $2.0M.
 * For a domestic one it is simply old: quarterly, against companies that issue
 * weekly, and GPUS came out 301 times short. A quarter of common stocks were
 * wrong enough to reshuffle eleven names out of thirty.
 *
 * The catch is that this endpoint answers one ticker at a time. The set worth
 * keeping current is about 2,300 symbols, which is nearly eight hours at five
 * requests a minute — impossible nightly, and pointless as a one-off, because
 * the counts go stale again the same way.
 *
 * So it rotates. Each run refreshes the slice whose stored counts are oldest,
 * and over a week or so the whole set comes round. Nothing is ever more than
 * that far out of date, and no single night is spent doing it.
 */

// weighted_shares_outstanding is the field to use. share_class_shares_-
// outstanding still counts ordinary shares for an ADR — STKH reported
// 282,250,000 of those against 2,884,206 weighted — and it is the weighted
// count that market_cap is built from and the ADS ratio applied to.
function sharesOf(details) {
  return details.weighted_shares_outstanding ?? details.share_class_shares_outstanding ?? null;
}

/**
 * The symbols a candidate list can actually reach: currently small and liquid
 * enough to be ranked, plus everything that has ever run. Ordered by how long
 * ago each was last read, so a bounded slice always takes the stalest.
 */
const staleFirstSql = `
  WITH latest AS (SELECT max(session_date) AS session_date FROM us_daily_bars),
  eligible AS (
    SELECT b.symbol
    FROM us_daily_bars b
    CROSS JOIN latest l
    JOIN us_tickers u ON u.symbol = b.symbol AND u.as_of = l.session_date
      AND u.type IN ('CS', 'ADRC')
    JOIN LATERAL (
      SELECT sc.shares FROM us_share_counts sc
      WHERE sc.cik = u.cik AND sc.period_end <= b.session_date AND sc.shares >= 100000
      ORDER BY sc.period_end DESC LIMIT 1
    ) s ON true
    WHERE b.session_date = l.session_date
      AND b.close >= 0.1 AND b.close * b.volume >= 100000
      AND b.close * s.shares < 2e9 AND b.volume / s.shares >= 0.01
  ),
  history AS (
    SELECT DISTINCT e.symbol FROM us_surge_events e
    JOIN us_tickers u ON u.symbol = e.symbol AND u.type IN ('CS', 'ADRC')
  ),
  wanted AS (SELECT symbol FROM eligible UNION SELECT symbol FROM history)
  SELECT w.symbol,
         (SELECT max(ls.as_of) FROM us_listed_shares ls WHERE ls.symbol = w.symbol) AS last_read
  FROM wanted w
  ORDER BY last_read ASC NULLS FIRST, w.symbol
  LIMIT $1`;

export async function refreshListedShares(config, { limit = 250, onSymbol } = {}) {
  if (!config.massive.apiKey) return { fetched: 0, skipped: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const targets = await query(config, staleFirstSql, [limit]);
  let fetched = 0;
  let skipped = 0;

  for (const { last_read: lastRead, symbol } of targets.rows) {
    // Already read today by an earlier run or by the CLI.
    if (lastRead && new Date(lastRead).toISOString().slice(0, 10) === today) {
      skipped += 1;
      continue;
    }

    try {
      const page = await massiveRequest(config, `/v3/reference/tickers/${symbol}`);
      const details = page.results ?? {};

      await query(
        config,
        `INSERT INTO us_listed_shares (symbol, as_of, shares, market_cap)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (symbol, as_of) DO UPDATE
           SET shares = EXCLUDED.shares, market_cap = EXCLUDED.market_cap`,
        [symbol, today, sharesOf(details), details.market_cap ?? null]
      );

      fetched += 1;
      onSymbol?.({ shares: sharesOf(details), symbol });
    } catch (error) {
      // A delisted or renamed ticker answers 404. Writing nothing leaves the
      // previous reading — and failing that the SEC count — in place.
      if (error.status === 404) {
        skipped += 1;
        continue;
      }

      throw error;
    }
  }

  return { fetched, skipped };
}
