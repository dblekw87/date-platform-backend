import { query } from "../db/client.mjs";

/**
 * Counts how often each bucket of stock-days was followed by a surge.
 *
 * Every third session rather than all of them. The joins are the expensive part
 * and a third of 500 sessions still leaves cells with thousands of observations
 * apiece; spending three times as long to move a rate from 12.9% to 12.8% buys
 * nothing a list is going to act on.
 */
export async function calibrateUsSurges(config) {
  await query(config, "TRUNCATE us_surge_calibration");

  const result = await query(config, `WITH sampled AS (
     SELECT session_date FROM (
       SELECT session_date, row_number() OVER (ORDER BY session_date) AS rn
       FROM us_backfill_progress WHERE bar_count > 0
     ) t WHERE rn % 3 = 0
   ),
   pool AS (
     SELECT b.symbol, b.session_date,
            b.volume / s.shares AS turnover,
            b.close * s.shares AS market_cap,
            (SELECT max(e.session_date) FROM us_surge_events e
             WHERE e.symbol = b.symbol AND e.session_date <= b.session_date) AS last_run,
            -- Whether a catalyst form was filed in the three days up to and
            -- including this one. Presence only: which form matters for the
            -- evidence line on screen, not for the rate.
            EXISTS (
              SELECT 1 FROM us_filings f
              JOIN us_catalyst_forms cf ON cf.form_type = f.form_type
              WHERE f.cik = tk.cik
                AND f.filed_date BETWEEN b.session_date - 3 AND b.session_date
            ) AS has_filing
     FROM us_daily_bars b
     JOIN sampled ss ON ss.session_date = b.session_date
     JOIN LATERAL (
       SELECT u.cik FROM us_tickers u
       WHERE u.symbol = b.symbol AND u.as_of <= b.session_date AND u.cik IS NOT NULL
         AND u.type IN ('CS', 'ADRC')
       ORDER BY u.as_of DESC LIMIT 1
     ) tk ON true
     LEFT JOIN LATERAL (
       SELECT ls.shares, ls.as_of FROM us_listed_shares ls
       WHERE ls.symbol = b.symbol AND ls.shares >= 100000
       ORDER BY ls.as_of DESC LIMIT 1
     ) cur ON true
     LEFT JOIN LATERAL (
       -- Walk today's count back through the splits that have happened since.
       -- A 1-for-10 reverse split leaves a tenth of the shares, so the count
       -- before it was ten times the count after: multiply by split_from over
       -- split_to for every split between the session and the reading.
       --
       -- Derived rather than fetched. A point-in-time pass over the 589 symbols
       -- that split would be sixteen hours of requests, and the ratios are
       -- already in us_splits — exactly, which a quarterly snapshot would not
       -- be. It corrects only splits, not issuance, but a reverse split is a
       -- factor of ten or twenty and issuance is a drift.
       SELECT exp(sum(ln(sp.split_from / sp.split_to))) AS factor
       FROM us_splits sp
       WHERE sp.symbol = b.symbol
         AND sp.execution_date > b.session_date
         AND sp.execution_date <= cur.as_of
         AND sp.split_from > 0 AND sp.split_to > 0
     ) adj ON true
     JOIN LATERAL (
       -- The listed security before the filer, because for an ADR the two count
       -- different things.
       SELECT coalesce(
         cur.shares * coalesce(adj.factor, 1),
         (SELECT sc.shares FROM us_share_counts sc
          WHERE sc.cik = tk.cik AND sc.period_end <= b.session_date AND sc.shares >= 100000
          ORDER BY sc.period_end DESC LIMIT 1)
       ) AS shares
     ) s ON s.shares IS NOT NULL
     WHERE b.close >= 0.1 AND b.close * b.volume >= 100000
   ),
   bucketed AS (
     SELECT p.*,
       CASE WHEN turnover >= 1.0 THEN 'F 100%+'
            WHEN turnover >= 0.5 THEN 'E 50-100%'
            WHEN turnover >= 0.2 THEN 'D 20-50%'
            WHEN turnover >= 0.05 THEN 'C 5-20%'
            WHEN turnover >= 0.01 THEN 'B 1-5%'
            ELSE 'A <1%' END AS turnover_bucket,
       CASE WHEN market_cap < 25e6 THEN 'A <25M'
            WHEN market_cap < 100e6 THEN 'B 25-100M'
            WHEN market_cap < 500e6 THEN 'C 100-500M'
            WHEN market_cap < 2e9 THEN 'D 0.5-2B'
            ELSE 'E 2B+' END AS market_cap_bucket,
       -- How long since this stock last ran. A dimension rather than a filter:
       -- the freshly-run names carry the best odds AND are the ones a reader
       -- would call "already up", so the answer is to measure both and label.
       CASE WHEN last_run IS NULL THEN 'Z 이력없음'
            WHEN session_date - last_run = 0 THEN 'A 당일'
            WHEN session_date - last_run <= 5 THEN 'B 1-5일'
            WHEN session_date - last_run <= 20 THEN 'C 6-20일'
            WHEN session_date - last_run <= 90 THEN 'D 21-90일'
            ELSE 'E 90일초과' END AS recency_bucket,
       CASE WHEN has_filing THEN 'Y 공시있음' ELSE 'N 공시없음' END AS filing_bucket
     FROM pool p
   ),
   horizons AS (SELECT 1 AS d UNION ALL SELECT 3 UNION ALL SELECT 5 UNION ALL SELECT 10)
   INSERT INTO us_surge_calibration
     (horizon_days, turnover_bucket, market_cap_bucket, recency_bucket, filing_bucket,
      observations, surges, rate)
   SELECT h.d, b.turnover_bucket, b.market_cap_bucket, b.recency_bucket,
          coalesce(b.filing_bucket, 'any'),
          count(*),
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM us_surge_events e
            WHERE e.symbol = b.symbol
              AND e.session_date > b.session_date
              AND e.session_date <= b.session_date + h.d
          )),
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM us_surge_events e
            WHERE e.symbol = b.symbol
              AND e.session_date > b.session_date
              AND e.session_date <= b.session_date + h.d
          ))::numeric / count(*)
   FROM bucketed b CROSS JOIN horizons h
   -- Two grains in one pass. Four dimensions splits the sample thin enough that
   -- some cells stop being evidence, so the rollup without the filing axis is
   -- written alongside for a candidate to fall back to.
   GROUP BY GROUPING SETS (
     (h.d, b.turnover_bucket, b.market_cap_bucket, b.recency_bucket, b.filing_bucket),
     (h.d, b.turnover_bucket, b.market_cap_bucket, b.recency_bucket)
   )`);

  return result.rowCount;
}
