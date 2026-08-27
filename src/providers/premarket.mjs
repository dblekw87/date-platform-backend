import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";
import { loadMarketData } from "./market.mjs";
import { loadUsSurgeCandidates } from "./surge-candidates.mjs";
import { query } from "../db/client.mjs";

/**
 * What the watchlist is doing outside the bell.
 *
 * The candidate list is built from a closing price, and by the time anyone in
 * Seoul reads it the move has usually already started: measured over 778 surge
 * days, 72% were already up more than 50% before the US open, at a median of
 * +164%, and a quarter of them made the whole day's high in the premarket. A
 * board that only knows yesterday's close is five hours behind the thing it is
 * describing.
 *
 * Massive is no help here — its snapshot endpoints are paid and its free
 * minute data only arrives after the session ends. Yahoo's chart endpoint
 * carries the extended session (04:00 to 20:00 Eastern) for free and without a
 * key, so that is what this reads. Its quote and quoteSummary endpoints now
 * answer 401 without a crumb, and spark ignores includePrePost and returns the
 * regular session only, so the per-symbol chart is the one that works.
 *
 * Coverage is the honest limit: this can only see stocks the candidate list
 * already named. Widening it is cheap — the sweep runs six requests at a time
 * and clears a hundred names in twelve seconds — and it buys most of what a
 * paid whole-market snapshot would, because surges are not spread evenly:
 * 1,278 symbols hold 89% of two years of them. What it still cannot see is a
 * name outside the ranked universe entirely.
 */

const chartUrl = "https://query1.finance.yahoo.com/v8/finance/chart";
// The screener rejects a default client identifier, and so does this.
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Premarket moves in minutes, not hours, but a board refresh should not fan out
// hundreds of requests every time somebody reloads.
// Wide enough to cover most of where surges happen, cached long enough that a
// page refresh never triggers a sweep. Six hundred names take about a minute.
const cacheTtlMs = 150_000;
const watchlistSize = 600;
const liquidCoreSize = 600;
const liquidCoreWindowDays = 30;
const requestBatch = 8;
const minimumMove = 0.15;

const easternTime = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "America/New_York",
  weekday: "short"
});

/**
 * Which session the US market is in right now, read from the exchange's own
 * clock so the twice-yearly offset change is not something to remember.
 */
export function usMarketPhase(now = new Date()) {
  const parts = easternTime.formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const minute = (Number(value("hour")) % 24) * 60 + Number(value("minute"));

  if (["Sat", "Sun"].includes(value("weekday"))) return "closed";
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return "pre";
  if (minute < 16 * 60) return "regular";
  if (minute < 20 * 60) return "post";

  return "closed";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One symbol's extended session, reduced to how far it has travelled from
 * yesterday's close.
 *
 * The last printed bar rather than the meta price: meta.regularMarketPrice
 * holds the last regular-session trade, which during the premarket is still
 * yesterday's close and would report every stock as flat.
 */
/**
 * The last regular close, which Yahoo's chart meta cannot be trusted for.
 *
 * Measured 2026-08-18 during the pre-market: WETO's chart covered 04:00 to
 * 06:44 ET that morning, and its meta reported previousClose 8.22 - the close
 * from four sessions earlier. The stock had closed at 24.59 the night before,
 * so the board read +332% where the move was +44%. meta.regularMarketPrice held
 * 24.59 correctly, and so did our own bars.
 *
 * Ours is preferred because it is the number the pipeline audits, and it is
 * what every other US figure on the board is measured against. Yahoo's regular
 * price is the fallback for a symbol we have no bar for, and its previousClose
 * is the last resort.
 */
async function loadPreviousCloses(config, symbols) {
  if (!config.databaseUrl || symbols.length === 0) return new Map();

  try {
    const result = await query(config, `
      SELECT DISTINCT ON (symbol) symbol, close
      FROM us_daily_bars
      WHERE symbol = ANY($1)
      ORDER BY symbol, session_date DESC
    `, [symbols]);

    return new Map(result.rows.map((row) => [row.symbol, Number(row.close)]));
  } catch (error) {
    console.warn("premarket: previous closes unavailable", error instanceof Error ? error.message : error);

    return new Map();
  }
}

/**
 * 어느 전일 종가를 믿을 것인가.
 *
 * 저장된 값을 먼저 씁니다 -- 우리 일봉은 확정값이고 Yahoo의 meta는 장중에 흔들립니다.
 * 다만 **액면병합이 있으면 저장값이 병합 전 가격에 멈춰 있습니다.** 2026-08-27
 * IMCC가 그랬습니다: 우리 08-26 종가는 $0.1114인데 Yahoo는 $3.342였고(1:30 병합),
 * 저장값으로 나누니 상승률이 +2916%로 나왔습니다. 실제로는 +0.5%입니다.
 *
 * us_splits로 거르려 했지만 IMCC는 거기 없었습니다 -- 분할 정보가 늦게 들어옵니다.
 * 그래서 표가 아니라 두 값의 어긋남 자체를 신호로 씁니다. 정상적인 하루 변동으로는
 * 두 배가 벌어지지 않으므로, 벌어졌으면 분할이고 그때는 Yahoo가 맞습니다.
 */
function pickPreviousClose(storedClose, result) {
  const yahoo = Number.isFinite(result?.meta?.chartPreviousClose) ? result.meta.chartPreviousClose
    : Number.isFinite(result?.meta?.previousClose) ? result.meta.previousClose : null;

  if (!storedClose) return yahoo ?? undefined;
  if (!yahoo) return storedClose;

  const ratio = storedClose / yahoo;

  return ratio > 2 || ratio < 0.5 ? yahoo : storedClose;
}

/**
 * 개장 첫 5분봉과, 그때까지 프리마켓에서 얼마나 올라 있었는지.
 *
 * 2024-08~2026-08 1,503건 실측에서 이 둘이 결과를 갈랐습니다. 진입은 정규장 첫 봉
 * 시가이고 값은 전부 중앙값입니다.
 *
 *   프리 50~100%  30분 종가 +21.2%   프리 150~300%  30분 종가 −3.1%
 *   프리 100~150% 30분 종가 +12.7%   프리 300%↑     30분 종가 −5.7%
 *
 * 많이 오를수록 나빠집니다. 프리마켓에서 이미 다 가버려 정규장에 남은 것이
 * 없기 때문입니다 -- 300% 넘게 오른 것들은 30분 고가가 +10.5%뿐입니다.
 *
 * 첫 5분봉의 방향이 그 다음을 가릅니다. 프리 150~300%에서 양봉이면 30분 종가
 * 중앙값 +3.7%에 승률 56%, 음봉이면 −9.8%에 33%입니다.
 *
 * 값이 아직 없을 때(개장 전)와 음봉일 때를 구분해서 냅니다. 둘을 같이 비워 두면
 * 화면이 "아직 모른다"와 "아니다"를 같게 보여주게 됩니다.
 */
function openBar(result, previousClose) {
  const regular = result?.meta?.currentTradingPeriod?.regular;
  const stamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};

  if (!regular || stamps.length === 0) return { openBarState: "unknown" };

  const first = stamps.findIndex((stamp) => stamp >= regular.start);

  if (first < 0) {
    // 아직 개장 전. 프리마켓 상승률만 확정할 수 있습니다.
    const before = stamps.filter((stamp) => stamp < regular.start).length;
    const preLast = before > 0 ? quote.close?.[before - 1] : null;

    return { openBarState: "before", preGain: Number.isFinite(preLast) ? preLast / previousClose - 1 : null };
  }

  const preLast = first > 0 ? quote.close?.[first - 1] : null;
  const open = quote.open?.[first];
  const close = quote.close?.[first];
  // 첫 봉이 아직 닫히지 않았으면 방향을 말하지 않습니다. 5분이 지나기 전의 종가는
  // 종가가 아닙니다.
  const settled = Date.now() / 1000 >= stamps[first] + 300;

  return {
    openBarState: !Number.isFinite(open) || !Number.isFinite(close) ? "unknown"
      : !settled ? "forming"
        : close > open ? "green" : "red",
    openPrice: Number.isFinite(open) ? open : null,
    preGain: Number.isFinite(preLast) ? preLast / previousClose - 1 : null
  };
}

async function readExtendedQuote(symbol, storedClose) {
  const data = await fetchJson(
    `${chartUrl}/${encodeURIComponent(symbol)}?includePrePost=true&interval=5m&range=1d`,
    { headers: { "User-Agent": browserUserAgent }, timeoutMs: 4000 }
  );
  const result = data?.chart?.result?.[0];
  const previousClose = pickPreviousClose(storedClose, result);
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((value) => Number.isFinite(value));
  const highs = (result?.indicators?.quote?.[0]?.high ?? []).filter((value) => Number.isFinite(value));
  const volumes = (result?.indicators?.quote?.[0]?.volume ?? []).filter((value) => Number.isFinite(value));

  if (!previousClose || closes.length === 0) return null;

  const last = closes.at(-1);
  const high = highs.length > 0 ? Math.max(...highs) : last;

  return {
    ...openBar(result, previousClose),
    changeRate: last / previousClose - 1,
    high,
    highRate: high / previousClose - 1,
    last,
    name: String(result?.meta?.shortName ?? "").trim() || symbol,
    previousClose,
    symbol,
    // Yahoo returns a full array of zeros for extended hours - 41 bars, no
    // nulls, nothing traded according to a feed that is also reporting a price
    // that doubled. Absent rather than zero, because zero would read as a
    // measurement.
    volume: volumes.reduce((sum, value) => sum + value, 0) || null
  };
}

async function readWatchlist(config, symbols) {
  const quotes = [];
  const storedCloses = await loadPreviousCloses(config, symbols);

  for (let index = 0; index < symbols.length; index += requestBatch) {
    const batch = symbols.slice(index, index + requestBatch);
    const settled = await Promise.all(
      batch.map((symbol) => readExtendedQuote(symbol, storedCloses.get(symbol)).catch(() => null))
    );

    quotes.push(...settled.filter(Boolean));

    // Yahoo publishes no rate limit and enforces one anyway. Six at a time with
    // a breath between is enough to finish a 120-name list in twenty seconds.
    if (index + requestBatch < symbols.length) await sleep(150);
  }

  return quotes;
}

/**
 * The most liquid names, whether or not they have done anything lately.
 *
 * The watchlist was built entirely from stocks that had already moved: surge
 * candidates, the screener's leaders, and whatever was sampled in the last
 * week. A large cap that trades quietly is in none of those, so on 2026-08-19
 * Moderna announced a Phase 3 melanoma readout, ran 60% in the premarket, and
 * was invisible here until the screener picked it up at +88% - after the move,
 * which is the one time it is no use.
 *
 * Ranked out of our own daily bars rather than a list typed in by hand, so it
 * follows the market instead of aging. Median dollar volume rather than mean:
 * one 26-million-share day would otherwise promote a shell for a month. MRNA
 * sits 498th at $288M a day, which is why the cut is here and not at 300.
 */
async function loadLiquidCore(config, { limit = liquidCoreSize } = {}) {
  if (!config.databaseUrl) return [];

  const result = await query(config, `
    WITH recent AS (
      SELECT symbol, close * volume AS dollar_volume
      FROM us_daily_bars
      WHERE session_date > (SELECT max(session_date) FROM us_daily_bars) - $2::int
        AND close IS NOT NULL AND volume IS NOT NULL
    )
    SELECT symbol
    FROM recent
    GROUP BY symbol
    ORDER BY percentile_cont(0.5) WITHIN GROUP (ORDER BY dollar_volume) DESC
    LIMIT $1
  `, [limit, liquidCoreWindowDays]);

  return result.rows.map((row) => row.symbol);
}

/**
 * Who to watch outside the bell.
 *
 * There is no free market-wide pre-market scanner - the snapshot endpoint that
 * would answer this returns 403 on our plan - so a list has to be chosen in
 * advance and anything off it is invisible. On 2026-08-18 the biggest US
 * pre-market move in the country was a stock we were not watching.
 *
 * Three sources, because each is blind where the others are not:
 *
 *   surge candidates   stocks our own history says surge, which is the only
 *                      source built from what actually happened here
 *   yesterday's leaders  the screener is frozen at the last close outside the
 *                      session, so its numbers are useless before 22:30 - but
 *                      the names are exactly right. A stock that led yesterday
 *                      is the likeliest one still moving this morning
 *   recently recorded  whatever the US session pass stored over the last week,
 *                      so the list grows into the market rather than staying
 *                      whatever the backfill decided months ago
 */
export async function loadUsWatchlist(config) {
  const symbols = new Set();

  try {
    const { candidates } = await loadUsSurgeCandidates(config, { limit: watchlistSize });

    for (const candidate of candidates) symbols.add(candidate.symbol);
  } catch (error) {
    console.warn("premarket: surge candidates unavailable", error instanceof Error ? error.message : error);
  }

  try {
    const payload = await loadMarketData(config);

    for (const stock of payload?.usLeadingStocks ?? []) symbols.add(stock.symbol);
  } catch (error) {
    console.warn("premarket: screener names unavailable", error instanceof Error ? error.message : error);
  }

  try {
    for (const symbol of await loadLiquidCore(config)) symbols.add(symbol);
  } catch (error) {
    console.warn("premarket: liquid core unavailable", error instanceof Error ? error.message : error);
  }

  if (config.databaseUrl) {
    try {
      const result = await query(config, `
        SELECT DISTINCT symbol
        FROM market_price_samples
        WHERE market = 'US' AND session_date >= (CURRENT_DATE - 7)
      `);

      for (const row of result.rows) symbols.add(row.symbol);
    } catch (error) {
      console.warn("premarket: recorded symbols unavailable", error instanceof Error ? error.message : error);
    }
  }

  return [...symbols];
}

/**
 * Extended-hours quotes shaped for the samples table.
 *
 * changeRate here is a ratio and change_rate in the table is a percentage. The
 * column already holds Korean rows written as percentages, so a fraction
 * arriving in the same column would not fail, it would quietly read as a
 * hundredth of the move.
 */
export async function loadUsExtendedSamples(config, { allowRegular = false } = {}) {
  const phase = usMarketPhase();

  if (phase === "closed") return { phase, stocks: [] };

  // The regular session is the screener's, and the screener answers with thirty
  // names. Everything outside those thirty is invisible for six and a half
  // hours - the same keyhole the domestic board had - so the watchlist is also
  // swept during the session when asked for.
  if (phase === "regular" && !allowRegular) return { phase, stocks: [] };

  const symbols = await loadUsWatchlist(config);
  const quotes = await readWatchlist(config, symbols);

  return {
    phase,
    stocks: quotes.map((quote) => ({
      changeRateValue: quote.changeRate * 100,
      market: "US",
      name: quote.name,
      symbol: quote.symbol,
      // The chart carries no turnover, only the shares that traded.
      turnoverValue: null,
      volumeValue: quote.volume
    }))
  };
}

export async function loadUsPremarketMovers(config, { limit = 10 } = {}) {
  const phase = usMarketPhase();

  if (phase === "closed") return { movers: [], phase };

  return readThroughCache(`us-premarket-${phase}`, cacheTtlMs, async () => {
    const { candidates } = await loadUsSurgeCandidates(config, { limit: watchlistSize });
    const quotes = await readWatchlist(config, candidates.map((candidate) => candidate.symbol));
    const bySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));

    const movers = quotes
      .filter((quote) => quote.highRate >= minimumMove)
      .sort((left, right) => right.highRate - left.highRate)
      .slice(0, limit)
      .map((quote) => {
        const candidate = bySymbol.get(quote.symbol);

        return {
          changeRate: quote.changeRate,
          high: quote.high,
          highRate: quote.highRate,
          id: `us-premarket-${quote.symbol}`,
          last: quote.last,
          name: candidate?.name ?? quote.symbol,
          phase,
          phaseLabel: { post: "애프터마켓", pre: "프리마켓", regular: "정규장" }[phase],
          previousClose: quote.previousClose,
          // 실측으로 결과가 갈린 두 값. 화면이 조건을 스스로 판단할 수 있게 그대로 냅니다.
          openBarState: quote.openBarState ?? "unknown",
          openPrice: quote.openPrice ?? null,
          preGain: quote.preGain ?? null,
          // What the list said about it before it moved, which is the only
          // reason it was being watched at all.
          probability: candidate?.probability ?? null,
          symbol: quote.symbol
        };
      });

    return { movers, phase, watched: quotes.length };
  });
}
