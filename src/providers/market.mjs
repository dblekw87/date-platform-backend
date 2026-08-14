import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { formatShareVolume, formatTradingAmount } from "./format.mjs";
import { classifyTheme } from "./themes.mjs";

/**
 * Public market data: US index/commodity ETFs via Finnhub, plus BTC, USD/KRW,
 * the US 10-year yield, and the US leaders board. Every source is optional — a
 * failure drops that one row rather than the whole snapshot.
 */

const cacheTtlMs = 15_000;
const leadersCacheTtlMs = 60_000;
const screenerUrl = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved";
// The screener rejects a default client identifier.
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const finnhubQuotes = [
  { id: "sp500-future", label: "S&P 500 ETF", market: "US", instrumentType: "index", symbol: "SPY", note: "S&P 500 선물 대체 확인용 ETF" },
  { id: "nasdaq-future", label: "NASDAQ 100 ETF", market: "US", instrumentType: "index", symbol: "QQQ", note: "NASDAQ 선물 대체 확인용 ETF" },
  { id: "phlx-sox", label: "반도체 ETF", market: "US", instrumentType: "index", symbol: "SOXX", note: "SOX 원지수 대체 확인용 반도체 ETF" },
  { id: "gold", label: "금 ETF", market: "GLOBAL", instrumentType: "commodity", symbol: "GLD", note: "금선물 대체 확인용 ETF" },
  { id: "wti", label: "WTI ETF", market: "GLOBAL", instrumentType: "commodity", symbol: "USO", note: "WTI 선물 대체 확인용 ETF" }
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

async function loadFinnhubQuote(quoteConfig, apiKey) {
  const url = new URL("https://finnhub.io/api/v1/quote");

  url.searchParams.set("symbol", quoteConfig.symbol);
  url.searchParams.set("token", apiKey);

  const quote = await fetchJson(url.toString(), { timeoutMs: 2500 });

  if (!quote?.c) return null;

  return {
    id: quoteConfig.id,
    label: quoteConfig.label,
    market: quoteConfig.market,
    instrumentType: quoteConfig.instrumentType,
    symbol: quoteConfig.symbol,
    value: formatValue(quote.c),
    change: typeof quote.d === "number" ? formatValue(quote.d) : undefined,
    changeRate: formatChangeRate(quote.dp),
    tone: toneFromChange(quote.dp),
    note: quoteConfig.note,
    timestamp: quote.t ? new Date(quote.t * 1000).toISOString() : new Date().toISOString(),
    source: "market"
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

async function loadUsdKrw() {
  const data = await fetchJson("https://api.frankfurter.app/latest?from=USD&to=KRW", { timeoutMs: 2500 });
  const rate = data?.rates?.KRW;

  if (!rate) return null;

  return {
    id: "usd-krw",
    label: "원/달러 환율",
    market: "KR",
    instrumentType: "fx",
    symbol: "USD/KRW",
    value: formatValue(rate),
    tone: "flat",
    note: `Frankfurter ${data.date ?? "latest"} 기준`,
    timestamp: data.date ? `${data.date}T00:00:00+00:00` : new Date().toISOString(),
    source: "market"
  };
}

function treasuryField(entry, field) {
  return entry.match(new RegExp(`<d:${field}[^>]*>([^<]+)</d:${field}>`))?.[1];
}

async function loadUs10y() {
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
    note: "U.S. Treasury Daily Yield Curve",
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
    [...actives, ...gainers]
      .filter((quote) => quote?.quoteType === "EQUITY" && quote.symbol)
      .forEach((quote) => bySymbol.set(quote.symbol, quote));

    return [...bySymbol.values()]
      .sort((left, right) => usLeadershipScore(right) - usLeadershipScore(left))
      .map(toUsLeader)
      .filter(Boolean)
      .slice(0, 10);
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
    const apiKey = config.market.finnhubApiKey;
    const loaders = [loadBitcoin(), loadUsdKrw(), loadUs10y()];

    if (apiKey) {
      loaders.push(...finnhubQuotes.map((quote) => loadFinnhubQuote(quote, apiKey)));
    }

    const results = await Promise.allSettled(loaders);

    return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  });
}

export async function loadMarketData(config) {
  const [macroSnapshot, usLeadingStocks] = await Promise.all([
    loadMacroSnapshot(config),
    loadUsLeaders().catch((error) => {
      console.warn("us leaders lookup failed", error instanceof Error ? error.message : error);

      return [];
    })
  ]);

  return {
    ...(macroSnapshot.length > 0 ? { macroSnapshot, marketBrief: buildMarketBriefs(macroSnapshot) } : {}),
    ...(usLeadingStocks.length > 0 ? { usLeadingStocks } : {})
  };
}
