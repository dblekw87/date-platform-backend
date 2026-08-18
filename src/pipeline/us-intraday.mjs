import { massiveRequest } from "./massive.mjs";
import { query } from "../db/client.mjs";

/**
 * Five-minute bars for the days that mattered, extended hours included.
 *
 * Yahoo carries the extended-hours price and no volume at all - measured
 * 2026-08-18, forty-one pre-market bars for a stock that doubled, every one of
 * them reporting zero shares. Massive carries both, and its aggregates cover
 * 04:00 to 20:00 ET, but at five requests a minute it can never be the live
 * feed. So the live pass reads Yahoo for price and this fills the volume in
 * afterwards, for the handful of names a day that turned out to be worth it.
 *
 * Two ways to choose the set. "events" walks the surge history largest first,
 * which is the backfill this started as. "recent" takes what the collector
 * actually recorded moving in the last session or two - the names nobody knew
 * about until they moved, which is the half the history cannot contain.
 *
 * Resumable either way: every pair attempted is recorded, empty results
 * included, so a rerun continues rather than paying again for a day that had no
 * extended-hours prints.
 */

// Eastern decides the phase and Eastern is what the exchange runs on, so the
// offset comes off the clock rather than being assumed - it moves twice a year.
const easternTime = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "America/New_York"
});

function phaseOf(timestamp) {
  const parts = easternTime.formatToParts(new Date(timestamp));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const minute = (value("hour") % 24) * 60 + value("minute");

  if (minute < 9 * 60 + 30) return "pre";
  if (minute < 16 * 60) return "regular";

  return "post";
}

async function saveBars(config, symbol, sessionDate, bars) {
  if (bars.length > 0) {
    await query(config, `
      INSERT INTO us_intraday_bars
        (symbol, session_date, observed_at, phase, open, high, low, close, volume)
      SELECT $1, $2::date, observed_at, phase, open, high, low, close, volume
      FROM unnest($3::timestamptz[], $4::text[], $5::numeric[], $6::numeric[],
                  $7::numeric[], $8::numeric[], $9::numeric[])
        AS t(observed_at, phase, open, high, low, close, volume)
      ON CONFLICT (symbol, observed_at) DO NOTHING
    `, [
      symbol,
      sessionDate,
      bars.map((bar) => new Date(bar.t).toISOString()),
      bars.map((bar) => phaseOf(bar.t)),
      bars.map((bar) => bar.o ?? null),
      bars.map((bar) => bar.h ?? null),
      bars.map((bar) => bar.l ?? null),
      bars.map((bar) => bar.c ?? null),
      bars.map((bar) => bar.v ?? null)
    ]);
  }

  await query(config, `
    INSERT INTO us_intraday_progress (symbol, session_date, bar_count)
    VALUES ($1, $2, $3)
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET bar_count = EXCLUDED.bar_count, fetched_at = now()
  `, [symbol, sessionDate, bars.length]);
}

/**
 * What the collector saw move, and has no volume for.
 *
 * Ordered by the size of the move rather than by turnover, because turnover is
 * the thing that is missing - out of hours Yahoo reports none, so the only
 * measure of how much a name mattered is how far it went.
 */
export async function loadRecentTargets(config, { before, days, limit, minMove }) {
  const result = await query(config, `
    SELECT s.symbol, to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
           MAX(ABS(s.change_rate)) AS move
    FROM market_price_samples s
    WHERE s.market = 'US'
      -- Completed sessions only. The free tier answers 403 for a day still in
      -- progress, measured: 2026-08-17 returned 120 bars and 2026-08-18, asked
      -- during its own pre-market, was Forbidden.
      AND s.session_date < $4::date
      AND s.session_date >= ($4::date - $1::int)
      AND s.change_rate IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM us_intraday_progress p
        WHERE p.symbol = s.symbol AND p.session_date = s.session_date
      )
    GROUP BY s.symbol, s.session_date
    HAVING MAX(ABS(s.change_rate)) >= $2
    ORDER BY move DESC
    LIMIT $3
  `, [days, minMove, limit, before]);

  return result.rows;
}

export async function loadEventTargets(config, { limit, minGain }) {
  const result = await query(config, `
    SELECT e.symbol, to_char(e.session_date, 'YYYY-MM-DD') AS session_date, e.gain AS move
    FROM us_surge_events e
    WHERE e.gain >= $1
      AND NOT EXISTS (
        SELECT 1 FROM us_intraday_progress p
        WHERE p.symbol = e.symbol AND p.session_date = e.session_date
      )
    ORDER BY e.gain DESC
    LIMIT $2
  `, [minGain, limit]);

  return result.rows;
}

/**
 * markMissing is false for anything recent.
 *
 * The history sweep can treat a 404 as proof a ticker is gone and record it, so
 * a rerun stops paying for the same absence. A session from last night is a
 * different question: 403 there means the plan cannot see today yet, and
 * writing progress for it would skip the day permanently once it publishes.
 */
export async function fillUsIntraday(config, targets, { log = () => {}, markMissing = true } = {}) {
  let fetched = 0;
  let bars = 0;

  for (const [index, target] of targets.entries()) {
    try {
      const page = await massiveRequest(
        config,
        `/v2/aggs/ticker/${target.symbol}/range/5/minute/${target.session_date}/${target.session_date}`
        + "?adjusted=false&limit=500&sort=asc"
      );
      const rows = page.results ?? [];

      await saveBars(config, target.symbol, target.session_date, rows);

      fetched += 1;
      bars += rows.length;
      log(`[${index + 1}/${targets.length}] ${target.symbol} ${target.session_date} ${rows.length} bars`);
    } catch (error) {
      // A delisted ticker answers 404 rather than an empty result. Recording it
      // as fetched keeps a rerun from paying for the same absence again.
      if (error.status === 404 || error.status === 403) {
        if (markMissing) await saveBars(config, target.symbol, target.session_date, []);

        log(`[${index + 1}/${targets.length}] ${target.symbol} ${target.session_date} unavailable (${error.status})`);
        continue;
      }

      throw error;
    }
  }

  return { bars, fetched };
}
