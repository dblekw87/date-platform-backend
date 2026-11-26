import { getAccessToken } from "./kis.mjs";
import { saveMarketNewsItems } from "../db/repositories.mjs";

/**
 * 한국투자증권 HTS 뉴스 제목(FHKST01011800)을 market_news_items에 쌓습니다.
 *
 * 2026-11-26 비교(memory news-source-coverage): 재료 기사 자체는 네이버 쪽이 먼저였지만,
 * **같이 오르는 무리**를 알리는 기계 기사는 한투가 빨랐습니다 -- 09:01 인포스탁 "LK삼양 +16.74%,
 * 나라스페이스 +18.11%, 컨텍 +12.37%…"(스피어는 네이버 종목뉴스에 0건). 공시 제목(코스닥·거래소
 * 공시)과 연합 기사도 같이 옵니다 -- 그날 14:42 연합 '화웨이 새 HBM' 기사는 우리 DB에 없었습니다.
 * 사용자: "응 넣어줘."
 *
 * API는 전체 시장 최근 40건만 줍니다. 장 마감 무렵 40건이 70초치였으므로 수집기 틱마다(장중 약 1분,
 * 최소 30초 간격) 받습니다. 몰리는 1분엔 일부가 빠질 수 있습니다.
 * 기사 일련번호가 id라 겹쳐 받아도 한 행입니다. 종목 코드(iscd1~10)가 붙어 오므로
 * related_symbols에 그대로 넣습니다. source에는 매체 이름(인포스탁·연합뉴스…)을, source_detail에
 * 'kis'를 적어 다른 경로와 구별합니다.
 */

const intervalMs = 30_000;
const timeoutMs = 5000;

let lastRunAt = 0;
let running = false;

export function kisNewsDue(now = Date.now()) {
  return !running && now - lastRunAt >= intervalMs;
}

function publishedAt(date, time) {
  return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`).toISOString();
}

export function kisNewsItem(row) {
  const symbols = [];

  for (let index = 1; index <= 10; index += 1) {
    const code = String(row[`iscd${index}`] ?? "").trim();

    if (code) symbols.push(code);
  }

  return {
    id: `kis-${row.cntt_usiq_srno}`,
    label: "",
    originalUrl: "",
    provider: "kis",
    publishedAt: publishedAt(row.data_dt, row.data_tm),
    raw: row,
    region: "KR",
    relatedSymbols: symbols,
    source: String(row.dorg ?? "").trim() || "KIS",
    sourceDetail: "kis",
    text: String(row.hts_pbnt_titl_cntt ?? "").trim()
  };
}

export async function sampleKisNews(config) {
  if (!kisNewsDue() || !config.kis?.appKey) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const token = await getAccessToken(config);
    const url = new URL("/uapi/domestic-stock/v1/quotations/news-title", config.kis.baseUrl);

    for (const key of ["FID_COND_MRKT_CLS_CODE", "FID_INPUT_DATE_1", "FID_INPUT_HOUR_1", "FID_INPUT_ISCD", "FID_INPUT_SRNO", "FID_NEWS_OFER_ENTP_CODE", "FID_RANK_SORT_CLS_CODE", "FID_TITL_CNTT"]) {
      url.searchParams.set(key, "");
    }

    const response = await fetch(url, {
      headers: {
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret ?? "",
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        custtype: "P",
        tr_id: "FHKST01011800"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json();

    if (data?.rt_cd !== "0") return 0;

    const items = (data.output ?? []).filter((row) => row.cntt_usiq_srno && row.hts_pbnt_titl_cntt).map(kisNewsItem);

    return await saveMarketNewsItems(config, items);
  } catch (error) {
    console.warn("kis news failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
