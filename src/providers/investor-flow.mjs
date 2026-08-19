import { query } from "../db/client.mjs";

/**
 * 투자자별 매매동향 from KIS: individuals, foreigners and institutions.
 *
 * Daily, not intraday. The endpoint returns thirty sessions per call and today's
 * row stays blank until the session settles, so this runs after the close and
 * picks up the day it just watched. Measured 2026-08-19 on 바이오니아: the
 * 08-18 row reads 개인 +15,399, 외국인 -20,665, 기관 +5,266 - foreigners
 * distributing into individual buying, which is exactly the shape a price
 * series cannot show.
 *
 * One request per symbol, so it is paced. KIS answers a burst with an error
 * rather than a wait.
 */

const batchSize = 2;
const batchSpacingMs = 200;

function numeric(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (text === "") return null;

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFlow(config, token, symbol) {
  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-investor", config.kis.baseUrl);

  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);

  const response = await fetch(url, {
    headers: {
      appkey: config.kis.appKey ?? "",
      appsecret: config.kis.appSecret ?? "",
      authorization: `Bearer ${token}`,
      custtype: "P",
      tr_id: "FHKST01010900"
    }
  });

  if (!response.ok) return [];

  const data = await response.json();

  if (data?.rt_cd && data.rt_cd !== "0") return [];

  return (data.output ?? [])
    .map((row) => ({
      close: numeric(row.stck_clpr),
      foreignAmount: numeric(row.frgn_ntby_tr_pbmn),
      foreignQty: numeric(row.frgn_ntby_qty),
      individualAmount: numeric(row.prsn_ntby_tr_pbmn),
      individualQty: numeric(row.prsn_ntby_qty),
      institutionAmount: numeric(row.orgn_ntby_tr_pbmn),
      institutionQty: numeric(row.orgn_ntby_qty),
      sessionDate: String(row.stck_bsop_date ?? "").trim(),
      symbol
    }))
    // A blank net quantity is an unsettled session rather than a flat one, and
    // storing it as zero would read as "nobody traded".
    .filter((row) => /^\d{8}$/.test(row.sessionDate) && row.individualQty !== null);
}

export async function saveInvestorFlow(config, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_investor_flow
      (symbol, session_date, close, individual_qty, foreign_qty, institution_qty,
       individual_amount, foreign_amount, institution_amount)
    SELECT symbol, to_date(session_date, 'YYYYMMDD'), close, individual_qty, foreign_qty,
           institution_qty, individual_amount, foreign_amount, institution_amount
    FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[],
                $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])
      AS t(symbol, session_date, close, individual_qty, foreign_qty, institution_qty,
           individual_amount, foreign_amount, institution_amount)
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET close = EXCLUDED.close,
          individual_qty = EXCLUDED.individual_qty,
          foreign_qty = EXCLUDED.foreign_qty,
          institution_qty = EXCLUDED.institution_qty,
          individual_amount = EXCLUDED.individual_amount,
          foreign_amount = EXCLUDED.foreign_amount,
          institution_amount = EXCLUDED.institution_amount,
          fetched_at = now()
  `, [
    rows.map((row) => row.symbol),
    rows.map((row) => row.sessionDate),
    rows.map((row) => row.close),
    rows.map((row) => row.individualQty),
    rows.map((row) => row.foreignQty),
    rows.map((row) => row.institutionQty),
    rows.map((row) => row.individualAmount),
    rows.map((row) => row.foreignAmount),
    rows.map((row) => row.institutionAmount)
  ]);

  return result.rowCount;
}

export async function collectInvestorFlow(config, symbols, { log = () => {} } = {}) {
  const { getAccessToken } = await import("./kis.mjs");
  const token = await getAccessToken(config);
  const answered = new Set();
  let saved = 0;

  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map((symbol) => readFlow(config, token, symbol)));
    const rows = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);

    if (rows.length > 0) {
      // Symbols, not batches. This counted once per batch of two and reported
      // "222/452 symbols" for a run that actually answered 423 of them.
      for (const symbol of new Set(rows.map((row) => row.symbol))) answered.add(symbol);

      saved += await saveInvestorFlow(config, rows);
    }

    if (index + batchSize < symbols.length) await sleep(batchSpacingMs);
  }

  log(`investor flow · ${answered.size}/${symbols.length} symbols · ${saved} rows`);

  return { answered: answered.size, saved };
}
