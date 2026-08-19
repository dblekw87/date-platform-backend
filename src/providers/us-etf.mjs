import { fetchJson } from "../http.mjs";
import { formatShareVolume, formatTradingAmount } from "./format.mjs";
import { readThroughCache } from "../cache.mjs";

/**
 * The US ETF board, which has to be a list we choose.
 *
 * The domestic ETF tab fills itself: KIS ranks the whole market and the ETFs
 * arrive inside the ranking. Yahoo's predefined screeners do not work that way -
 * most_actives returned forty rows on 2026-08-19 and all forty were EQUITY - so
 * there is nothing to filter out and no ETF ranking to ask for.
 *
 * So the universe is named here. It is not "every US ETF", it is the ones a
 * trader watching this board would look at: the index proxies the macro row
 * already uses, the leveraged pairs that move on the same news, the sectors that
 * carry Korean names with them, and the few country and commodity funds.
 *
 * Priced through the chart endpoint rather than v7/quote, which answers 401
 * without a crumb. Pre and post prints are included, and the change is measured
 * against the chart's own previous close - during the premarket
 * meta.regularMarketPrice is still yesterday's last trade and would report
 * every fund as flat, which is the same trap the watchlist sampler hit.
 */

const cacheTtlMs = 60_000;
const batchSize = 6;
const batchSpacingMs = 120;

const universe = [
  { label: "S&P 500", symbol: "SPY" },
  { label: "NASDAQ 100", symbol: "QQQ" },
  { label: "러셀 2000", symbol: "IWM" },
  { label: "다우", symbol: "DIA" },
  { label: "S&P 500 3X", symbol: "UPRO" },
  { label: "S&P 500 인버스 3X", symbol: "SPXS" },
  { label: "NASDAQ 3X", symbol: "TQQQ" },
  { label: "NASDAQ 인버스 3X", symbol: "SQQQ" },
  { label: "반도체", symbol: "SOXX" },
  { label: "반도체", symbol: "SMH" },
  { label: "반도체 3X", symbol: "SOXL" },
  { label: "반도체 인버스 3X", symbol: "SOXS" },
  { label: "러셀 2000 3X", symbol: "TNA" },
  { label: "한국 3X", symbol: "KORU" },
  { label: "한국", symbol: "EWY" },
  { label: "중국 인터넷", symbol: "KWEB" },
  { label: "기술주", symbol: "XLK" },
  { label: "에너지", symbol: "XLE" },
  { label: "금융", symbol: "XLF" },
  { label: "헬스케어", symbol: "XLV" },
  { label: "산업재", symbol: "XLI" },
  { label: "유틸리티", symbol: "XLU" },
  { label: "바이오텍", symbol: "XBI" },
  { label: "혁신성장", symbol: "ARKK" },
  { label: "로봇·AI", symbol: "BOTZ" },
  { label: "우라늄", symbol: "URA" },
  { label: "리튬·배터리", symbol: "LIT" },
  { label: "청정에너지", symbol: "ICLN" },
  { label: "금", symbol: "GLD" },
  { label: "은", symbol: "SLV" },
  { label: "원유", symbol: "USO" },
  { label: "장기국채", symbol: "TLT" },
  { label: "달러", symbol: "UUP" },
  { label: "변동성", symbol: "UVXY" }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadEtfQuote({ label, symbol }) {
  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`);

  url.searchParams.set("range", "1d");
  url.searchParams.set("interval", "5m");
  url.searchParams.set("includePrePost", "true");

  const data = await fetchJson(url.toString(), {
    timeoutMs: 4000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" }
  });
  const result = data?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((value) => typeof value === "number");
  const volumes = (result?.indicators?.quote?.[0]?.volume ?? []).filter((value) => typeof value === "number");
  const previousClose = result?.meta?.chartPreviousClose ?? result?.meta?.previousClose;
  const price = closes.at(-1) ?? result?.meta?.regularMarketPrice;

  if (!price || !previousClose) return null;

  const changeRate = ((price / previousClose) - 1) * 100;
  // Yahoo returns zero volume on pre and post bars - sixteen bars for SPY on
  // 2026-08-19, every one of them 0 - so outside the regular session there is no
  // turnover to report. meta.regularMarketVolume would fill the column with
  // yesterday's number, which is worse than an empty one.
  const volume = volumes.reduce((total, value) => total + value, 0);
  const turnoverValue = price * volume;

  return {
    burst: formatShareVolume(volume),
    caution: "지수·레버리지 상품이라 개별 종목의 이유와 다르게 움직입니다",
    changeRateValue: changeRate,
    id: `us-etf-${symbol}`,
    intraday: `현재가 $${price.toFixed(2)} · ${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
    market: "US",
    marketLabel: "미국 ETF",
    name: `${symbol} · ${label}`,
    reason: `${label} · ETF`,
    source: "market",
    symbol,
    theme: "ETF",
    timestamp: new Date().toISOString(),
    turnover: formatTradingAmount(turnoverValue, "USD"),
    turnoverValue,
    volumeValue: volume
  };
}

export async function loadUsEtfLeaders() {
  return readThroughCache("market:us-etf", cacheTtlMs, async () => {
    const rows = [];

    for (let index = 0; index < universe.length; index += batchSize) {
      const batch = universe.slice(index, index + batchSize);
      const settled = await Promise.allSettled(batch.map(loadEtfQuote));

      rows.push(...settled.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []));

      if (index + batchSize < universe.length) await sleep(batchSpacingMs);
    }

    return rows
      .sort((left, right) => right.changeRateValue - left.changeRateValue)
      .map((row, position) => ({ ...row, rank: position + 1 }));
  });
}
