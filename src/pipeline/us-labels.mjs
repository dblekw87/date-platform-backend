import { query } from "../db/client.mjs";

/**
 * Rebuilds us_surge_events from us_daily_bars.
 *
 * Truncates first rather than upserting. The filters below are the definition
 * of what is being predicted, so a run under a changed definition has to
 * replace the previous set entirely — leaving old rows behind would train on
 * two different questions at once.
 *
 * Lives here rather than in the script because the nightly pipeline runs the
 * same step, and two copies of this SQL would drift.
 */
export async function labelUsSurges(config, { gain = 0.5, minDollarVolume = 1_000_000, minPrice = 0.1 } = {}) {
  await query(config, "TRUNCATE us_surge_events");

  const inserted = await query(
    config,
    `WITH bars AS (
     SELECT symbol, session_date, open, high, close, volume,
            lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_close,
            -- Median, not mean. A serial runner's own past surges drag its
            -- average up until the next genuine move looks quiet: STKH ran
            -- +153% on 2.7M shares against a 4.4M mean — set by its own +367%
            -- day two weeks earlier — and was thrown out, while its median was
            -- 218K and would have kept it. The names this list exists to find
            -- are exactly the ones that surge more than once.
            array_agg(volume) OVER (
              PARTITION BY symbol ORDER BY session_date
              ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
            ) AS recent_volumes
     FROM us_daily_bars
   ),
   hits AS (
     SELECT *, high / prev_close - 1 AS gain, close * volume AS dollar_volume
     FROM bars
     WHERE prev_close >= $2 AND high > 0 AND high / prev_close - 1 >= $1
       -- A stock cannot double on quieter trading than usual. When the price
       -- multiplies and the volume does not, it is the share count that changed
       -- — a bankruptcy reconstitution, or a reverse split that never reached
       -- the splits feed. WW printed +16,570% on 0.0x its average volume the
       -- week it left Chapter 11; OCTO printed +5,632% on 6,294x. The cut costs
       -- 4% of events overall and 27% of the 1000%+ tier, which is exactly
       -- where all of them were hiding.
       AND volume > (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v)
         FROM unnest(recent_volumes) AS v
       )
   )
   INSERT INTO us_surge_events
     (symbol, session_date, prev_close, open, high, close, volume, dollar_volume, gain, close_gain)
   SELECT h.symbol, h.session_date, h.prev_close, h.open, h.high, h.close, h.volume,
          h.dollar_volume, h.gain, h.close / h.prev_close - 1
   FROM hits h
   WHERE h.dollar_volume >= $3
     -- A reverse split is not a move.
     AND NOT EXISTS (
       SELECT 1 FROM us_splits s
       WHERE s.symbol = h.symbol AND s.execution_date = h.session_date
     )
     -- Class shares carry a dot too (BRK.B), but so does every warrant, and no
     -- dotted symbol is a small cap that runs.
     AND h.symbol NOT LIKE '%.%'
     -- Exchange test tickers. They trade on the real tape with invented prices
     -- — ZWZZT printed a 704,882% day — so nothing filters them but knowing the
     -- names. Left in, they would be the single most "predictable" runner in the
     -- data and the model would learn them first.
     AND h.symbol !~ '^Z.ZZT$'
     AND h.symbol NOT IN ('ZIEXT', 'ZTEST', 'ZVV', 'ZXIET')
     -- The exchange's own classification, where the universe knows it. ADRC
     -- stays: the Chinese small caps that list as ADRs run as hard as anything
     -- on the tape and are bought the same way. Funds, notes and preferreds go.
     AND coalesce(
       (SELECT u.type FROM us_tickers u
        WHERE u.symbol = h.symbol AND u.as_of <= h.session_date
        ORDER BY u.as_of DESC LIMIT 1),
       'CS'
     ) IN ('CS', 'ADRC')
     -- Kept as the fallback for symbols the universe has no row for. A fifth
     -- letter of W/U/R/Z marks a warrant, unit, right or oddity; the four-letter
     -- base has to exist and trade the same day, so a genuine five-letter common
     -- share is not caught by the suffix alone.
     AND NOT (
       length(h.symbol) = 5
       AND right(h.symbol, 1) IN ('W', 'U', 'R', 'Z')
       AND EXISTS (
         SELECT 1 FROM us_daily_bars d
         WHERE d.symbol = left(h.symbol, 4) AND d.session_date = h.session_date
       )
     )`,
    [gain, minPrice, minDollarVolume]
  );

  return inserted.rowCount;
}
