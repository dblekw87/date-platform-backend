import { saveMarketNewsItems, saveMarketPriceSamples } from "./db/repositories.mjs";
import { isKrMarketOpen, loadKisMarketBoard } from "./providers/kis.mjs";
import { rankDayLeaders } from "./providers/leadership.mjs";
import { loadPairQuotes } from "./providers/pairing.mjs";
import { sessionDate } from "./providers/market-session.mjs";
import { getMarketBoard } from "./routes/market-board.mjs";

/**
 * Records the market to disk while the session runs.
 *
 * Until now a sample existed only if somebody happened to load the board, so
 * the record of any given day was whatever the browser tabs of that day
 * produced. Nothing can be learned from a series with holes wherever nobody was
 * watching, and the holes fall exactly on the mornings when the screen is busy
 * being traded rather than read.
 *
 * Sampling reads KIS directly rather than the assembled board. The board merges
 * every provider and the last writer wins, so what it reports as domestic
 * leadership can change source between two ticks; a stored series has to come
 * from one ruler.
 */

// Collection opens with the NXT pre-market rather than the KRX bell, because
// the leadership that matters at 09:10 is often already forming at 08:30.
const openMinute = 8 * 60;
const closeMinute = 15 * 60 + 40;
const timeZone = "Asia/Seoul";

// News moves in hours, not minutes, and each board build fans out to a dozen
// feeds. Sampling it at the price cadence would spend the day re-reading the
// same headlines.
const newsIntervalMs = 10 * 60_000;
// Off hours the feeds still publish but nothing is trading on it yet, so half
// an hour keeps the record continuous without spending the night rebuilding a
// board nobody is reading.
const offHoursNewsIntervalMs = 30 * 60_000;
const idleIntervalMs = 60_000;

function seoulMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    minute: (Number(value("hour")) % 24) * 60 + Number(value("minute")),
    weekday: value("weekday")
  };
}

function isCollecting(now = new Date()) {
  const { minute, weekday } = seoulMinute(now);

  if (weekday === "Sat" || weekday === "Sun") return false;

  return minute >= openMinute && minute < closeMinute;
}

/**
 * How often to sample, by where the session is.
 *
 * The first half hour after the bell is sampled every minute because that is
 * the window the whole exercise is for: telling which stock is leading while
 * there is still time to trade the one behind it. A five minute tick would put
 * three readings across the entire decision.
 */
function intervalMsFor(minute) {
  if (minute < 9 * 60) return 5 * 60_000;
  if (minute < 9 * 60 + 30) return 60_000;
  if (minute < 10 * 60) return 2 * 60_000;

  return 5 * 60_000;
}

/**
 * The leaders, and then the stocks that could follow them.
 *
 * Recording only the leaders would have reproduced one layer down the exact
 * flaw the 짝꿍 work had to fix in peerCounts: a leader list can only show
 * lead-lag between leaders, and the stock that follows one is smaller by
 * definition and never in it. 삼화콘덴서 has to be in the record before anything
 * can be learned about it following 삼성전기.
 *
 * The follower pass costs the same KIS calls a board build was paying at
 * request time, moved onto this tick — so it is also what warms the per-symbol
 * quote cache the board reads. The cold build was thirteen seconds of calls for
 * exactly these names.
 */
async function samplePrices(config) {
  const payload = await loadKisMarketBoard(config);
  const stocks = payload?.krLeadingStocks ?? [];

  if (stocks.length === 0) return 0;

  // Pre-market rows come from NXT and the rest from KRX. Recorded rather than
  // merged: the two books have separate turnover, and a series that silently
  // switched venue at 09:00 would show a break that was never a trade.
  const venue = stocks[0]?.venue === "NXT" ? "kis:nxt" : "kis:krx";
  const observedAt = new Date().toISOString();
  const day = sessionDate("KR");
  let saved = await saveMarketPriceSamples(config, {
    market: "KR",
    observedAt,
    sessionDate: day,
    source: venue,
    stocks
  });

  try {
    const followers = await loadPairQuotes(config, rankDayLeaders(stocks, "KRW"), stocks);

    if (followers.length > 0) {
      // A separate source, because the two populations answer different
      // questions and must not be read as one ranking: these carry no
      // leader_rank worth reading, they are simply the names in the same theme.
      saved += await saveMarketPriceSamples(config, {
        market: "KR",
        observedAt,
        ranked: false,
        sessionDate: day,
        source: `${venue}:pair`,
        stocks: followers
      });
    }
  } catch (error) {
    // The leaders are already written. A follower pass that fails costs the
    // followers for one tick, not the tick.
    console.warn("collector: follower sample failed", error instanceof Error ? error.message : error);
  }

  return saved;
}

async function sampleNews(config) {
  const board = await getMarketBoard(config);

  return saveMarketNewsItems(config, board.headlineFlow ?? []);
}

export function startMarketCollector(config) {
  if (!config.databaseUrl) {
    console.warn("market collector disabled: DATABASE_URL is not set, so samples would have nowhere to go");

    return () => {};
  }

  let stopped = false;
  let timeoutId;
  let lastNewsAt = 0;

  async function tick() {
    if (stopped) return;

    const now = new Date();
    let delay = idleIntervalMs;
    let sessionOpen = false;

    // The weekday window is checked first because it is free; the holiday
    // lookup only runs on days that got past it.
    if (isCollecting(now) && await isKrMarketOpen(config, now)) {
      const { minute } = seoulMinute(now);

      delay = intervalMsFor(minute);
      sessionOpen = true;

      try {
        const saved = await samplePrices(config);

        if (saved > 0) console.log(`collector: ${saved} price samples`);
      } catch (error) {
        // A failed tick is a gap in one series, not a reason to stop recording
        // for the day — the next tick is a minute away.
        console.warn("collector: price sample failed", error instanceof Error ? error.message : error);
      }
    }

    // News is not a market-hours thing, and sampling it inside the block above
    // meant everything published overnight, over a weekend or through a holiday
    // rolled off the 300-item runtime buffer and was gone. That buffer is the
    // only place a headline lives until it lands here, and naming why a stock
    // rose has to be learned from months of them, so the corpus cannot lose
    // every evening. Slower off hours because each sample costs a board build.
    if (Date.now() - lastNewsAt >= (sessionOpen ? newsIntervalMs : offHoursNewsIntervalMs)) {
      lastNewsAt = Date.now();

      try {
        const saved = await sampleNews(config);

        if (saved > 0) console.log(`collector: ${saved} news items`);
      } catch (error) {
        console.warn("collector: news sample failed", error instanceof Error ? error.message : error);
      }
    }

    if (!stopped) timeoutId = setTimeout(tick, delay);
  }

  console.log(`market collector on · 시세 평일 08:00–15:40 KST · 뉴스 상시`);
  void tick();

  return () => {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
