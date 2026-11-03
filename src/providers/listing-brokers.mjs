import { query } from "../db/client.mjs";
import { getAccessToken } from "./kis.mjs";
import { loadListingsOn } from "./kr-listing-alert.mjs";

/**
 * 신규상장 첫날 거래원 상위 5곳 -- 공모 물량이 언제 나오나.
 *
 * 2026-11-03 사용자가 물었습니다: 신규주는 기관·외국인이 언제 파는지 다른 종목처럼
 * 실시간으로 볼 수 없나. 투자자별은 장이 끝나야 확정되고, 장중 기관 추정은 부호부터
 * 틀려 쓰지 않으며(memory intraday-flow-endpoints), 상장 첫날 프로그램매매는 빈
 * 응답입니다. 거래원은 장중에 나옵니다. 그날 래블업 마감 기준 주관사 NH투자증권
 * 창구가 매도 505만·매수 355만 주로 약 150만 주 순매도였고, 기관 확정 순매도가
 * 149만 주였습니다 -- 공모 물량이 주관사 창구로 나온다는 첫 표본입니다.
 *
 * 사용자 관찰("동시호가 고점이면 바로 팔고, 시초가가 낮으면 어느 정도 올랐다가
 * 10시 전에 뺀다")을 재려고 시각별로 쌓습니다. 기록만 하고 알림은 없습니다.
 *
 * 그날 상장 종목은 KIND 이름으로 찾고, 코드는 그날 가격 표본에서 이름으로 맞춥니다.
 * 상장 당일엔 kr_listings도 유니버스도 아직 비어 있습니다.
 */

const openMinute = 9 * 60;
const closeMinute = 15 * 60 + 35;

function numeric(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (text === "") return null;

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

let symbolDay = null;
let symbolCache = [];

async function listingSymbols(config, day) {
  if (symbolDay === day && symbolCache.length) return symbolCache;

  const names = (await loadListingsOn(config, day)).map((stock) => stock.name);

  if (!names.length) {
    symbolDay = day;
    symbolCache = [];

    return [];
  }

  const { rows } = await query(config, `
    SELECT DISTINCT symbol FROM market_price_samples
     WHERE session_date = $1 AND market = 'KR' AND name = ANY($2::text[])
  `, [day, names]);

  symbolDay = day;
  symbolCache = rows.map((row) => row.symbol);

  return symbolCache;
}

async function readMembers(config, token, symbol) {
  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-member", config.kis.baseUrl);

  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);

  const response = await fetch(url, {
    headers: {
      appkey: config.kis.appKey ?? "",
      appsecret: config.kis.appSecret ?? "",
      authorization: `Bearer ${token}`,
      custtype: "P",
      tr_id: "FHKST01010600"
    }
  });

  if (!response.ok) return [];

  const data = await response.json();
  const row = Array.isArray(data?.output) ? data.output[0] : data?.output;

  if (!row || (data?.rt_cd && data.rt_cd !== "0")) return [];

  const entries = [];

  for (const [side, prefix] of [["sell", "seln"], ["buy", "shnu"]]) {
    for (let rank = 1; rank <= 5; rank += 1) {
      const name = String(row[`${prefix}_mbcr_name${rank}`] ?? "").trim();

      if (!name) continue;

      entries.push({
        brokerName: name,
        brokerNo: String(row[`${prefix}_mbcr_no${rank}`] ?? "").trim() || null,
        globalBuyQty: numeric(row.glob_total_shnu_qty),
        globalSellQty: numeric(row.glob_total_seln_qty),
        isGlobal: row[`${prefix}_mbcr_glob_yn_${rank}`] === "Y",
        qty: numeric(row[`total_${prefix}_qty${rank}`]),
        rank,
        share: numeric(row[`${prefix}_mbcr_rlim${rank}`]),
        side
      });
    }
  }

  return entries;
}

export async function collectListingBrokers(config, { day, minute }) {
  if (minute < openMinute || minute > closeMinute) return 0;

  const symbols = await listingSymbols(config, day);

  if (!symbols.length) return 0;

  const token = await getAccessToken(config);
  const observedAt = new Date().toISOString();
  let saved = 0;

  for (const symbol of symbols) {
    const entries = await readMembers(config, token, symbol);

    if (!entries.length) continue;

    const result = await query(config, `
      INSERT INTO kr_listing_brokers
        (symbol, session_date, observed_at, side, rank, broker_no, broker_name, qty, share,
         is_global, global_sell_qty, global_buy_qty)
      SELECT $1, $2::date, $3::timestamptz, side, rank, broker_no, broker_name, qty, share,
             is_global, global_sell_qty, global_buy_qty
        FROM unnest($4::text[], $5::smallint[], $6::text[], $7::text[], $8::numeric[], $9::numeric[],
                    $10::boolean[], $11::numeric[], $12::numeric[])
          AS t(side, rank, broker_no, broker_name, qty, share, is_global, global_sell_qty, global_buy_qty)
      ON CONFLICT DO NOTHING
    `, [
      symbol,
      day,
      observedAt,
      entries.map((entry) => entry.side),
      entries.map((entry) => entry.rank),
      entries.map((entry) => entry.brokerNo),
      entries.map((entry) => entry.brokerName),
      entries.map((entry) => entry.qty),
      entries.map((entry) => entry.share),
      entries.map((entry) => entry.isGlobal),
      entries.map((entry) => entry.globalSellQty),
      entries.map((entry) => entry.globalBuyQty)
    ]);

    saved += result.rowCount ?? 0;
  }

  return saved;
}
