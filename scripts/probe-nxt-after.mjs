import { readConfig } from "../src/config.mjs";
import { readStoredToken } from "../src/providers/token-store.mjs";

/**
 * Does KIS answer the NX venue after the KRX close?
 *
 * NXT trades an after-market to 20:00, four and a half hours the collector
 * currently records nothing in. Whether that is worth collecting turns on a
 * question no one here has answered: the pre-market read was proven on
 * 2026-08-18 with 476 rows, but nothing has ever asked KIS for NX in the
 * evening, and the venue is chosen by a clock that returns J from 09:00
 * onwards. Extending the collector before knowing would risk the worse
 * outcome - asking a closed KRX and recording yesterday's close as if it were
 * a live print.
 *
 * So this asks both books the same question and prints what comes back. If NX
 * returns prices that differ from J and move between two runs, the after-market
 * is readable and worth wiring up. If it mirrors J or answers empty, the idea
 * dies here and no code was written for it.
 *
 * Reuses the stored token rather than requesting one: KIS rations issuance and
 * the collector is holding a valid token.
 *
 *   npm run probe:nxt-after
 */

const config = readConfig();

function kisUrl(path, params) {
  const url = new URL(path, config.kis.baseUrl);

  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  return url.toString();
}

function kisHeaders(token, trId) {
  return {
    appkey: config.kis.appKey ?? "",
    appsecret: config.kis.appSecret ?? "",
    authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
    custtype: "P",
    tr_id: trId
  };
}

async function volumeRank(token, venue) {
  const response = await fetch(kisUrl("/uapi/domestic-stock/v1/quotations/volume-rank", {
    FID_BLNG_CLS_CODE: "3",
    FID_COND_MRKT_DIV_CODE: venue,
    FID_COND_SCR_DIV_CODE: "20171",
    FID_DIV_CLS_CODE: "1",
    FID_INPUT_DATE_1: "",
    FID_INPUT_ISCD: "0000",
    FID_INPUT_PRICE_1: "",
    FID_INPUT_PRICE_2: "",
    FID_TRGT_CLS_CODE: "111111111",
    FID_TRGT_EXLS_CLS_CODE: "000000",
    FID_VOL_CNT: ""
  }), { headers: kisHeaders(token, "FHPST01710000") });
  const body = await response.json().catch(() => null);

  return { body, status: response.status };
}

const stored = await readStoredToken("kis");

if (!stored) {
  console.log("저장된 KIS 토큰이 없습니다. 백엔드가 떠 있는지 확인하세요.");
  process.exit(1);
}

const stamp = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

console.log(`\nNXT 애프터마켓 프로브 · ${stamp}\n`);

for (const venue of ["NX", "J"]) {
  const { body, status } = await volumeRank(stored.accessToken, venue);
  const rows = body?.output ?? [];

  console.log(`  ${venue}  HTTP ${status}  rt_cd=${body?.rt_cd ?? "-"}  ${body?.msg1?.trim() ?? ""}`);
  console.log(`      ${rows.length}종목`);

  for (const row of rows.slice(0, 5)) {
    // 현재가 and 거래대금 together are the tell: a closed book repeats the
    // close with a frozen turnover, a live one does not.
    console.log(`      ${String(row.hts_kor_isnm ?? "").padEnd(14)} ${String(row.stck_prpr ?? "").padStart(9)}원  ${String(row.prdy_ctrt ?? "").padStart(7)}%  거래대금 ${String(row.acml_tr_pbmn ?? "").padStart(14)}`);
  }

  console.log("");
}

console.log("  판단 기준: NX의 현재가·거래대금이 J와 다르고, 몇 분 뒤 다시 돌렸을 때");
console.log("  움직여 있으면 애프터마켓이 읽히는 것입니다. J와 같으면 같은 책을 보는 것이고,");
console.log("  0종목이면 KIS가 그 시간대 NX를 주지 않는 것입니다.\n");

process.exit(0);
