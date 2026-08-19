import { fetchText } from "../http.mjs";
import { query } from "../db/client.mjs";

/**
 * FINRA's daily short volume file, one row per symbol per session.
 *
 * Not the same thing as short interest. us_short_interest is the settled
 * position twice a month; this is how much of a single day's volume was sold
 * short, published the next morning for every symbol that traded.
 *
 * One request per session date, no key and no quota. A file that does not exist
 * yet - today's before FINRA publishes, or a holiday - answers 404, which is a
 * day with no data rather than a failure.
 */

const fileUrl = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol";

function numeric(value) {
  const parsed = Number(String(value ?? "").trim());

  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadShortVolume(sessionDate) {
  const compact = sessionDate.replaceAll("-", "");
  let text;

  try {
    text = await fetchText(`${fileUrl}${compact}.txt`, { timeoutMs: 15_000 });
  } catch {
    return [];
  }

  const [header, ...lines] = text.split("\n");

  if (!header?.startsWith("Date|Symbol")) return [];

  return lines.flatMap((line) => {
    const [, symbol, shortVolume, shortExempt, totalVolume] = line.trim().split("|");

    // The file ends with a record-count line that has no symbol.
    if (!symbol || !totalVolume) return [];

    return [{
      sessionDate,
      shortExemptVolume: numeric(shortExempt),
      shortVolume: numeric(shortVolume),
      symbol,
      totalVolume: numeric(totalVolume)
    }];
  });
}

export async function saveShortVolume(config, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO us_short_volume (symbol, session_date, short_volume, short_exempt_volume, total_volume)
    SELECT symbol, session_date::date, short_volume, short_exempt_volume, total_volume
    FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[])
      AS t(symbol, session_date, short_volume, short_exempt_volume, total_volume)
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET short_volume = EXCLUDED.short_volume,
          short_exempt_volume = EXCLUDED.short_exempt_volume,
          total_volume = EXCLUDED.total_volume,
          fetched_at = now()
  `, [
    rows.map((row) => row.symbol),
    rows.map((row) => row.sessionDate),
    rows.map((row) => row.shortVolume),
    rows.map((row) => row.shortExemptVolume),
    rows.map((row) => row.totalVolume)
  ]);

  return result.rowCount;
}

/** The sessions already stored, so a re-run only fetches what is missing. */
export async function storedShortVolumeDates(config) {
  const result = await query(config, "SELECT DISTINCT session_date::text AS session_date FROM us_short_volume");

  return new Set(result.rows.map((row) => row.session_date));
}
