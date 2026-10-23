import { query } from "../db/client.mjs";

/**
 * 국내 공매도와 대차, 종목별 일별 (KIS).
 *
 * 두 엔드포인트 모두 한 번에 100행까지만 주고, 창이 그보다 길면 **최근 100행**을
 * 돌려줍니다(2026-10-23 확인: 2025-01-01~2026-10-23을 물으면 2026-05-28부터 옴).
 * 그래서 과거를 채울 때는 창을 100거래일보다 짧게 잘라 여러 번 묻습니다.
 *
 * 공매도는 output2, 대차는 output1에 행이 옵니다 -- 이름이 같아 보여도 자리가 다릅니다.
 */

function numeric(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (text === "") return null;

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(yyyymmdd) {
  const text = String(yyyymmdd ?? "").trim();

  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

async function kisGet(config, token, path, trId, params) {
  const url = new URL(path, config.kis.baseUrl);

  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: {
      appkey: config.kis.appKey ?? "",
      appsecret: config.kis.appSecret ?? "",
      authorization: `Bearer ${token}`,
      custtype: "P",
      tr_id: trId
    }
  });

  if (!response.ok) throw new Error(`${trId} HTTP ${response.status}`);

  const data = await response.json();

  if (data?.rt_cd && data.rt_cd !== "0") throw new Error(`${trId} ${data.msg_cd ?? ""} ${data.msg1 ?? ""}`.trim());

  return data;
}

/** from/to are YYYYMMDD. */
export async function readShortSale(config, token, symbol, { from, to }) {
  const data = await kisGet(config, token, "/uapi/domestic-stock/v1/quotations/daily-short-sale", "FHPST04830000", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_DATE_1: from,
    FID_INPUT_DATE_2: to,
    FID_INPUT_ISCD: symbol
  });

  return (data.output2 ?? [])
    .map((row) => ({
      avgPrice: numeric(row.avrg_prc),
      close: numeric(row.stck_clpr),
      sessionDate: isoDate(row.stck_bsop_date),
      shortAmount: numeric(row.ssts_tr_pbmn),
      shortQty: numeric(row.ssts_cntg_qty),
      shortRatio: numeric(row.ssts_vol_rlim),
      symbol,
      volume: numeric(row.acml_vol)
    }))
    .filter((row) => row.sessionDate);
}

/** from/to are YYYYMMDD. */
export async function readLending(config, token, symbol, { from, to }) {
  const data = await kisGet(config, token, "/uapi/domestic-stock/v1/quotations/daily-loan-trans", "HHPST074500C0", {
    CTS: "",
    END_DATE: to,
    MKSC_SHRN_ISCD: symbol,
    MRKT_DIV_CLS_CODE: "3",
    START_DATE: from
  });

  return (Array.isArray(data.output1) ? data.output1 : [])
    .map((row) => ({
      balanceAmount: numeric(row.rmnd_amt),
      balanceQty: numeric(row.rmnd_stcn),
      changeQty: numeric(row.prdy_rmnd_vrss),
      newQty: numeric(row.new_stcn),
      repaidQty: numeric(row.rdmp_stcn),
      sessionDate: isoDate(row.bsop_date),
      symbol
    }))
    .filter((row) => row.sessionDate);
}

export async function saveShortSale(config, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_short_sale
      (symbol, session_date, close, volume, short_qty, short_amount, short_ratio, avg_price)
    SELECT DISTINCT ON (symbol, session_date)
           symbol, session_date, close, volume, short_qty, short_amount, short_ratio, avg_price
      FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[], $5::numeric[],
                  $6::numeric[], $7::numeric[], $8::numeric[])
        WITH ORDINALITY
        AS t(symbol, session_date, close, volume, short_qty, short_amount, short_ratio, avg_price, ord)
     ORDER BY symbol, session_date, ord DESC
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          short_qty = EXCLUDED.short_qty,
          short_amount = EXCLUDED.short_amount,
          short_ratio = EXCLUDED.short_ratio,
          avg_price = EXCLUDED.avg_price,
          fetched_at = now()
  `, [
    rows.map((row) => row.symbol),
    rows.map((row) => row.sessionDate),
    rows.map((row) => row.close),
    rows.map((row) => row.volume),
    rows.map((row) => row.shortQty),
    rows.map((row) => row.shortAmount),
    rows.map((row) => row.shortRatio),
    rows.map((row) => row.avgPrice)
  ]);

  return result.rowCount;
}

export async function saveLending(config, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_stock_lending
      (symbol, session_date, new_qty, repaid_qty, change_qty, balance_qty, balance_amount)
    SELECT DISTINCT ON (symbol, session_date)
           symbol, session_date, new_qty, repaid_qty, change_qty, balance_qty, balance_amount
      FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[], $5::numeric[],
                  $6::numeric[], $7::numeric[])
        WITH ORDINALITY
        AS t(symbol, session_date, new_qty, repaid_qty, change_qty, balance_qty, balance_amount, ord)
     ORDER BY symbol, session_date, ord DESC
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET new_qty = EXCLUDED.new_qty,
          repaid_qty = EXCLUDED.repaid_qty,
          change_qty = EXCLUDED.change_qty,
          balance_qty = EXCLUDED.balance_qty,
          balance_amount = EXCLUDED.balance_amount,
          fetched_at = now()
  `, [
    rows.map((row) => row.symbol),
    rows.map((row) => row.sessionDate),
    rows.map((row) => row.newQty),
    rows.map((row) => row.repaidQty),
    rows.map((row) => row.changeQty),
    rows.map((row) => row.balanceQty),
    rows.map((row) => row.balanceAmount)
  ]);

  return result.rowCount;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 저녁 한 번, 그날 본 종목의 최근 열흘. 공매도 당일치는 마감 직후 나오지만 대차
 * 당일치는 밤에야 나오므로, 열흘 창으로 물어 어제 빠진 대차를 오늘 메웁니다.
 */
export async function collectShortLending(config, token, symbols, { from, to, pauseMs = 150 }) {
  let saved = 0;
  let failed = 0;

  for (const symbol of symbols) {
    try {
      saved += await saveShortSale(config, await readShortSale(config, token, symbol, { from, to }));
      await sleep(pauseMs);
      saved += await saveLending(config, await readLending(config, token, symbol, { from, to }));
      await sleep(pauseMs);
    } catch {
      failed += 1;
    }
  }

  return { failed, saved };
}
