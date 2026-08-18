import { query } from "../db/client.mjs";
import { massiveRequest } from "./massive.mjs";

/**
 * Whole-market daily bars, one request per session.
 *
 * Per-symbol history would be ten thousand requests a year. The grouped
 * endpoint returns every stock that traded on a date in one response, so a
 * session costs one call and the work is bounded by trading days rather than by
 * listings — which matters because the listings that matter most here are the
 * ones that no longer exist. A stock that ran 700% and was delisted a year
 * later is absent from anything listing what is currently tradable, and
 * training without those teaches the model that a surge is a happy ending.
 */

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function shiftDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return isoDate(date);
}

// Weekends are skipped outright rather than discovered. Holidays still cost one
// request each, but they are recorded so the cost is paid only once.
export function isWeekend(iso) {
  return [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
}

/**
 * Which sessions are already done, as the calendar strings the caller compares
 * against.
 *
 * Formatted by Postgres rather than by isoDate. A DATE column arrives here as a
 * JS Date at local midnight, so 2026-08-14 in Seoul is 2026-08-13T15:00Z, and
 * toISOString then reads back the day before. Every label was shifted one day:
 * the newest stored session never matched, so each hourly run re-fetched it —
 * twelve thousand bars for 2026-08-14, once an hour — while the day before it
 * was reported done on the strength of its neighbour's row.
 *
 * isUsPipelineDue hid this by only counting rows, never reading their dates.
 */
export async function loadStoredSessions(config, from, to) {
  const result = await query(
    config,
    "SELECT session_date::text AS session_date FROM us_backfill_progress WHERE session_date BETWEEN $1 AND $2",
    [from, to]
  );

  return new Set(result.rows.map((row) => row.session_date));
}

async function saveBars(config, sessionDate, bars) {
  if (bars.length > 0) {
    await query(
      config,
      `INSERT INTO us_daily_bars
         (symbol, session_date, open, high, low, close, volume, vwap, trade_count)
       SELECT symbol, $1::date, open, high, low, close, volume, vwap, trade_count
       FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::numeric[],
                   $6::numeric[], $7::numeric[], $8::numeric[], $9::int[])
         AS t(symbol, open, high, low, close, volume, vwap, trade_count)
       ON CONFLICT (symbol, session_date) DO NOTHING`,
      [
        sessionDate,
        bars.map((bar) => bar.T),
        bars.map((bar) => bar.o ?? null),
        bars.map((bar) => bar.h ?? null),
        bars.map((bar) => bar.l ?? null),
        bars.map((bar) => bar.c ?? null),
        bars.map((bar) => bar.v ?? null),
        bars.map((bar) => bar.vw ?? null),
        bars.map((bar) => bar.n ?? null)
      ]
    );
  }

  await query(
    config,
    `INSERT INTO us_backfill_progress (session_date, bar_count)
     VALUES ($1, $2)
     ON CONFLICT (session_date) DO UPDATE SET bar_count = EXCLUDED.bar_count, fetched_at = now()`,
    [sessionDate, bars.length]
  );
}

/**
 * Reverse splits, so labelling can tell a stock that doubled from one whose
 * share count was halved.
 */
export async function fetchUsSplits(config, from, to) {
  let path = `/v3/reference/splits?limit=1000&execution_date.gte=${from}&execution_date.lte=${to}`;
  let total = 0;

  while (path) {
    const page = await massiveRequest(config, path);
    const rows = page.results ?? [];

    if (rows.length > 0) {
      await query(
        config,
        `INSERT INTO us_splits (symbol, execution_date, split_from, split_to)
         SELECT symbol, execution_date, split_from, split_to
         FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[])
           AS t(symbol, execution_date, split_from, split_to)
         ON CONFLICT (symbol, execution_date) DO NOTHING`,
        [
          rows.map((row) => row.ticker),
          rows.map((row) => row.execution_date),
          rows.map((row) => row.split_from),
          rows.map((row) => row.split_to)
        ]
      );
      total += rows.length;
    }

    path = page.next_url ? new URL(page.next_url).pathname + new URL(page.next_url).search : null;
  }

  return total;
}

export async function fetchUsDailyBars(config, sessions, { onSession } = {}) {
  let fetched = 0;

  for (const sessionDate of sessions) {
    let page;

    try {
      // adjusted=false keeps the price as it traded. See 005_us_daily_bars.sql
      // for why history is stored raw rather than on today's share basis.
      page = await massiveRequest(
        config,
        `/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}?adjusted=false`
      );
    } catch (error) {
      // A 403 means the key cannot see this date, which happens at both ends
      // of its window and means opposite things. Old dates have fallen out of
      // the rolling two years and never come back; recent ones have not been
      // published yet and will be within a day. Either way the date is left
      // unrecorded so a later pass picks it up — but the log has to say which,
      // because one is finished and the other is worth waiting for.
      if (error.status === 403) {
        const twoYearsAgo = shiftDays(isoDate(new Date()), -720);

        onSession?.({ sessionDate, status: sessionDate < twoYearsAgo ? "outside-window" : "not-published" });
        continue;
      }

      throw error;
    }

    const bars = (page.results ?? []).filter((bar) => bar.T);

    await saveBars(config, sessionDate, bars);
    fetched += 1;
    onSession?.({ barCount: bars.length, sessionDate, status: "stored" });
  }

  return fetched;
}
