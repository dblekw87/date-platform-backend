import { getCache, readThroughCache, setCache } from "../cache.mjs";
import { formatTradingAmount } from "./format.mjs";
import { loadKrQuotes } from "./kis.mjs";
import { listRegisteredCompanies, resolveCompanyNames } from "./industry.mjs";
import { classifyTheme, membersOfTheme } from "./themes.mjs";

/**
 * 짝꿍 후보 — the stocks that could follow a leader, looked for where they are.
 *
 * The board used to count these inside the leader list, which cannot work. A
 * leader is a stock the day's money concentrated on, so the list skews large;
 * the stock that follows one is smaller than it by definition and never appears
 * there. 삼성전기 led with 1.5조 of turnover while 삼화콘덴서 did 1,155억 and
 * 코칩 98억 — neither is within reach of a top-38 ranking, and the board
 * therefore reported 삼성전기 as having no 짝꿍 at all, every single day.
 *
 * So the candidate pool is the theme's membership rather than the leader list.
 * The curated map already holds it; what was missing was the ability to ask
 * about a stock by name, which the ranking endpoints cannot do.
 *
 * Only rising members are candidates. A member that is down is not a 2등주
 * waiting to move, it is evidence the theme is not moving as a group, and
 * saying so is the useful answer on the days it happens — MLCC on 2026-08-14
 * had its leader up 3.66% and every member below it red.
 */

// One board build's worth. These are read alongside the leader list and should
// be as fresh as it is, without every rebuild re-asking about the same names.
const quoteCacheTtlMs = 60_000;

// A symbol KIS refuses to quote is a fact about the listing, not about the
// minute, so it is remembered for the session rather than for a tick.
const quoteMissTtlMs = 6 * 60 * 60_000;

// Each member costs a quote, and the themes asked about are only the ones a
// leader is standing in — at most eight.
//
// Twelve was set when a board build paid for these at request time. The
// collector pays now, once a tick, and the board reads what it warmed — so the
// limit stopped being about latency and went back to being about the daily
// request count. Twenty-four fits every curated theme except 2차전지, which is
// the only one with more members than that; at twelve it was cutting four names
// off 패키지기판·PCB and eleven off 2차전지, in the arbitrary order JavaScript
// happens to enumerate object keys.
//
// Curated members are taken first. They are the ones somebody chose, and 바이오
// classifies 174 companies by name alone: without an order this would be
// whichever hundred-and-seventy-four happened to sort first.
const maxMembersPerTheme = 24;

// The corp index behind this changes monthly at most, and the classification is
// pure. An hour means a board build almost never pays for it.
const universeCacheTtlMs = 60 * 60_000;

// A follower has to be takeable. 인바이오젠 rose 0.95% on 0.2억 of turnover and
// 엔솔바이오사이언스 0.94% on 0.4억 — at that size the print is a quote, not a
// position, and a list of them reads as nine candidates where there is one.
//
// Lower than the 30억 floor themes are scored on, deliberately: a 짝꿍 is
// smaller than what it follows, so the same floor would delete the whole idea.
export const minimumCandidateTurnover = 1_000_000_000;

/**
 * Theme membership across every listed company, not just the curated map.
 *
 * The map is a few hundred symbols chosen by hand; the same rules run over all
 * 3,927 registrations find 628. That difference is the whole point here — a
 * 짝꿍 is a stock nobody was watching, so a candidate pool assembled only from
 * names somebody already wrote down is the wrong pool by construction.
 */
async function loadThemeUniverse(config) {
  return readThroughCache("kr-theme-universe", universeCacheTtlMs, async () => {
    const companies = await listRegisteredCompanies(config);
    const byTheme = new Map();

    companies.forEach(({ name, symbol }) => {
      const theme = classifyTheme(symbol, name);

      if (theme === "ETF" || theme === "미분류") return;

      if (!byTheme.has(theme)) byTheme.set(theme, []);

      byTheme.get(theme).push(symbol);
    });

    return byTheme;
  });
}

// Same list leadership.mjs screens on: labels describing how a stock surfaced
// rather than what it belongs to. A leader carrying one of these has no group
// behind it, and a sector read off a KSIC or SIC code is not a group either —
// it names the company without anything having been observed moving with it.
const nonThemeLabels = new Set(["ETF", "미분류", "개별 이슈", "거래대금 급증", "소형주 급등"]);

/**
 * Preferred shares are the same company as their common stock, so they are not
 * a 짝꿍 — taking 삼성전자우 because 삼성전자 moved is taking the thing that
 * already moved. Domestic common stock ends in 0; 005935 is the preferred line
 * of 005930, and it arrived near the top of 반도체's candidates on the first run.
 *
 * themes.mjs screens these by name, which is no help here: the pool is symbols
 * and the price endpoint returns no name to screen on.
 */
export function isPreferredShare(symbol) {
  return /^\d{5}[^0]$/.test(symbol);
}

/**
 * The theme a leader may be paired on.
 *
 * Read off the original stock rather than the leader, because the leader's
 * `theme` is a display value that may have come from the registered-industry
 * floor. Pairing has to run on the curated answer only.
 */
function pairThemeOf(leader, stocksBySymbol) {
  const theme = stocksBySymbol.get(leader.symbol)?.theme?.trim();

  return theme && !nonThemeLabels.has(theme) ? theme : undefined;
}

/**
 * Quotes for candidate symbols, cached one symbol at a time.
 *
 * Keying the cache on the whole set was wrong: the set changes whenever the
 * leaders do, so one new theme threw away ninety quotes that were seconds old
 * and re-asked for all of them. Per symbol, a changed set costs only what
 * actually changed.
 */
async function loadOutsideQuotes(config, symbols) {
  if (symbols.length === 0) return new Map();

  const known = new Map();
  const missing = [];

  symbols.forEach((symbol) => {
    const cached = getCache(`kr-quote:${symbol}`);

    if (cached) known.set(symbol, cached);
    else if (!getCache(`kr-quote-miss:${symbol}`)) missing.push(symbol);
  });

  if (missing.length > 0) {
    const [quotes, names] = await Promise.all([
      loadKrQuotes(config, missing),
      resolveCompanyNames(config, missing)
    ]);

    quotes.forEach((quote) => {
      const name = names[quote.symbol] ?? quote.name;
      const member = {
        changeRateValue: quote.changeRateValue,
        name,
        symbol: quote.symbol,
        // Its own theme rather than the leader's. A symbol can be wanted by two
        // leaders, and a price series should record what the stock is, not what
        // it happened to be looked up for.
        theme: classifyTheme(quote.symbol, name),
        turnoverValue: quote.turnoverValue
      };

      known.set(quote.symbol, setCache(`kr-quote:${quote.symbol}`, member, quoteCacheTtlMs));
    });

    // Symbols KIS will not quote at all — names the DART index still lists that
    // have been delisted, merged or suspended. Eight of forty-five on the
    // current board, and without this they are re-asked on every tick forever,
    // each one costing a request and a retry. Remembered far longer than a
    // price, because the answer is about the listing rather than the day.
    const answered = new Set(quotes.map((quote) => quote.symbol));

    missing
      .filter((symbol) => !answered.has(symbol))
      .forEach((symbol) => setCache(`kr-quote-miss:${symbol}`, true, quoteMissTtlMs));
  }

  return known;
}

/**
 * The 짝꿍 board — one row per theme rather than per leader.
 *
 * Built from leaders that already carry their candidates, and grouped because
 * the leader list repeats a theme whenever two of its names lead: 반도체 with
 * SK하이닉스 and 삼성전자 at the top produced the same seven followers twice.
 * A trader reads this as "반도체 is moving, here is what has not moved yet",
 * which is one row, not two.
 *
 * The strongest leader in a theme is the 1등주 the trade is triggered off, so
 * the leaders are already in rank order and the first one wins.
 */
export function buildPairBoard(leaders) {
  const byTheme = new Map();

  leaders.forEach((leader) => {
    if (!leader.pairCandidates?.length || byTheme.has(leader.theme)) return;

    byTheme.set(leader.theme, {
      id: `pair-${leader.market.toLowerCase()}-${leader.theme}`,
      candidates: leader.pairCandidates,
      leader: {
        changeRateValue: leader.changeRateValue,
        name: leader.name,
        symbol: leader.symbol,
        turnover: leader.turnover
      },
      market: leader.market,
      theme: leader.theme,
      // How far the strongest member is from the leader. Kept because it is a
      // fact worth reading, no longer treated as the size of an opportunity —
      // see the sort below.
      leadGap: Number((leader.changeRateValue - leader.pairCandidates[0].changeRateValue).toFixed(2))
    });
  });

  /*
   * Strongest theme first, by how far its members actually moved.
   *
   * This sorted by the widest gap, on the reading that the gap is the room left
   * in the trade. Measured across 186,726 pairs over 396 sessions, the gap
   * predicts nothing: buckets of 0-3, 3-7, 7-15 and 15+%p produced -0.009,
   * +0.002, +0.015 and -0.042%p of excess overnight gap, in no order at all.
   * And the bucket this used to push to the bottom — the member that already
   * ran past its leader — is the only one carrying a number, at +1.161%p.
   *
   * A lagging member is not a coiled spring. It is the member that is not
   * moving, and it is also worse than simply buying the leader (+0.046%p of
   * next-day excess against the leader's +0.158%p).
   *
   * What the measurement does support is the theme: a rising member of a theme
   * whose leader ran gaps +0.460%p overnight against +0.073%p for any stock
   * that merely rose that day. So the theme is the signal, and the order inside
   * the list should follow strength rather than distance from the leader.
   */
  return [...byTheme.values()].sort((left, right) =>
    (right.candidates[0]?.changeRateValue ?? 0) - (left.candidates[0]?.changeRateValue ?? 0));
}

/**
 * Which stocks could follow these leaders, and what they are trading at.
 *
 * Shared by the board and by the collector, which needs the same answer for a
 * different reason: the follower's own price series. The leader list is the
 * only thing being recorded today, and a series of leaders can only ever show
 * lead-lag between leaders — the same structural flaw peerCounts had, one layer
 * down. 삼화콘덴서 has to be in the record before anything can be learned about
 * it following 삼성전기.
 */
async function loadPairPool(config, leaders, stocks) {
  const stocksBySymbol = new Map(stocks.map((stock) => [stock.symbol, stock]));
  const inPool = new Set(stocksBySymbol.keys());
  let universe = new Map();

  try {
    universe = await loadThemeUniverse(config);
  } catch (error) {
    // The curated map still answers on its own, just with a thinner pool.
    console.warn("theme universe unavailable", error instanceof Error ? error.message : error);
  }

  const membersFor = (leader) => {
    const theme = pairThemeOf(leader, stocksBySymbol);

    if (!theme) return [];

    // Curated first, then everything the rules found. Order matters because the
    // cap below cuts the tail, and a name somebody chose outranks one a regex
    // agreed with.
    return [...new Set([...membersOfTheme(theme), ...(universe.get(theme) ?? [])])]
      .filter((symbol) => symbol !== leader.symbol && !isPreferredShare(symbol));
  };
  const wanted = new Set(leaders.flatMap((leader) =>
    membersFor(leader).filter((symbol) => !inPool.has(symbol)).slice(0, maxMembersPerTheme)));

  if (wanted.size === 0) return { inPool, membersFor, outside: new Map(), stocksBySymbol };

  try {
    return { inPool, membersFor, outside: await loadOutsideQuotes(config, [...wanted]), stocksBySymbol };
  } catch (error) {
    // Without the quotes there are no candidates, and the leader list is still
    // correct without them.
    console.warn("pair candidate quotes failed", error instanceof Error ? error.message : error);

    return { failed: true, inPool, membersFor, outside: new Map(), stocksBySymbol };
  }
}

/**
 * The follower quotes behind the day's leaders, for recording.
 *
 * Called by the collector on its own tick rather than by a board build, which
 * has two effects. The series gains the stocks that follow, and every board
 * build inside the next minute reads quotes the collector has already paid for
 * — the cold build was thirteen seconds of KIS calls for exactly these names.
 */
export async function loadPairQuotes(config, leaders, stocks) {
  const { outside } = await loadPairPool(config, leaders, stocks);

  return [...outside.values()];
}

/** Attaches the 짝꿍 candidates behind each domestic leader. */
export async function attachPairCandidates(config, leaders, stocks) {
  const { failed, inPool, membersFor, outside, stocksBySymbol } = await loadPairPool(config, leaders, stocks);

  // Only a failed fetch bails. An empty pool still leaves the members that are
  // leaders in their own right, which the earlier early-return threw away.
  if (failed) return leaders;

  return leaders.map((leader) => {
    const theme = pairThemeOf(leader, stocksBySymbol);

    if (!theme) return leader;

    // Two sources, one list: theme members big enough to be leaders in their own
    // right, and the far more common case of members that are not.
    const fromPool = stocks.filter((stock) =>
      stock.symbol !== leader.symbol && stock.theme === theme && !isPreferredShare(stock.symbol));
    const fromTheme = membersFor(leader).flatMap((symbol) => inPool.has(symbol) ? [] : outside.get(symbol) ?? []);
    const candidates = [...fromPool, ...fromTheme]
      .filter((member) => Number(member.changeRateValue) > 0 && Number(member.turnoverValue) >= minimumCandidateTurnover)
      .sort((left, right) => Number(right.changeRateValue) - Number(left.changeRateValue))
      .map((member) => ({
        changeRateValue: Number(member.changeRateValue),
        // Says whether the follower is liquid enough to actually take, which a
        // percentage on its own does not.
        inLeaderBoard: inPool.has(member.symbol),
        name: member.name,
        symbol: member.symbol,
        turnover: formatTradingAmount(member.turnoverValue, "KRW")
      }));

    return {
      ...leader,
      caution: candidates.length > 0
        ? "같은 테마 종목의 동반 여부와 거래대금 유지 확인"
        : "테마 동반이 없어 개별 재료일 수 있으니 뉴스·공시 원문 확인",
      pairCandidates: candidates,
      pairTrade: candidates.length > 0 ? "테마 주도" : "단독 주도",
      peerCount: candidates.length
    };
  });
}
