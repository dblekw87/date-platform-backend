import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";
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

async function readExtendedQuote(symbol, storedClose) {
  const data = await fetchJson(
    `${chartUrl}/${encodeURIComponent(symbol)}?includePrePost=true&interval=5m&range=1d`,
    { headers: { "User-Agent": browserUserAgent }, timeoutMs: 4000 }
  );
  const result = data?.chart?.result?.[0];
  const previousClose = storedClose
    ?? (Number.isFinite(result?.meta?.regularMarketPrice) ? result.meta.regularMarketPrice : undefined)
    ?? result?.meta?.previousClose;
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((value) => Number.isFinite(value));
  const highs = (result?.indicators?.quote?.[0]?.high ?? []).filter((value) => Number.isFinite(value));

  if (!previousClose || closes.length === 0) return null;

  const last = closes.at(-1);
  const high = highs.length > 0 ? Math.max(...highs) : last;

  return {
    changeRate: last / previousClose - 1,
    high,
    highRate: high / previousClose - 1,
    last,
    previousClose,
    symbol
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
          // What the list said about it before it moved, which is the only
          // reason it was being watched at all.
          probability: candidate?.probability ?? null,
          symbol: quote.symbol
        };
      });

    return { movers, phase, watched: quotes.length };
  });
}
