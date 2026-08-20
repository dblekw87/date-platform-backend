import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { formatShareVolume, formatTradingAmount } from "./format.mjs";
import { classifyTheme } from "./themes.mjs";
import { loadUsEtfLeaders } from "./us-etf.mjs";

/**
 * Public market data: index and commodity futures, BTC, USD/KRW, the US 10-year
 * yield, and the US leaders board — all from keyless public endpoints. Every
 * source is optional; a failure drops that one row rather than the whole
 * snapshot.
 */

const cacheTtlMs = 15_000;
const leadersCacheTtlMs = 60_000;
const screenerUrl = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved";
// The screener rejects a default client identifier.
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * 매크로 카드의 시세 — 대체 ETF가 아니라 실제 선물입니다.
 *
 * 원래는 Finnhub 무료 티어로 SPY·QQQ·SOXX·GLD·USO를 읽었습니다. 그 ETF들은 미국
 * 정규장에만 거래되므로 국내장이 열리는 시간에는 값이 얼어붙습니다 — 2026-08-20
 * 21:41에 화면을 보면 다섯 장 전부 05:00에 멈춰 있었고, 개장 전 기준점으로 보라는
 * 카드가 전날 종가를 보여주고 있었습니다.
 *
 * 지수 선물은 거의 24시간 거래됩니다. 같은 시각에 재보니 NQ=F·ES=F·YM=F·CL=F·GC=F가
 * 전부 10분 전 값이었습니다. 키도 필요 없습니다.
 *
 * 반도체만 선물이 없습니다. `^SOX` 원지수는 미국 현물장에만 산출돼 같은 시각 948분
 * 전이었고 ETF보다 오히려 낡습니다. 대신 SOXX를 **시간외 포함**으로 읽으면 1분 전이
 * 됩니다(끄면 1,029분 전). 그래도 국내 장중은 미국이 완전히 닫힌 시간이라, 그때는
 * 직전 시간외 종가입니다 — note에 그렇게 적습니다.
 */

const yahooQuotes = [
  { id: "sp500-future", instrumentType: "future", label: "S&P 500 선물", market: "US", note: "E-mini S&P 500 · 거의 24시간 거래", symbol: "ES=F" },
  { id: "nasdaq-future", instrumentType: "future", label: "NASDAQ 100 선물", market: "US", note: "E-mini NASDAQ 100 · 거의 24시간 거래", symbol: "NQ=F" },
  { id: "dow-future", instrumentType: "future", label: "DOW 선물", market: "US", note: "E-mini DOW 30 · NASDAQ과 갈리면 로테이션 신호", symbol: "YM=F" },
  // Extended hours on purpose — see the note above.
  { id: "phlx-sox", instrumentType: "index", label: "반도체 ETF", market: "US", note: "SOX 원지수에는 선물이 없어 SOXX · 미국 시간외까지 반영", prePost: true, symbol: "SOXX" },
  { id: "nikkei-future", instrumentType: "future", label: "NIKKEI225 선물", market: "GLOBAL", note: "CME NIKKEI225 · 도쿄 현물은 마감 후 멈추므로 선물", symbol: "NIY=F" },
  { id: "gold", instrumentType: "commodity", label: "금 선물", market: "GLOBAL", note: "COMEX 금 · 거의 24시간 거래", symbol: "GC=F" },
  { id: "wti", instrumentType: "commodity", label: "WTI 선물", market: "GLOBAL", note: "NYMEX WTI 원유 · 거의 24시간 거래", symbol: "CL=F" }
];

function toneFromChange(change) {
  if (!change) return "flat";

  return change > 0 ? "up" : "down";
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

async function loadYahooQuote(quoteConfig) {
  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(quoteConfig.symbol)}`);

  url.searchParams.set("range", "2d");
  url.searchParams.set("interval", "5m");

  if (quoteConfig.prePost) url.searchParams.set("includePrePost", "true");

  const data = await fetchJson(url.toString(), {
    timeoutMs: 4000,
    headers: { "User-Agent": browserUserAgent }
  });
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const stamps = result?.timestamp ?? [];
  let last = -1;

  for (let index = closes.length - 1; index >= 0; index -= 1) {
    if (typeof closes[index] === "number") {
      last = index;
      break;
    }
  }

  // meta.regularMarketPrice is the last *regular session* trade, which outside
  // the bell is yesterday's — the same trap the pre-market sampler hit. The last
  // printed bar is the price that exists now.
  const price = last >= 0 ? closes[last] : result?.meta?.regularMarketPrice;
  const previousClose = result?.meta?.chartPreviousClose ?? result?.meta?.previousClose;

  if (!price) return null;

  const changeRate = previousClose ? ((price / previousClose) - 1) * 100 : undefined;

  return {
    change: previousClose ? formatValue(price - previousClose) : undefined,
    changeRate: formatChangeRate(changeRate),
    id: quoteConfig.id,
    instrumentType: quoteConfig.instrumentType,
    label: quoteConfig.label,
    market: quoteConfig.market,
    note: quoteConfig.note,
    source: "market",
    symbol: quoteConfig.symbol,
    timestamp: last >= 0 && stamps[last] ? new Date(stamps[last] * 1000).toISOString() : new Date().toISOString(),
    tone: toneFromChange(changeRate),
    value: formatValue(price)
  };
}

async function loadBitcoin() {
  const data = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
    { timeoutMs: 2500 }
  );
  const price = data?.bitcoin?.usd;

  if (!price) return null;

  const changeRate = data.bitcoin?.usd_24h_change;

  return {
    id: "btc",
    label: "BTC",
    market: "CRYPTO",
    instrumentType: "crypto",
    symbol: "BTC/USD",
    value: formatValue(price, 0),
    changeRate: formatChangeRate(changeRate),
    tone: toneFromChange(changeRate),
    note: "CoinGecko BTC/USD 24시간 변화",
    timestamp: new Date().toISOString(),
    source: "market"
  };
}

function usdKrwSnapshot({ changeRate, note, rate, timestamp }) {
  return {
    changeRate: formatChangeRate(changeRate),
    id: "usd-krw",
    instrumentType: "fx",
    label: "원/달러 환율",
    market: "KR",
    note,
    source: "market",
    symbol: "USD/KRW",
    timestamp,
    tone: toneFromChange(changeRate),
    value: formatValue(rate)
  };
}

/**
 * The rate now, not the rate the ECB published yesterday.
 *
 * Frankfurter serves the ECB reference rate, which is fixed once per business
 * day at 14:15 CET and carries no intraday move. Read from Seoul that is always
 * at least a day behind: on 2026-08-19 at 18:00 KST the board showed 1,410.07
 * dated 08-18 while the market was at 1,395.03 - fifteen won, on the number the
 * whole macro row is read against.
 *
 * Yahoo quotes KRW=X continuously and is already the source for every other
 * quote on this board. Frankfurter stays as the fallback, still labelled as the
 * daily reference it is.
 */
async function loadUsdKrw() {
  try {
    const data = await fetchJson("https://query2.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d", {
      timeoutMs: 3000,
      headers: { "User-Agent": browserUserAgent }
    });
    const meta = data?.chart?.result?.[0]?.meta;
    const rate = meta?.regularMarketPrice;
    const previousClose = meta?.chartPreviousClose ?? meta?.previousClose;

    if (rate) {
      return usdKrwSnapshot({
        changeRate: previousClose ? ((rate / previousClose) - 1) * 100 : undefined,
        note: "Yahoo USD/KRW 실시간",
        rate,
        timestamp: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString()
      });
    }
  } catch (error) {
    console.warn("usd/krw live lookup failed", error instanceof Error ? error.message : error);
  }

  const data = await fetchJson("https://api.frankfurter.app/latest?from=USD&to=KRW", { timeoutMs: 2500 });
  const rate = data?.rates?.KRW;

  if (!rate) return null;

  return usdKrwSnapshot({
    note: `Frankfurter ${data.date ?? "latest"} 고시 · 일 1회`,
    rate,
    timestamp: data.date ? `${data.date}T00:00:00+00:00` : new Date().toISOString()
  });
}

function treasuryField(entry, field) {
  return entry.match(new RegExp(`<d:${field}[^>]*>([^<]+)</d:${field}>`))?.[1];
}

/**
 * 10년물 금리 — 재무부 일별 파일이 아니라 ^TNX.
 *
 * 수익률 곡선 파일은 하루에 한 번 갱신됩니다. 2026-08-20 22:10에 재보니 971분 전
 * 값이었고, 미국장이 열려 금리가 움직이는 내내 화면은 어제를 보여줍니다. ^TNX는
 * 같은 시각 15분 전이었습니다. 파일은 폴백으로 남깁니다 — 그쪽이 공식 고시입니다.
 */
async function loadUs10y() {
  try {
    const quote = await loadYahooQuote({
      id: "us10y",
      instrumentType: "rate",
      label: "10Y 금리",
      market: "US",
      note: "미 10년물 국채 금리 · 미국장 시간 실시간",
      symbol: "^TNX"
    });

    if (quote) return { ...quote, symbol: "US10Y", value: `${quote.value}%` };
  } catch (error) {
    console.warn("us 10y live lookup failed", error instanceof Error ? error.message : error);
  }

  return loadUs10yFromTreasury();
}

async function loadUs10yFromTreasury() {
  const year = new Date().getUTCFullYear();
  const xml = await fetchText(
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,
    { timeoutMs: 4000 }
  );
  const parsed = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)]
    .map((match) => {
      const date = treasuryField(match[0], "NEW_DATE");
      const value = Number(treasuryField(match[0], "BC_10YEAR"));

      return date && Number.isFinite(value) ? { date, value } : null;
    })
    .filter(Boolean);
  const latest = parsed.at(-1);
  const previous = parsed.at(-2);

  if (!latest) return null;

  const change = previous ? latest.value - previous.value : undefined;

  return {
    id: "us10y",
    label: "10Y 금리",
    market: "US",
    instrumentType: "rate",
    symbol: "US10Y",
    value: `${latest.value.toFixed(2)}%`,
    change: typeof change === "number" ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%p` : undefined,
    tone: toneFromChange(change),
    note: "U.S. Treasury Daily Yield Curve · 일 1회 고시",
    timestamp: latest.date.replace("T00:00:00", "T21:00:00+00:00"),
    source: "market"
  };
}

function rawValue(field) {
  const value = field?.raw ?? field;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function loadScreener(scrIds, count) {
  const url = new URL(screenerUrl);

  url.searchParams.set("scrIds", scrIds);
  url.searchParams.set("count", String(count));

  const data = await fetchJson(url.toString(), {
    timeoutMs: 5000,
    headers: { "User-Agent": browserUserAgent, Accept: "application/json" }
  });

  return data?.finance?.result?.[0]?.quotes ?? [];
}

/**
 * Scores the day's US leaders on the same basis as the domestic board: turnover
 * is the floor, then a rising price, volume above the stock's own three-month
 * norm, and proximity to its 52-week high add to it. Turnover alone would just
 * list the largest caps every session.
 */
function usLeadershipScore(quote) {
  const price = rawValue(quote.regularMarketPrice);
  const volume = rawValue(quote.regularMarketVolume);
  const changeRate = rawValue(quote.regularMarketChangePercent);
  const averageVolume = rawValue(quote.averageDailyVolume3Month);
  const fiftyTwoWeekHigh = rawValue(quote.fiftyTwoWeekHigh);
  const turnover = price * volume;
  const volumeRatio = averageVolume > 0 ? volume / averageVolume : 1;
  const nearHigh = fiftyTwoWeekHigh > 0 ? price / fiftyTwoWeekHigh : 0;

  return Math.log10(Math.max(turnover, 1)) * 10
    + Math.max(changeRate, 0) * 1.2
    + Math.min(volumeRatio, 10) * 2
    + (nearHigh >= 0.95 ? 6 : 0);
}

function toUsLeader(quote, index) {
  const symbol = quote.symbol?.trim();
  const name = quote.shortName?.trim() || quote.longName?.trim() || symbol;

  if (!symbol || !name) return null;

  const price = rawValue(quote.regularMarketPrice);
  const volume = rawValue(quote.regularMarketVolume);
  const changeRate = rawValue(quote.regularMarketChangePercent);
  const averageVolume = rawValue(quote.averageDailyVolume3Month);
  const fiftyTwoWeekHigh = rawValue(quote.fiftyTwoWeekHigh);
  const turnoverValue = price * volume;

  if (turnoverValue <= 0) return null;

  const theme = classifyTheme(symbol, name);
  const volumeRatio = averageVolume > 0 ? volume / averageVolume : 0;
  const nearHigh = fiftyTwoWeekHigh > 0 && price / fiftyTwoWeekHigh >= 0.95;

  return {
    id: `us-leader-${symbol}`,
    symbol,
    name,
    market: "US",
    rank: index + 1,
    marketLabel: "미국 거래 집중",
    theme,
    turnoverValue,
    changeRateValue: changeRate,
    volumeValue: volume,
    volumeRatioValue: volumeRatio > 0 ? volumeRatio : undefined,
    burst: `${formatShareVolume(volume)}${volumeRatio > 0 ? ` · 평균 대비 ${volumeRatio.toFixed(1)}배` : ""}`,
    turnover: formatTradingAmount(turnoverValue, "USD"),
    intraday: `현재가 $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} · ${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
    reason: `${theme} · 당일 거래대금 ${formatTradingAmount(turnoverValue, "USD")}${volumeRatio >= 1.5 ? ` · 거래량 급증 ${volumeRatio.toFixed(1)}배` : ""}${nearHigh ? " · 52주 신고가 근접" : ""}`,
    caution: "미국장 시간대와 시간외 반응을 함께 확인",
    timestamp: new Date().toISOString(),
    source: "market"
  };
}

async function loadUsLeaders() {
  return readThroughCache("market:us-leaders", leadersCacheTtlMs, async () => {
    const [actives, gainers] = await Promise.all([
      loadScreener("most_actives", 40),
      loadScreener("day_gainers", 25).catch(() => [])
    ]);
    const bySymbol = new Map();

    // Equities only: the actives list is thick with ETFs, which are not leaders.
    // They are kept aside rather than dropped — the board carries an ETF tab,
    // and this list is where the domestic one's counterpart comes from.
    const funds = new Map();

    [...actives, ...gainers]
      .filter((quote) => quote?.symbol)
      .forEach((quote) => (quote.quoteType === "EQUITY" ? bySymbol : funds).set(quote.symbol, quote));

    const rank = (quotes, limit) => [...quotes.values()]
      .sort((left, right) => usLeadershipScore(right) - usLeadershipScore(left))
      .map(toUsLeader)
      .filter(Boolean)
      .slice(0, limit);

    // Deep enough that a theme holds several names, as on the domestic board.
    return { usEtfLeaders: rank(funds, 30), usLeadingStocks: rank(bySymbol, 30) };
  });
}

function snapshotById(items, id) {
  return items.find((item) => item.id === id);
}

function buildMarketBriefs(macroSnapshot) {
  const qqq = snapshotById(macroSnapshot, "nasdaq-future");
  const spy = snapshotById(macroSnapshot, "sp500-future");
  const soxx = snapshotById(macroSnapshot, "phlx-sox");
  const us10y = snapshotById(macroSnapshot, "us10y");
  const usdKrw = snapshotById(macroSnapshot, "usd-krw");
  const btc = snapshotById(macroSnapshot, "btc");
  const timestamp = new Date().toISOString();
  const briefs = [];

  if (qqq || spy || soxx || us10y) {
    briefs.push({
      id: "us-macro",
      region: "미국 시황",
      title: `${qqq?.label ?? "NASDAQ"} ${qqq?.changeRate ?? "확인 중"}, ${spy?.label ?? "S&P"} ${spy?.changeRate ?? "확인 중"} 흐름입니다.`,
      points: [
        soxx ? `반도체 기준 ${soxx.symbol} ${soxx.changeRate ?? soxx.value}` : "반도체 ETF 확인 대기",
        us10y ? `10년물 ${us10y.value}${us10y.change ? ` · ${us10y.change}` : ""}` : "10년물 금리 확인 대기",
        "선물 원본이 아닌 ETF/공식 금리 기준으로 참고합니다."
      ],
      source: "market",
      timestamp
    });
  }

  if (usdKrw || btc) {
    briefs.push({
      id: "fx-risk",
      region: "환율 시황",
      title: `${usdKrw ? `원/달러 ${usdKrw.value}` : "원/달러 확인 중"}, ${btc ? `BTC ${btc.changeRate ?? btc.value}` : "BTC 확인 중"} 기준입니다.`,
      points: [
        usdKrw ? usdKrw.note : "환율 데이터 확인 대기",
        btc ? btc.note : "BTC 데이터 확인 대기",
        "국내 개장 전 수출주와 위험선호 참고값으로만 봅니다."
      ],
      source: "market",
      timestamp
    });
  }

  return briefs;
}

async function loadMacroSnapshot(config) {
  return readThroughCache("market:macro", cacheTtlMs, async () => {
    // No key needed any more: the futures come from the same host as every
    // other quote here, and Finnhub's free tier only ever returned the last
    // regular-session close anyway.
    const loaders = [loadBitcoin(), loadUsdKrw(), loadUs10y(), ...yahooQuotes.map(loadYahooQuote)];

    const results = await Promise.allSettled(loaders);

    return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  });
}

export async function loadMarketData(config) {
  const [macroSnapshot, leaders] = await Promise.all([
    loadMacroSnapshot(config),
    loadUsLeaders().catch((error) => {
      console.warn("us leaders lookup failed", error instanceof Error ? error.message : error);

      return { usEtfLeaders: [], usLeadingStocks: [] };
    })
  ]);
  // Yahoo has no ETF ranking to ask for, so this is our own list rather than a
  // filter over the screener's equities.
  const usEtfLeaders = await loadUsEtfLeaders().catch((error) => {
    console.warn("us etf lookup failed", error instanceof Error ? error.message : error);

    return [];
  });

  return {
    ...(macroSnapshot.length > 0 ? { macroSnapshot, marketBrief: buildMarketBriefs(macroSnapshot) } : {}),
    ...(usEtfLeaders.length > 0 ? { usEtfLeaders } : {}),
    ...(leaders.usLeadingStocks.length > 0 ? { usLeadingStocks: leaders.usLeadingStocks } : {})
  };
}
