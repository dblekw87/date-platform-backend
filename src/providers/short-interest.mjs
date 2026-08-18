import { query } from "../db/client.mjs";

/**
 * FINRA's consolidated short interest, which is free and needs no key.
 *
 * Rule 4560 has members report short positions in every equity twice a month,
 * and api.finra.org serves the consolidated result. The bulk file on
 * cdn.finra.org answers 403 now; the query API does not.
 *
 * Three things it will not do, each found by asking:
 *
 *   sortFields returns 400, so the newest settlement date cannot be asked for
 *   directly - it has to be found by trying the dates the schedule implies
 *
 *   the field list has to be trimmed or a row is a kilobyte. With five fields
 *   it is about 150 bytes, which turns a settlement date from 20MB into 3
 *
 *   record-total comes back in a header rather than the body, so paging is
 *   driven by that rather than by running until a short page
 */

const endpoint = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";
const pageSize = 5000;
const fields = [
  "symbolCode",
  "settlementDate",
  "currentShortPositionQuantity",
  "averageDailyVolumeQuantity",
  "daysToCoverQuantity"
];

async function request(config, payload) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(payload),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.secUserAgent || "DATE Market Board admin@date-platform.local"
    },
    method: "POST"
  });

  if (!response.ok) {
    const error = new Error(`FINRA ${response.status} ${response.statusText}`);

    error.status = response.status;

    throw error;
  }

  // A date that was never a settlement answers 200 with an empty body, which
  // is an answer rather than a failure - the candidate list deliberately asks
  // about four days a fortnight to avoid modelling the holiday calendar.
  const body = await response.text();

  if (body.trim() === "") return { rows: [], total: 0 };

  return { rows: JSON.parse(body), total: Number(response.headers.get("record-total") ?? 0) };
}

/** Every row for one settlement date, or an empty list if FINRA has none. */
export async function fetchShortInterest(config, settlementDate) {
  const filter = [{ compareType: "EQUAL", fieldName: "settlementDate", fieldValue: settlementDate }];
  const first = await request(config, { compareFilters: filter, fields, limit: pageSize, offset: 0 });
  const rows = [...first.rows];

  for (let offset = pageSize; offset < first.total; offset += pageSize) {
    const page = await request(config, { compareFilters: filter, fields, limit: pageSize, offset });

    rows.push(...page.rows);
  }

  return rows;
}

export async function saveShortInterest(config, rows) {
  if (rows.length === 0) return 0;

  let saved = 0;

  // Chunked because a settlement date is twenty thousand rows and one statement
  // that wide is a parameter limit away from failing.
  for (let index = 0; index < rows.length; index += 1000) {
    const chunk = rows.slice(index, index + 1000);
    const result = await query(config, `
      INSERT INTO us_short_interest
        (symbol, settlement_date, short_quantity, average_daily_volume, days_to_cover)
      SELECT symbol, settlement_date::date, short_quantity, average_daily_volume, days_to_cover
      FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[])
        AS t(symbol, settlement_date, short_quantity, average_daily_volume, days_to_cover)
      ON CONFLICT (symbol, settlement_date) DO UPDATE
        SET short_quantity = EXCLUDED.short_quantity,
            average_daily_volume = EXCLUDED.average_daily_volume,
            days_to_cover = EXCLUDED.days_to_cover,
            fetched_at = now()
    `, [
      chunk.map((row) => row.symbolCode),
      chunk.map((row) => row.settlementDate),
      chunk.map((row) => row.currentShortPositionQuantity ?? null),
      chunk.map((row) => row.averageDailyVolumeQuantity ?? null),
      chunk.map((row) => row.daysToCoverQuantity ?? null)
    ]);

    saved += result.rowCount;
  }

  return saved;
}

/**
 * The settlement dates a period should contain.
 *
 * FINRA settles mid-month and at month end. The exact day shifts with weekends
 * and holidays, so these are candidates rather than a calendar - a date that
 * was never a settlement simply returns nothing, which costs one request and
 * is cheaper than modelling the exchange holiday list to avoid it.
 */
export function settlementCandidates(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();

    for (const day of [13, 14, 15, 16]) {
      dates.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
    }

    // The last four days of the month, for the same reason.
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    for (const day of [lastDay - 3, lastDay - 2, lastDay - 1, lastDay]) {
      dates.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
    }

    cursor.setUTCMonth(month + 1);
  }

  return dates.filter((date) => date >= from && date <= to);
}

export async function loadStoredSettlements(config) {
  const result = await query(config, "SELECT DISTINCT settlement_date::text AS settlement_date FROM us_short_interest");

  return new Set(result.rows.map((row) => row.settlement_date));
}
