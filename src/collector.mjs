import { mkdir, writeFile } from "node:fs/promises";
import { buildThemeCandidates, formatThemeCandidates } from "./providers/theme-candidates.mjs";
import { collectProgramTrade, saveProgramTrade } from "./providers/program-trade.mjs";
import { loadRecordedNames, loadSessionSymbols, saveMarketNewsItems, saveMarketPriceSamples, saveSymbolFlags } from "./db/repositories.mjs";
import { isKrMarketOpen, loadKisMarketBoard, loadKrQuotes } from "./providers/kis.mjs";
import { classifyTheme } from "./providers/themes.mjs";
import { loadCorpIndex } from "./providers/industry.mjs";
import { publishBoardSnapshot } from "./snapshot.mjs";
import { rankDayLeaders } from "./providers/leadership.mjs";
import { loadPairQuotes } from "./providers/pairing.mjs";
import { isRegularSession, krAfterHoursCloseMinute, krAfterHoursOpenMinute, krPreMarketCloseMinute, krTradingVenue, sessionDate } from "./providers/market-session.mjs";
import { loadMarketData } from "./providers/market.mjs";
import { loadUsExtendedSamples, usMarketPhase } from "./providers/premarket.mjs";
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
const openBellMinute = 9 * 60;
const timeZone = "Asia/Seoul";

// News moves in hours, not minutes, and each board build fans out to a dozen
// feeds. Sampling it at the price cadence would spend the day re-reading the
// same headlines.
const newsIntervalMs = 10 * 60_000;
// Off hours the feeds still publish but nothing is trading on it yet, so the
// gap can be wide without losing a story: the same headline is still in the
// feed three quarters of an hour later.
//
// Forty-five rather than thirty is a quota decision. Each sample costs one
// NewsAPI call against a free tier of a hundred a day, and the machine is now
// meant to stay on around the clock so the overnight US feed lands — which at
// half-hour spacing spends seventy-nine of them. This gives eleven back. The
// larger share is the in-session cadence, and that one is not spare.
const offHoursNewsIntervalMs = 45 * 60_000;
const idleIntervalMs = 60_000;

function seoulMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    minute: (Number(value("hour")) % 24) * 60 + Number(value("minute")),
    second: Number(value("second")),
    weekday: value("weekday")
  };
}

function isCollecting(now = new Date()) {
  const { minute, weekday } = seoulMinute(now);

  if (weekday === "Sat" || weekday === "Sun") return false;
  // Nothing trades between the NXT pre-market and the KRX bell. Measured
  // 2026-08-18: the 08:54 and 08:59 samples carried identical turnover across
  // all 39 names, to the won - a book with no trades in it, recorded twice as
  // though it were moving.
  if (minute >= krPreMarketCloseMinute && minute < openBellMinute) return false;

  return minute >= openMinute && minute < krAfterHoursCloseMinute;
}

/**
 * 15:40 to 20:00, when NXT is the only book trading.
 *
 * A leader that ran at 15:00 has followers that often do not move until the
 * next morning, and the tape between those two points was blank: the collector
 * stopped at 15:40 and did not start again until 08:00. Measured on 2026-08-18,
 * KRX repeats its close all evening while NXT traded 109 billion won in twenty
 * minutes, so the evening is real and it is only visible on one venue.
 */
function isAfterHours(minute) {
  return minute >= krAfterHoursOpenMinute && minute < krAfterHoursCloseMinute;
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

// 15:40 is both the end of the KRX pass and the start of the NXT one, so it is
// a single boundary. The others are cadence changes inside the morning.
const cadenceBoundaries = [krPreMarketCloseMinute, openBellMinute, 9 * 60 + 30, 10 * 60, krAfterHoursOpenMinute];

/**
 * Never sleep across a change of cadence.
 *
 * The interval is chosen from the minute the tick runs in, but it decides when
 * the next one happens, so a tick at 08:59 books itself five minutes out and
 * wakes at 09:04 — inside the window that is supposed to be sampled every
 * minute, having skipped its first five. Measured on the first collection day:
 * 08:59:42, then nothing until 09:04:49.
 *
 * Those five minutes are the ones the whole feature is for. Waking exactly on
 * the boundary instead costs one extra sample a day at worst.
 */
export function delayMsFrom(minute, second) {
  const nextBoundary = cadenceBoundaries.find((boundary) => boundary > minute);

  if (nextBoundary === undefined) return intervalMsFor(minute);

  const untilBoundary = (nextBoundary - minute) * 60_000 - second * 1000;

  return Math.max(1_000, Math.min(intervalMsFor(minute), untilBoundary));
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

/**
 * The day's unexplained groups, written once when the KRX session closes.
 *
 * 남북경협 was found on 2026-08-18 because somebody looked at the board and
 * asked why the top three leaders had no theme. Nothing in the system would
 * have raised it, and the six names were out of the leader list by 09:20 - the
 * evidence is gone from the screen long before anyone reads it, and only the
 * stored series still holds it.
 *
 * Written to a file rather than logged, because it is read the next morning
 * rather than watched, and the server log is a stream of collector ticks by
 * then. Failing to write a report is never a reason to interrupt collecting.
 *
 * Finding the group is the automatable half. Naming it is not: the same run
 * that surfaced 남북경협 also grouped 파두 and 후성 with the semiconductor names,
 * and they belong to neither.
 */
async function writeThemeReport(config, day) {
  try {
    const report = await buildThemeCandidates(config, day);

    if (report.symbols === 0) return;

    // Written whole rather than appended: the report is a view of stored rows,
    // so regenerating it after a restart should replace the day rather than
    // leave two copies for someone to diff in the morning.
    await mkdir("logs", { recursive: true });
    await writeFile(`logs/theme-candidates-${day}.log`, `${formatThemeCandidates(report)}
`, "utf8");

    console.log(`collector: theme report written · ${report.groups.length} groups · logs/theme-candidates-${day}.log`);
  } catch (error) {
    console.warn("collector: theme report failed", error instanceof Error ? error.message : error);
  }
}

/**
 * Symbols NXT does not answer for, remembered so the evening pass stops asking.
 *
 * Measured on the first NXT evening: of 312 names, the same 188 returned nothing
 * on two consecutive passes - zero random failures - and all 188 answered on
 * KRX. That is a listing gap, not a rate limit, and re-asking cost a retry pass
 * over 188 symbols every five minutes plus a warning line that made a normal
 * evening look broken.
 *
 * An hour rather than the whole session, because tonight's silence is not proof
 * of tomorrow's: a stock NXT lists can simply have no evening interest at 19:49
 * and quotes at 16:30. Forgetting periodically costs one wasted request an hour
 * and cannot strand a symbol that comes back.
 */
const nxtSilenceMs = 60 * 60_000;
const nxtSilentUntil = new Map();

// A pass over everything seen today costs about 24 seconds for 237 names, so it
// runs at five minutes and never on the tick's critical path.
const seenIntervalMs = 5 * 60_000;

let seenRunning = false;

/**
 * The name and theme a bare quote does not carry.
 *
 * loadKisMarketBoard classifies as it builds, but loadKrQuotes answers with a
 * price and nothing else, so the two widest passes - the seen sweep and the
 * evening follow - stored 30,963 rows on 2026-08-19 without a single theme on
 * them. That is the whole population the theme panel is meant to read, so it
 * was grouping the 251 ranked names and calling it the market.
 *
 * The name is missing for a reason worth writing down: KIS inquire-price simply
 * does not return one. Probed on 064550, the only name-ish fields in the
 * response are the market (KOSDAQ) and the industry (제약), so the quote falls
 * back to its own code and 바이오니아 was recorded as "064550". DART's
 * corporation index already maps code to name and is cached on disk for the
 * industry lookup, so it is read once and kept.
 *
 * Both lookups are in memory after that, so this is free on every tick. The
 * name is resolved first because classifyTheme reads it.
 */
let symbolNames = null;

async function withThemes(config, quotes) {
  if (symbolNames === null) {
    try {
      const index = await loadCorpIndex(config);

      symbolNames = new Map(Object.entries(index).map(([symbol, entry]) => [symbol, entry.corpName]));
    } catch (error) {
      console.warn("collector: corp index unavailable", error instanceof Error ? error.message : error);
      symbolNames = new Map();
    }

    // DART does not list every symbol the exchange ranks. 950260 is
    // 인제니아테라퓨틱스(Reg.S), a foreign Reg.S listing absent from the
    // corporation index, so the sweep stored its code and the 짝꿍 panel showed
    // "950260" as a theme's leader — while the ranking rows had carried the name
    // all along. Whatever the ranking already named, the sweep can reuse.
    try {
      const seen = await loadRecordedNames(config);

      for (const [symbol, name] of seen) {
        if (!symbolNames.has(symbol)) symbolNames.set(symbol, name);
      }
    } catch (error) {
      console.warn("collector: recorded names unavailable", error instanceof Error ? error.message : error);
    }
  }

  return quotes.map((quote) => {
    // A quote whose name is its own code is a quote KIS did not name.
    const name = quote.name && quote.name !== quote.symbol
      ? quote.name
      : symbolNames.get(quote.symbol) ?? quote.name;

    return { ...quote, name, theme: quote.theme ?? classifyTheme(quote.symbol, name) };
  });
}

/**
 * Every stock the day has already shown us, whether or not it is ranked now.
 *
 * The turnover ranking is a keyhole: a stock is visible only while it is inside
 * the top of it, so the record holds the middle of a move and neither end. On
 * 2026-08-19 this cost four separate things before lunch - 대화제약 first
 * appeared already up 11.38%, 바이오니아 was recorded once at 09:03 and then
 * vanished for eleven minutes during which it fell to about 14% and came back
 * to 26%, and SHD's first tick of the day was its limit-up. The eleven minutes
 * are the ones a 짝꿍 sets up or fails in, and none of it was written down.
 *
 * So once a symbol has been seen, it keeps being sampled. Unranked and under
 * its own source, because these are not a leader list and must not be read as
 * one.
 *
 * Started rather than awaited. The 09:00-09:30 leaders are sampled every minute
 * and that cadence is the entire point of the exercise; a 24 second pass in the
 * middle of the tick would push it out. Guarded so a slow pass cannot overlap
 * itself.
 */
function startSeenSample(config) {
  if (seenRunning) return;

  seenRunning = true;

  (async () => {
    const day = sessionDate("KR");
    const symbols = await loadSessionSymbols(config, { market: "KR", sessionDate: day });

    if (symbols.length === 0) return;

    const venue = krTradingVenue();
    const quotes = await loadKrQuotes(config, symbols, venue);

    if (quotes.length === 0) return;

    const saved = await saveMarketPriceSamples(config, {
      market: "KR",
      observedAt: new Date().toISOString(),
      ranked: false,
      sessionDate: day,
      source: `kis:${venue === "NX" ? "nxt" : "krx"}:seen`,
      stocks: await withThemes(config, quotes)
    });
    // Designations ride along on the same quotes, so this is free. Written from
    // the widest pass because it is the one that sees every symbol.
    const flagged = await saveSymbolFlags(config, { sessionDate: day, stocks: quotes })
      .catch((error) => {
        console.warn("collector: symbol flags failed", error instanceof Error ? error.message : error);

        return 0;
      });

    if (saved > 0) console.log(`collector: ${saved} seen-symbol samples · ${flagged} flags`);
  })()
    .catch((error) => console.warn("collector: seen sample failed", error instanceof Error ? error.message : error))
    .finally(() => {
      seenRunning = false;
    });
}

/**
 * The evening, following the day's names rather than ranking the evening book.
 *
 * Not a second leader ranking. NXT after 15:40 is thin enough that a few
 * hundred million won tops a turnover list, which would return a different cast
 * every tick and none of it the cast the day was about. The question worth
 * answering after the close is narrower: the stocks that led today, and the
 * ones that were supposed to follow them, where did they end up before tomorrow
 * opens.
 *
 * Stored with no rank and under its own source, so nothing downstream can read
 * an evening print as a leader or sum its turnover into the KRX day.
 */
async function sampleAfterHours(config) {
  const day = sessionDate("KR");
  const recorded = await loadSessionSymbols(config, { market: "KR", sessionDate: day });
  const symbols = recorded.filter((symbol) => (nxtSilentUntil.get(symbol) ?? 0) < Date.now());

  if (symbols.length === 0) return 0;

  const quotes = await loadKrQuotes(config, symbols, "NX");
  const answered = new Set(quotes.map((quote) => quote.symbol));

  for (const symbol of symbols) {
    if (!answered.has(symbol)) nxtSilentUntil.set(symbol, Date.now() + nxtSilenceMs);
  }

  if (quotes.length === 0) return 0;

  return saveMarketPriceSamples(config, {
    market: "KR",
    observedAt: new Date().toISOString(),
    ranked: false,
    sessionDate: day,
    source: "kis:nxt:after",
    stocks: await withThemes(config, quotes)
  });
}

// One screener call a tick, and the whole US session is six and a half hours,
// so there is nothing to gain from the minute cadence the Korean open needs.
const usIntervalMs = 5 * 60_000;
const usExtendedIntervalMs = 10 * 60_000;

/**
 * The US leaders, while the US session is actually open.
 *
 * Only during the regular session, and that is measured rather than assumed.
 * At 20:26 KST - the middle of the US pre-market - Yahoo's screener returned
 * AXTI +17.5527, CBRS +15.0699 and SNDK +8.88057, which are Monday's closes to
 * the second decimal. It reports the last completed session and does not move
 * outside one, so sampling it before 22:30 would write yesterday's numbers over
 * and over, the same trap as asking KRX in the evening.
 *
 * The pre-market and after-market need the per-symbol chart against a
 * watchlist, which is a different mechanism and a separate decision about who
 * is on that list.
 */
async function sampleUsPrices(config) {
  const payload = await loadMarketData(config);
  const stocks = payload?.usLeadingStocks ?? [];

  if (stocks.length === 0) return 0;

  return saveMarketPriceSamples(config, {
    market: "US",
    observedAt: new Date().toISOString(),
    // The screener ranks by turnover, which is the same question the domestic
    // ranking answers, so the rank is worth keeping.
    sessionDate: sessionDate("US"),
    source: "yahoo:us:regular",
    stocks
  });
}

/**
 * The whole watchlist during the session, beside the screener's thirty.
 *
 * The screener is the only US ranking there is and it answers with thirty
 * names, so from the bell to the close everything else was invisible. Measured
 * 2026-08-19 at 22:48 against a broker's list of the day's risers: of eighteen
 * names above +20%, the board had one. The others were not missing from the
 * market, they were missing from the question.
 *
 * Started rather than awaited, and guarded, exactly as the domestic sweep is: a
 * 1,200-name pass takes about three minutes and must not delay the five-minute
 * screener tick behind it.
 */
let usSeenRunning = false;

function startUsSeenSample(config) {
  if (usSeenRunning) return;

  usSeenRunning = true;

  (async () => {
    const { stocks } = await loadUsExtendedSamples(config, { allowRegular: true });

    if (stocks.length === 0) return;

    const saved = await saveMarketPriceSamples(config, {
      market: "US",
      observedAt: new Date().toISOString(),
      ranked: false,
      sessionDate: sessionDate("US"),
      source: "yahoo:us:regular:seen",
      stocks
    });

    if (saved > 0) console.log(`collector: ${saved} US session-wide samples`);
  })()
    .catch((error) => console.warn("collector: US seen sample failed", error instanceof Error ? error.message : error))
    .finally(() => {
      usSeenRunning = false;
    });
}

/**
 * The US pre-market and after-market, which the screener cannot see.
 *
 * A different mechanism from the session pass and not a choice: the screener is
 * frozen outside the bell, so these hours have to be read one symbol at a time
 * against a list decided in advance. Measured live at 20:18 KST - 431 of a 475
 * name watchlist answered in 25 seconds, with PFSA +113% and WETO +44%, both
 * matching what a broker's screen showed for the same minute.
 *
 * Stored unranked. There is no turnover to rank on out here, and the watchlist
 * is not the market - a stock missing from it is missing from this entirely,
 * which is a limit of the free data rather than a fact about the day.
 */
async function sampleUsExtended(config) {
  const { phase, stocks } = await loadUsExtendedSamples(config);

  if (stocks.length === 0) return 0;

  return saveMarketPriceSamples(config, {
    market: "US",
    observedAt: new Date().toISOString(),
    ranked: false,
    sessionDate: sessionDate("US"),
    source: `yahoo:us:${phase}`,
    stocks
  });
}

const programIntervalMs = 5 * 60_000;
// Program flow is only worth asking about where money is concentrated, and one
// request per symbol means the whole watchlist is out of reach. Forty is about
// eight seconds of calls, comfortably inside a five minute tick.
const programSymbolLimit = 40;
let programRunning = false;

/**
 * 프로그램매매 — 그날의 주도주만.
 *
 * 장중에 읽을 수 있는 수급은 이것뿐입니다. 개인·외국인·기관은 장이 끝나고 정산된
 * 뒤에야 나오므로, "지금 누가 들어오고 있나"에 답하는 유일한 계열입니다.
 *
 * 훑기 패스와 같은 이유로 await 하지 않습니다: 마흔 번의 요청이 5분 틱을 붙잡고
 * 있으면 그동안 가격 표본이 빕니다.
 */
function startProgramSample(config) {
  if (programRunning) return;

  programRunning = true;

  (async () => {
    const day = sessionDate("KR");
    const payload = await loadKisMarketBoard(config);
    const symbols = (payload?.krLeadingStocks ?? [])
      .filter((stock) => stock.venue !== "NXT")
      .sort((left, right) => Number(right.turnoverValue ?? 0) - Number(left.turnoverValue ?? 0))
      .slice(0, programSymbolLimit)
      .map((stock) => stock.symbol);

    if (symbols.length === 0) return;

    const { answered, rows } = await collectProgramTrade(config, symbols);

    if (rows.length === 0) return;

    const saved = await saveProgramTrade(config, { rows, sessionDate: day });

    if (saved > 0) console.log(`collector: program trade ${answered}/${symbols.length} symbols · ${saved} rows`);
  })()
    .catch((error) => console.warn("collector: program trade failed", error instanceof Error ? error.message : error))
    .finally(() => {
      programRunning = false;
    });
}


const snapshotIntervalMs = 10 * 60_000;
// A board this young is worth republishing as it is. Wider than that and the
// prices in it are older than the ten minutes the snapshot promises.
const boardReuseMs = 3 * 60_000;
let lastSnapshotAt = 0;
let lastBoard = null;
let lastBoardAt = 0;
let snapshotRunning = false;

/** Keeps the news sample's board so the publisher can reuse it. */
function rememberBoard(board) {
  lastBoard = board;
  lastBoardAt = Date.now();
}

/**
 * Every ten minutes, whatever else the collector is doing.
 *
 * It used to publish from inside the news sample, which meant it inherited the
 * news cadence — ten minutes in session but forty-five outside it, so the
 * deployed site went three quarters of an hour between updates while the US
 * market was open.
 *
 * The news board is reused when it is fresh, because a second build would ask
 * every provider again for the same minute. Outside the session there is no
 * fresh one, so this builds its own. Guarded and never awaited: a build plus a
 * git push over a home connection is not something a sampling loop should wait
 * on, and two overlapping pushes would fight over the same branch.
 */
function startSnapshotPublish(config) {
  if (snapshotRunning || Date.now() - lastSnapshotAt < snapshotIntervalMs) return;

  snapshotRunning = true;
  lastSnapshotAt = Date.now();

  (async () => {
    const board = Date.now() - lastBoardAt < boardReuseMs && lastBoard
      ? lastBoard
      : await getMarketBoard(config);
    const result = await publishBoardSnapshot(board, { config });

    if (result.published) console.log(`collector: board snapshot published · ${result.generatedAt}`);
    else if (result.reason !== "변경 없음") console.warn(`collector: snapshot held · ${result.reason}`);
  })()
    .catch((error) => console.warn("collector: snapshot publish failed", error instanceof Error ? error.message : error))
    .finally(() => {
      snapshotRunning = false;
    });
}

async function sampleNews(config) {
  // The only reader that wants the providers' original objects. Normalization
  // keeps what the board draws and drops the rest, and the rest is what a
  // classifier trained on these headlines would have to read.
  const board = await getMarketBoard(config, { includeRawPayloads: true });

  startSnapshotPublish(config, board);

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
  let lastSeenAt = 0;
  let lastProgramAt = 0;
  let lastUsAt = 0;
  let lastUsExtendedAt = 0;
  let lastUsSeenAt = 0;
  let reportedDay = null;

  async function tick() {
    if (stopped) return;

    const now = new Date();
    let delay = idleIntervalMs;
    let sessionOpen = false;

    // The weekday window is checked first because it is free; the holiday
    // lookup only runs on days that got past it.
    if (isCollecting(now) && await isKrMarketOpen(config, now)) {
      const { minute, second } = seoulMinute(now);

      delay = delayMsFrom(minute, second);
      sessionOpen = true;

      try {
        const afterHours = isAfterHours(minute);

        // The KRX day is complete at the handover, so the report is written on
        // the first evening tick rather than at 20:00 - a session that ends
        // early, or a machine shut at seven, still leaves one behind.
        if (afterHours && reportedDay !== sessionDate("KR")) {
          reportedDay = sessionDate("KR");
          await writeThemeReport(config, reportedDay);
        }

        const saved = afterHours ? await sampleAfterHours(config) : await samplePrices(config);

        if (saved > 0) console.log(`collector: ${saved} ${afterHours ? "after-hours " : ""}price samples`);

        // Only while the ranked pass runs. After 15:40 the evening pass already
        // follows the day's names and this would ask the same question twice.
        if (!afterHours && Date.now() - lastSeenAt >= seenIntervalMs) {
          lastSeenAt = Date.now();
          startSeenSample(config);
        }

        // Program flow, for the ranked names only. KRX publishes it for the
        // regular session, so the evening and the pre-market have none.
        if (!afterHours && Date.now() - lastProgramAt >= programIntervalMs) {
          lastProgramAt = Date.now();
          startProgramSample(config);
        }
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

    // The US session runs 22:30-05:00 in Seoul, so it overlaps nothing domestic
    // and its own clock decides it. Sampled on the same loop rather than a
    // second timer: one tick either side of midnight is easier to reason about
    // than two loops that can both be mid-request.
    // Gated on elapsed time rather than on the tick delay. delay is already the
    // sixty-second idle when nothing domestic is open, so Math.min against it
    // never raised anything and the US passes ran on every tick: measured over
    // the first full night, the session sampled every 1.03 minutes against a
    // stated five, and the watchlist every 1.43 against ten. Five times the
    // requests to an unauthenticated endpoint, for resolution nothing asked for.
    if (isRegularSession("US", now)) {
      if (Date.now() - lastUsAt >= usIntervalMs) {
        lastUsAt = Date.now();

        try {
          const saved = await sampleUsPrices(config);

          if (saved > 0) console.log(`collector: ${saved} US price samples`);
        } catch (error) {
          console.warn("collector: US sample failed", error instanceof Error ? error.message : error);
        }
      }

      // Half the session cadence, because it is a pass over the whole watchlist
      // rather than one screener call.
      if (Date.now() - lastUsSeenAt >= usExtendedIntervalMs) {
        lastUsSeenAt = Date.now();
        startUsSeenSample(config);
      }
    } else if (usMarketPhase() !== "closed") {
      // A watchlist pass is 25 seconds of requests rather than one screener
      // call, so it runs at half the session cadence.
      if (Date.now() - lastUsExtendedAt >= usExtendedIntervalMs) {
        lastUsExtendedAt = Date.now();

        try {
          const saved = await sampleUsExtended(config);

          if (saved > 0) console.log(`collector: ${saved} US extended-hours samples`);
        } catch (error) {
          console.warn("collector: US extended sample failed", error instanceof Error ? error.message : error);
        }
      }
    }

    // Independent of every sampling window: the deployed site should never be
    // more than ten minutes behind, whichever market happens to be open.
    startSnapshotPublish(config);

    if (!stopped) timeoutId = setTimeout(tick, delay);
  }

  console.log("market collector on · 국내 08:00–20:00 · 미국 18:00–09:00(프리·정규·애프터) · 뉴스 상시");
  void tick();

  return () => {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
