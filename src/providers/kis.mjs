import { readThroughCache } from "../cache.mjs";
import { hasKisCredentials } from "../config.mjs";
import { fetchJson } from "../http.mjs";
import { formatTradingAmount } from "./format.mjs";
import { krRankingVenue, sessionDate } from "./market-session.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
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
export async function getAccessToken(config) {
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
    turnover > 0 &&
    price > 0 &&
    Math.abs(changeRate) >= 1 &&
    (volume > 0 || volumeIncrease > 0)
  );
}

function toLeadingStock(item, index, venue) {
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
    marketLabel: venue === "NX" ? "NXT 프리마켓" : "국내 거래대금",
    // Which exchange these figures came from. Turnover from the two venues
    // describes different books and must never be added together.
    venue: venue === "NX" ? "NXT" : "KRX",
    theme,
    turnoverValue,
    changeRateValue,
    volumeValue: accumulatedVolume,
    // KIS reports the increase against yesterday as a percent; the leadership
    // ranking compares markets, so it is carried as a multiple like the US feed.
    volumeRatioValue: volumeIncrease > 0 ? 1 + volumeIncrease / 100 : undefined,
    burst: volumeIncrease > 0 ? `거래량증가율 ${volumeIncrease.toFixed(1)}%` : `당일 거래량 ${accumulatedVolume.toLocaleString("ko-KR")}주`,
    // Price times shares, because the ranking response carries both and the
    // pairing rule turns on size: the follower has to be small enough to move
    // on somebody else's news.
    marketCapValue: parseNumeric(item.stck_prpr) * parseNumeric(item.lstn_stcn) || null,
    // The DTO has always declared this and the domestic side never sent it, so
    // the board was digging the number back out of the reason sentence.
    rank: Number(rank),
    turnover: formatTradingAmount(turnoverValue, "KRW"),
    intraday: `현재가 ${parseNumeric(item.stck_prpr).toLocaleString("ko-KR")}원 · ${changeRate}`,
    reason: `${theme} · 당일 거래대금 ${formatTradingAmount(turnoverValue, "KRW")} · 거래대금 순위 #${rank}${volumeIncrease > 0 ? ` · 거래량증가 ${volumeIncrease.toFixed(0)}%` : ""}`,
    caution: "뉴스·공시 원문과 장중 거래대금 유지 여부 확인",
    timestamp: new Date().toISOString(),
    source: "kis"
  };
}

async function loadVolumeRank(config, token, venue) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/quotations/volume-rank", {
    FID_COND_MRKT_DIV_CODE: venue,
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
/**
 * The two boards asked separately, because 0000 does not mean both.
 *
 * Measured 2026-08-19 at 17:40. The ranking answers with thirty rows whatever
 * is asked, and 0000 "전체" returns a mixed page rather than the union of the
 * two boards - 본느 at 1.75% sat sixth while 바이오니아 at 29.99%, 인디에프 at
 * 29.85% and 좋은사람들 at 29.84% were absent from it entirely. Asking 0001 and
 * 1001 returns thirty rows each and finds them.
 *
 * Sorting is KIS's and is not by 등락률 in any of the five sort codes, so the
 * board sorts these itself. Two requests instead of one, behind the same
 * thirty-second cache.
 */
const fluctuationBoards = ["0001", "1001"];

async function loadFluctuationRank(config, token, venue) {
  const pages = await Promise.all(fluctuationBoards.map((board) =>
    loadFluctuationPage(config, token, venue, board).catch(() => [])));
  const bySymbol = new Map();

  for (const row of pages.flat()) bySymbol.set(row.mksc_shrn_iscd, row);

  return [...bySymbol.values()];
}

async function loadFluctuationPage(config, token, venue, board) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/ranking/fluctuation", {
    fid_cond_mrkt_div_code: venue,
    fid_cond_scr_div_code: "20170",
    fid_input_iscd: board,
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

/**
 * Whether the domestic market opens on a given day.
 *
 * The weekday check alone is not enough. 광복절 fell on a Saturday in 2026 and
 * moved 대체공휴일 to Monday the 17th, which is a weekday the exchange is shut.
 * Left to itself the collector would have spent that Monday recording the
 * previous close once a minute, and the series would carry a full flat session
 * that never traded — worse than a gap, because clustering would read it as
 * every stock moving together at zero.
 *
 * Holidays are legislated a year ahead, so a week of cache is generous.
 */
const tradingCalendar = createRuntimeState("kr-trading-calendar", () => ({ fetchedAt: 0, byDate: {} }));
const tradingCalendarTtlMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Current price for named symbols, which the ranking endpoints cannot give.
 *
 * Every other domestic call here asks "who is at the top". That is the wrong
 * question for 짝꿍매매: the stock that follows a leader is by definition
 * smaller than it, so it is not in any turnover ranking — 삼화콘덴서 follows
 * 삼성전기 and has never once appeared in the top 38 the board reads. The only
 * way to see it is to ask about it by name.
 *
 * Six at a time. KIS allows more, but this runs inside a board build and the
 * caller asks about a curated list of a few dozen at most.
 */
/**
 * Venue is a parameter because after 15:30 the two books stop agreeing. KRX
 * freezes at the close - measured on 2026-08-18, SK하이닉스 sat at 1,662,000
 * with turnover moving 21 million won across twenty minutes - while NXT traded
 * on to 1,673,000 and 109 billion. Asking J in the evening returns a price that
 * has not existed for hours.
 */
export async function loadKrQuotes(config, symbols, venue = "J") {
  if (!hasKisCredentials(config) || symbols.length === 0) return [];

  const token = await getAccessToken(config);
  const quotes = await requestQuotes(config, token, symbols, venue);
  const missing = symbols.filter((symbol) => !quotes.some((quote) => quote.symbol === symbol));

  // KIS throttles per second and answers a burst with an error rather than a
  // wait, so a refused symbol is not a symbol without an answer. Dropping those
  // silently made candidates come and go between builds — 로보티즈 was behind
  // 현대무벡스 one minute and gone the next, on a rate limit rather than a price.
  if (missing.length === 0) return quotes;

  const retried = await requestQuotes(config, token, missing, venue);

  if (retried.length < missing.length) {
    console.warn(`kis quote: ${missing.length - retried.length} of ${symbols.length} symbols unanswered after retry`);
  }

  return [...quotes, ...retried];
}

/**
 * Two at a time with a breath between, which is about eight a second.
 *
 * Four at 120ms was thirty a second and drew refusals on a third of the list.
 * The batch is cached per symbol for a minute afterwards, so this rate is paid
 * once rather than on every board build.
 */
async function requestQuotes(config, token, symbols, venue) {
  const quotes = [];

  for (let index = 0; index < symbols.length; index += 2) {
    const batch = symbols.slice(index, index + 2);
    const settled = await Promise.allSettled(batch.map((symbol) => loadKrQuote(config, token, symbol, venue)));

    quotes.push(...settled.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));

    if (index + 2 < symbols.length) await new Promise((wait) => setTimeout(wait, 200));
  }

  return quotes;
}

async function loadKrQuote(config, token, symbol, venue = "J") {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/quotations/inquire-price", {
    FID_COND_MRKT_DIV_CODE: venue,
    FID_INPUT_ISCD: symbol
  }), {
    timeoutMs: 3500,
    headers: kisHeaders(config, token, "FHKST01010100")
  });

  if (data?.rt_cd && data.rt_cd !== "0") return null;

  const price = parseNumeric(data?.output?.stck_prpr);

  if (!price) return null;

  return {
    changeRateValue: parseNumeric(data?.output?.prdy_ctrt),
    // Designations, which arrive with every quote and used to be discarded. A
    // stock being 관리종목 or 투자경고 is the first thing a trader checks before
    // taking a 짝꿍, and it was the one thing the board could not say.
    flags: {
      creditAllowed: data?.output?.crdt_able_yn === "Y",
      halted: data?.output?.temp_stop_yn === "Y",
      investmentCaution: data?.output?.invt_caful_yn === "Y",
      liquidation: data?.output?.sltr_yn === "Y",
      managed: data?.output?.mang_issu_cls_code === "Y",
      marketWarn: String(data?.output?.mrkt_warn_cls_code ?? "").trim() || null,
      shortOverheated: data?.output?.short_over_yn === "Y",
      statusCode: String(data?.output?.iscd_stat_cls_code ?? "").trim() || null
    },
    market: "KR",
    // The same definition as the ranking path. hts_avls is also here and
    // disagrees by about 0.7%, which is a different snapshot rather than a
    // different stock - one column cannot hold two definitions.
    marketCapValue: price * parseNumeric(data?.output?.lstn_stcn) || null,
    name: String(data?.output?.hts_kor_isnm ?? "").trim() || symbol,
    priceValue: price,
    symbol,
    // 누적 거래대금 arrives in won already, unlike the ranking rows.
    turnoverValue: parseNumeric(data?.output?.acml_tr_pbmn),
    volumeValue: parseNumeric(data?.output?.acml_vol)
  };
}

export async function isKrMarketOpen(config, date = new Date()) {
  const day = sessionDate("KR", date).replaceAll("-", "");
  const cached = await tradingCalendar.read();

  if (cached.byDate[day] !== undefined && Date.now() - cached.fetchedAt < tradingCalendarTtlMs) {
    return cached.byDate[day];
  }

  try {
    const token = await getAccessToken(config);
    const data = await fetchJson(kisUrl(config, "/uapi/domestic-stock/v1/quotations/chk-holiday", {
      BASS_DT: day,
      CTX_AREA_NK: "",
      CTX_AREA_FK: ""
    }), {
      timeoutMs: 5000,
      headers: kisHeaders(config, token, "CTCA0903R")
    });
    const byDate = { ...cached.byDate };

    (data?.output ?? []).forEach((row) => {
      if (row.bass_dt) byDate[row.bass_dt] = row.opnd_yn === "Y";
    });

    if (byDate[day] === undefined) throw new Error("KIS holiday lookup returned no row for today");

    await tradingCalendar.save({ fetchedAt: Date.now(), byDate });

    return byDate[day];
  } catch (error) {
    // Collecting a day that turns out to be closed is recoverable — the rows
    // can be filtered out later. Skipping a day that was open is not.
    console.warn("trading calendar lookup failed, assuming the market is open", error instanceof Error ? error.message : error);

    return true;
  }
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

/**
 * 국내 지수선물 — 현물 옆에 나란히 두려는 것입니다.
 *
 * 코스닥은 현물지수만 있고 선물이 없었습니다. 선물은 현물과 벌어질 수 있고, 그
 * 간격(베이시스)이 프로그램 매매의 방향을 정합니다.
 *
 * 코드는 연결선물(최근월물)입니다. 2026-08-20에 찾아낸 것:
 *   101000 KOSPI200 · 105000 미니 KOSPI200 · 106000 코스닥150 · 104000 변동성
 *
 * 응답에 장중 시각 필드가 없고 만기일만 옵니다. KRX 선물은 15:45에 닫히므로 그 뒤로
 * 종가가 유지되는데, 현물 카드와 같은 성질이라 따로 표기하지 않습니다.
 */
const futuresQuotes = [
  { id: "kosdaq150-future", kisCode: "106000", label: "KOSDAQ150 선물", note: "KIS 연결선물 · KOSDAQ150 현물과의 간격이 프로그램 방향", symbol: "F-KQ150" },
  { id: "kospi200-future", kisCode: "101000", label: "KOSPI200 선물", note: "KIS 연결선물 · 현물과의 베이시스 확인용", symbol: "F-K200" }
];

async function loadFuturesQuote(config, token, item) {
  const data = await fetchJson(kisUrl(config, "/uapi/domestic-futureoption/v1/quotations/inquire-price", {
    FID_COND_MRKT_DIV_CODE: "F",
    FID_INPUT_ISCD: item.kisCode
  }), {
    timeoutMs: 4000,
    headers: kisHeaders(config, token, "FHMIF10000000")
  });
  const price = parseNumeric(data?.output1?.futs_prpr);

  if (!price) return null;

  const changeRate = parseNumeric(data?.output1?.futs_prdy_ctrt);

  return {
    changeRate: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
    id: item.id,
    instrumentType: "future",
    label: item.label,
    market: "KR",
    note: item.note,
    source: "kis",
    symbol: item.symbol,
    timestamp: new Date().toISOString(),
    tone: changeRate > 0 ? "up" : changeRate < 0 ? "down" : "flat",
    value: price.toLocaleString("ko-KR", { maximumFractionDigits: 2, minimumFractionDigits: 2 })
  };
}

async function loadIndexSnapshots(config, token) {
  const results = await Promise.allSettled([
    ...indexQuotes.map((item) => loadIndexQuote(config, token, item)),
    ...futuresQuotes.map((item) => loadFuturesQuote(config, token, item))
  ]);

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
  // Before the KRX bell the only book trading is NXT's, so the venue is chosen
  // by the clock — and only there, because after 15:30 the ranking is answering
  // about a day that is over. Cached per venue: the two return different numbers for the
  // same stock and one must not be served as the other.
  const venue = krRankingVenue();

  return readThroughCache(`kis:market-board:${venue}`, 30_000, async () => {
    const token = await getAccessToken(config);
    const [volumeRank, fluctuationRank, macroSnapshot] = await Promise.all([
      loadVolumeRank(config, token, venue),
      // A failure here costs the risers, not the board.
      loadFluctuationRank(config, token, venue).catch(() => []),
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
    const ranked = [...bySymbol.values()]
      .sort((left, right) => leadershipScore(right) - leadershipScore(left))
      .map((item, index) => toLeadingStock(item, index, venue))
      .filter(Boolean);
    // ETFs and holding shells were dropped here and the board carried an ETF tab
    // that could never fill. They still cannot join the leaders — an index fund
    // has no theme, and summing its turnover into one would say 반도체 is moving
    // because somebody bought KODEX 200. So they are kept, in their own list.
    // isEtfLike rather than the wider exclusion: a preferred share is also kept
    // out of the leaders, but 두산퓨얼셀2우B on 0.1억 is not an ETF and does not
    // belong in a list labelled one.
    const krEtfLeaders = ranked.filter((stock) => isEtfLike(stock.name)).slice(0, 30);
    const krLeadingStocks = ranked.filter((stock) => !isLikelyNonOperatingEquity(stock.name)).slice(0, 60);

    return {
      flowItems: krLeadingStocks.length > 0 ? buildFlowItems(krLeadingStocks) : [],
      krEtfLeaders,
      krLeadingStocks,
      macroSnapshot,
      marketBrief: buildMarketBrief(macroSnapshot)
    };
  });
}
