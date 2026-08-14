import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";
import { formatTradingAmount } from "./format.mjs";
import { classifyTheme, isEtfLike, isNonOperatingEquity } from "./themes.mjs";
import { readStoredToken, writeStoredToken } from "./token-store.mjs";

const tokenCacheSkewMs = 60_000;
let tokenCache;
let tokenRequest;

const indexQuotes = [
  { id: "kospi-day-future", label: "KOSPI", symbol: "KOSPI", kisCode: "0001", note: "KIS 국내업종 현재지수" },
  { id: "kosdaq-night-future", label: "KOSDAQ", symbol: "KOSDAQ", kisCode: "1001", note: "KIS 국내업종 현재지수" },
  { id: "kospi-night-future", label: "KOSPI200", symbol: "K200", kisCode: "2001", note: "KIS 국내업종 현재지수" }
];

function kisUrl(config, path, params = {}) {
  const url = new URL(path, config.kis.baseUrl);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

async function requestAccessToken(config) {
  const now = Date.now();
  const data = await fetchJson(kisUrl(config, "/oauth2/tokenP"), {
    method: "POST",
    timeoutMs: 5000,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: config.kis.appKey,
      appsecret: config.kis.appSecret
    })
  });

  if (!data?.access_token) {
    throw new Error("KIS token missing");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + Math.max((data.expires_in ?? 86_400) - 300, 60) * 1000
  };

  await writeStoredToken("kis", tokenCache);

  return tokenCache.accessToken;
}

// KIS issues tokens sparingly, so concurrent cold-start calls must share one
// request and restarts must reuse the token already on disk.
async function getAccessToken(config) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + tokenCacheSkewMs) {
    return tokenCache.accessToken;
  }

  if (tokenRequest) return tokenRequest;

  tokenRequest = (async () => {
    const stored = await readStoredToken("kis");

    if (stored) {
      tokenCache = stored;

      return stored.accessToken;
    }

    return requestAccessToken(config);
  })().finally(() => {
    tokenRequest = undefined;
  });

  return tokenRequest;
}

function kisHeaders(config, token, trId) {
  return {
    authorization: `Bearer ${token}`,
    appkey: config.kis.appKey ?? "",
    appsecret: config.kis.appSecret ?? "",
    tr_id: trId,
    custtype: "P",
    "Content-Type": "application/json; charset=UTF-8"
  };
}

function parseNumeric(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const numeric = normalized ? Number(normalized) : 0;

  return Number.isFinite(numeric) ? numeric : 0;
}

function formatSignedPercent(value) {
  const numeric = parseNumeric(value);

  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}


function formatValue(value, precision = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "확인 중";

  return value.toLocaleString("ko-KR", {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision
  });
}

function formatChangeRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneFromChange(change) {
  if (!change) return "flat";

  return change > 0 ? "up" : "down";
}

function isLikelyNonOperatingEquity(name) {
  return isEtfLike(name) || isNonOperatingEquity(name);
}

/**
 * Ranks the day's leading stocks.
 *
 * Turnover is the base — money committed is the hardest signal — but ordering
 * on turnover alone just lists the same mega caps every session. A leader is
 * turnover *plus* a move: price rising and volume running above its own normal.
 * The log scale means a 10x turnover gap is worth roughly an 8% price move, so
 * size still dominates without burying a mid-cap that is genuinely leading.
 */
function leadershipScore(item) {
  const turnover = parseNumeric(item.acml_tr_pbmn || item.avrg_tr_pbmn);
  const changeRate = parseNumeric(item.prdy_ctrt);
  const volumeIncrease = parseNumeric(item.vol_inrt);

  return Math.log10(Math.max(turnover, 1)) * 10
    + Math.max(changeRate, 0) * 1.2
    + Math.min(Math.max(volumeIncrease, 0), 500) / 25;
}

function isUsableLeaderCandidate(item) {
  const symbol = item.mksc_shrn_iscd?.trim();
  const name = item.hts_kor_isnm?.trim();
  const turnover = parseNumeric(item.acml_tr_pbmn || item.avrg_tr_pbmn);
  const price = parseNumeric(item.stck_prpr);
  const changeRate = parseNumeric(item.prdy_ctrt);
  const volume = parseNumeric(item.acml_vol);
  const volumeIncrease = parseNumeric(item.vol_inrt);

  return Boolean(
    symbol &&
    name &&
    !isLikelyNonOperatingEquity(name) &&
    turnover > 0 &&
    price > 0 &&
    Math.abs(changeRate) >= 1 &&
    (volume > 0 || volumeIncrease > 0)
  );
}

function toLeadingStock(item, index) {
  const symbol = item.mksc_shrn_iscd?.trim();
  const name = item.hts_kor_isnm?.trim();

  if (!symbol || !name || !isUsableLeaderCandidate(item)) return null;

  const changeRate = formatSignedPercent(item.prdy_ctrt);
  const volumeIncrease = parseNumeric(item.vol_inrt);
  const accumulatedVolume = parseNumeric(item.acml_vol);
  const rank = item.data_rank?.trim() || String(index + 1);
  const turnoverValue = parseNumeric(item.acml_tr_pbmn || item.avrg_tr_pbmn);
  const changeRateValue = parseNumeric(item.prdy_ctrt);
  const theme = classifyTheme(symbol, name);

  return {
    id: `kis-kr-leader-${symbol}`,
    symbol,
    name,
    market: "KR",
    marketLabel: "국내 거래대금",
    theme,
    turnoverValue,
    changeRateValue,
    volumeValue: accumulatedVolume,
    // KIS reports the increase against yesterday as a percent; the leadership
    // ranking compares markets, so it is carried as a multiple like the US feed.
    volumeRatioValue: volumeIncrease > 0 ? 1 + volumeIncrease / 100 : undefined,
    burst: volumeIncrease > 0 ? `거래량증가율 ${volumeIncrease.toFixed(1)}%` : `당일 거래량 ${accumulatedVolume.toLocaleString("ko-KR")}주`,
    turnover: formatTradingAmount(turnoverValue, "KRW"),
    intraday: `현재가 ${parseNumeric(item.stck_prpr).toLocaleString("ko-KR")}원 · ${changeRate}`,
    reason: `${theme} · 당일 거래대금 ${formatTradingAmount(turnoverValue, "KRW")} · 거래대금 순위 #${rank}${volumeIncrease > 0 ? ` · 거래량증가 ${volumeIncrease.toFixed(0)}%` : ""}`,
    caution: "뉴스·공시 원문과 장중 거래대금 유지 여부 확인",
    timestamp: new Date().toISOString(),
    source: "kis"
  };
}

async function loadVolumeRank(config, token) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/quotations/volume-rank", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_COND_SCR_DIV_CODE: "20171",
    FID_INPUT_ISCD: "0000",
    FID_DIV_CLS_CODE: "1",
    FID_BLNG_CLS_CODE: "3",
    FID_TRGT_CLS_CODE: "111111111",
    FID_TRGT_EXLS_CLS_CODE: "000000",
    FID_INPUT_PRICE_1: "",
    FID_INPUT_PRICE_2: "",
    FID_VOL_CNT: "",
    FID_INPUT_DATE_1: ""
  }), {
    timeoutMs: 5000,
    headers: kisHeaders(config, token, "FHPST01710000")
  });

  if (data?.rt_cd && data.rt_cd !== "0") {
    throw new Error(`KIS volume-rank ${data.msg_cd ?? "error"}`);
  }

  return data?.output ?? [];
}

/**
 * The day's biggest risers, which the turnover ranking structurally cannot show.
 *
 * A theme is a group of stocks moving together, and the ones that move hardest
 * are rarely the ones that trade most: a turnover ranking returns SK하이닉스,
 * 삼성전자 and a row of index ETFs every session, so a 상한가 spread across five
 * mid caps never enters the candidate pool at all. Ranking by change rate is the
 * only way those names are seen.
 */
async function loadFluctuationRank(config, token) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/ranking/fluctuation", {
    fid_cond_mrkt_div_code: "J",
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: "0000",
    fid_rank_sort_cls_code: "0",
    fid_input_cnt_1: "0",
    fid_prc_cls_code: "0",
    fid_input_price_1: "",
    fid_input_price_2: "",
    fid_vol_cnt: "",
    fid_trgt_cls_code: "0",
    fid_trgt_exls_cls_code: "0",
    fid_div_cls_code: "0",
    fid_rsfl_rate1: "",
    fid_rsfl_rate2: ""
  }), {
    timeoutMs: 5000,
    headers: kisHeaders(config, token, "FHPST01700000")
  });

  if (data?.rt_cd && data.rt_cd !== "0") {
    throw new Error(`KIS fluctuation ${data.msg_cd ?? "error"}`);
  }

  return (data?.output ?? []).map((item) => {
    const price = parseNumeric(item.stck_prpr);
    const volume = parseNumeric(item.acml_vol);

    return {
      ...item,
      // This ranking names a different symbol field and omits turnover
      // entirely, so both are filled in to match the turnover ranking's shape.
      // Price times volume is the same approximation the US feed uses, and it
      // only applies to names the exact figure did not already cover.
      mksc_shrn_iscd: item.stck_shrn_iscd,
      acml_tr_pbmn: String(price * volume)
    };
  });
}

async function loadIndexQuote(config, token, indexConfig) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/quotations/inquire-index-price", {
    FID_COND_MRKT_DIV_CODE: "U",
    FID_INPUT_ISCD: indexConfig.kisCode
  }), {
    timeoutMs: 3500,
    headers: kisHeaders(config, token, "FHPUP02100000")
  });

  if (data?.rt_cd && data.rt_cd !== "0") {
    throw new Error(`KIS index ${data.msg_cd ?? "error"}`);
  }

  const current = parseNumeric(data?.output?.bstp_nmix_prpr);

  if (!current) return null;

  const change = parseNumeric(data?.output?.bstp_nmix_prdy_vrss);
  const changeRate = parseNumeric(data?.output?.bstp_nmix_prdy_ctrt);

  return {
    id: indexConfig.id,
    label: indexConfig.label,
    market: "KR",
    instrumentType: "index",
    symbol: indexConfig.symbol,
    value: formatValue(current, 2),
    change: formatValue(change, 2),
    changeRate: formatChangeRate(changeRate),
    tone: toneFromChange(changeRate),
    note: indexConfig.note,
    timestamp: new Date().toISOString(),
    source: "kis"
  };
}

async function loadIndexSnapshots(config, token) {
  const results = await Promise.allSettled(indexQuotes.map((item) => loadIndexQuote(config, token, item)));

  return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

function buildMarketBrief(macroSnapshot) {
  const kospi = macroSnapshot.find((item) => item.id === "kospi-day-future");
  const kosdaq = macroSnapshot.find((item) => item.id === "kosdaq-night-future");
  const kospi200 = macroSnapshot.find((item) => item.id === "kospi-night-future");

  if (!kospi && !kosdaq && !kospi200) return [];

  return [
    {
      id: "kr-market",
      region: "국내 시황",
      title: `${kospi ? `KOSPI ${kospi.changeRate ?? kospi.value}` : "KOSPI 확인 중"}, ${kosdaq ? `KOSDAQ ${kosdaq.changeRate ?? kosdaq.value}` : "KOSDAQ 확인 중"} 흐름입니다.`,
      points: [
        kospi ? `KOSPI ${kospi.value}${kospi.changeRate ? ` · ${kospi.changeRate}` : ""}` : "KOSPI 확인 대기",
        kospi200 ? `KOSPI200 ${kospi200.value}${kospi200.changeRate ? ` · ${kospi200.changeRate}` : ""}` : "KOSPI200 확인 대기",
        kosdaq ? `KOSDAQ ${kosdaq.value}${kosdaq.changeRate ? ` · ${kosdaq.changeRate}` : ""}` : "KOSDAQ 확인 대기"
      ],
      source: "kis",
      timestamp: new Date().toISOString()
    }
  ];
}

function buildFlowItems(leaders) {
  const top = leaders[0];
  const timestamp = new Date().toISOString();

  return [
    {
      id: "flow-turnover",
      label: "거래대금",
      status: top ? `${top.name} 선두` : "확인 중",
      detail: top ? `KIS 거래대금순 기준 ${top.turnover} · ${top.intraday}` : "KIS 거래대금순 데이터를 확인합니다.",
      source: "kis",
      timestamp
    },
    {
      id: "flow-volume",
      label: "거래량",
      status: leaders.length > 0 ? `${leaders.length}개 포착` : "확인 중",
      detail: "거래량 증가율과 누적 거래대금을 함께 봅니다.",
      source: "kis",
      timestamp
    }
  ];
}

export async function loadKisMarketBoard(config) {
  return readThroughCache("kis:market-board", 30_000, async () => {
    const token = await getAccessToken(config);
    const [volumeRank, fluctuationRank, macroSnapshot] = await Promise.all([
      loadVolumeRank(config, token),
      // A failure here costs the risers, not the board.
      loadFluctuationRank(config, token).catch(() => []),
      loadIndexSnapshots(config, token)
    ]);
    // Two rankings answer two different questions — where the money is, and what
    // is actually moving — and a theme needs both. Turnover rows overwrite on a
    // duplicate because they carry the exchange's own figure rather than a
    // price-times-volume estimate.
    const bySymbol = new Map(fluctuationRank.map((item) => [item.mksc_shrn_iscd?.trim(), item]));

    volumeRank.forEach((item) => bySymbol.set(item.mksc_shrn_iscd?.trim(), item));

    // Deep enough that a theme holds several names, not just its top stock —
    // the board groups these by theme and lists every member.
    const krLeadingStocks = [...bySymbol.values()]
      .sort((left, right) => leadershipScore(right) - leadershipScore(left))
      .map(toLeadingStock)
      .filter(Boolean)
      .slice(0, 60);

    return {
      flowItems: krLeadingStocks.length > 0 ? buildFlowItems(krLeadingStocks) : [],
      krLeadingStocks,
      macroSnapshot,
      marketBrief: buildMarketBrief(macroSnapshot)
    };
  });
}
