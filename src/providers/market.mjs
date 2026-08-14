import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";

/**
 * Public market data: US index/commodity ETFs via Finnhub, plus BTC, USD/KRW,
 * and the US 10-year yield from public sources. Every source is optional — a
 * failure drops that one row rather than the whole snapshot.
 */

const cacheTtlMs = 15_000;

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

export async function loadMarketData(config) {
  return readThroughCache("market:macro", cacheTtlMs, async () => {
    const apiKey = config.market.finnhubApiKey;
    const loaders = [loadBitcoin(), loadUsdKrw(), loadUs10y()];

    if (apiKey) {
      loaders.push(...finnhubQuotes.map((quote) => loadFinnhubQuote(quote, apiKey)));
    }

    const results = await Promise.allSettled(loaders);
    const macroSnapshot = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);

    if (macroSnapshot.length === 0) return {};

    return {
      macroSnapshot,
      marketBrief: buildMarketBriefs(macroSnapshot)
    };
  });
}
