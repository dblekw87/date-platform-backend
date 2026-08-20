import { getAccessToken } from "./kis.mjs";
import { query } from "../db/client.mjs";

/**
 * 프로그램매매 — 장중에 읽을 수 있는 유일한 수급.
 *
 * 개인·외국인·기관은 장이 끝나고 정산된 뒤에야 나옵니다. 그래서 "지금 누가 들어오고
 * 있나"는 장중에 답할 수 없었고, 2026-08-20에 SOX와 국내 반도체의 관계를 쟀을 때도
 * 가격 반응만 재고 프로그램 매매 자체는 보지 못했습니다.
 *
 * 종목당 요청 하나입니다. 450종목을 5분마다 훑는 것은 무리이므로 그날의 주도주만
 * 봅니다 — 프로그램이 실제로 움직이는 곳이 거기이기도 합니다.
 *
 * 개장 전에는 0행을 돌려줍니다. 2026-08-21 07:04에 삼성전자로 확인했고, 전날 01:00에는
 * 30행이 있었습니다. 그날 세션의 시계열이라 아침에는 비어 있는 것이 정상입니다.
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

async function readProgramTrade(config, token, symbol) {
  const url = new URL("/uapi/domestic-stock/v1/quotations/comp-program-trade-today", config.kis.baseUrl);

  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);

  const response = await fetch(url, {
    headers: {
      appkey: config.kis.appKey ?? "",
      appsecret: config.kis.appSecret ?? "",
      authorization: `Bearer ${token}`,
      custtype: "P",
      tr_id: "FHPPG04650100"
    }
  });

  if (!response.ok) return [];

  const data = await response.json();

  if (data?.rt_cd && data.rt_cd !== "0") return [];

  return (data.output ?? [])
    .map((row) => ({
      accumulatedVolume: numeric(row.acml_vol),
      buyQty: numeric(row.whol_smtn_shnu_vol),
      changeRate: numeric(row.prdy_ctrt),
      netAmount: numeric(row.whol_smtn_ntby_tr_pbmn),
      netAmountChange: numeric(row.whol_ntby_tr_pbmn_icdc),
      netQty: numeric(row.whol_smtn_ntby_qty),
      netQtyChange: numeric(row.whol_ntby_vol_icdc),
      observedTime: String(row.bsop_hour ?? "").trim(),
      price: numeric(row.stck_prpr),
      sellQty: numeric(row.whol_smtn_seln_vol),
      symbol
    }))
    .filter((row) => /^\d{6}$/.test(row.observedTime) && row.netQty !== null);
}

export async function saveProgramTrade(config, { rows, sessionDate }) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_program_trade
      (symbol, session_date, observed_time, price, change_rate, accumulated_volume,
       net_qty, net_amount, buy_qty, sell_qty, net_qty_change, net_amount_change)
    SELECT symbol, $2::date, observed_time, price, change_rate, accumulated_volume,
           net_qty, net_amount, buy_qty, sell_qty, net_qty_change, net_amount_change
    FROM unnest($1::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[],
                $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[],
                $11::numeric[], $12::numeric[])
      AS t(symbol, observed_time, price, change_rate, accumulated_volume,
           net_qty, net_amount, buy_qty, sell_qty, net_qty_change, net_amount_change)
    ON CONFLICT (symbol, session_date, observed_time) DO UPDATE
      SET price = EXCLUDED.price,
          change_rate = EXCLUDED.change_rate,
          accumulated_volume = EXCLUDED.accumulated_volume,
          net_qty = EXCLUDED.net_qty,
          net_amount = EXCLUDED.net_amount,
          buy_qty = EXCLUDED.buy_qty,
          sell_qty = EXCLUDED.sell_qty,
          net_qty_change = EXCLUDED.net_qty_change,
          net_amount_change = EXCLUDED.net_amount_change,
          fetched_at = now()
  `, [
    rows.map((row) => row.symbol),
    sessionDate,
    rows.map((row) => row.observedTime),
    rows.map((row) => row.price),
    rows.map((row) => row.changeRate),
    rows.map((row) => row.accumulatedVolume),
    rows.map((row) => row.netQty),
    rows.map((row) => row.netAmount),
    rows.map((row) => row.buyQty),
    rows.map((row) => row.sellQty),
    rows.map((row) => row.netQtyChange),
    rows.map((row) => row.netAmountChange)
  ]);

  return result.rowCount;
}

export async function collectProgramTrade(config, symbols) {
  if (symbols.length === 0) return { answered: 0, rows: [] };

  const token = await getAccessToken(config);
  const rows = [];
  const answered = new Set();

  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map((symbol) => readProgramTrade(config, token, symbol)));

    for (const result of settled) {
      if (result.status !== "fulfilled" || result.value.length === 0) continue;

      answered.add(result.value[0].symbol);
      rows.push(...result.value);
    }

    if (index + batchSize < symbols.length) await sleep(batchSpacingMs);
  }

  return { answered: answered.size, rows };
}
