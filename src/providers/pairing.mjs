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

// Each member costs a quote, and the themes asked about are only the ones a
// leader is standing in — at most eight. Twelve apiece keeps the worst case
// near a hundred names, which the sixty second cache below pays for once.
//
// Curated members are taken first. They are the ones somebody chose, and 바이오
// classifies 174 companies by name alone: without an order this would be
// whichever hundred-and-seventy-four happened to sort first.
const maxMembersPerTheme = 12;

// The corp index behind this changes monthly at most, and the classification is
// pure. An hour means a board build almost never pays for it.
const universeCacheTtlMs = 60 * 60_000;

// A follower has to be takeable. 인바이오젠 rose 0.95% on 0.2억 of turnover and
// 엔솔바이오사이언스 0.94% on 0.4억 — at that size the print is a quote, not a
// position, and a list of them reads as nine candidates where there is one.
//
// Lower than the 30억 floor themes are scored on, deliberately: a 짝꿍 is
// smaller than what it follows, so the same floor would delete the whole idea.
const minimumCandidateTurnover = 1_000_000_000;

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
function isPreferredShare(symbol) {
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
    else missing.push(symbol);
  });

  if (missing.length > 0) {
    const [quotes, names] = await Promise.all([
      loadKrQuotes(config, missing),
      resolveCompanyNames(config, missing)
    ]);

    quotes.forEach((quote) => {
      const member = {
        changeRateValue: quote.changeRateValue,
        name: names[quote.symbol] ?? quote.name,
        symbol: quote.symbol,
        turnoverValue: quote.turnoverValue
      };

      known.set(quote.symbol, setCache(`kr-quote:${quote.symbol}`, member, quoteCacheTtlMs));
    });
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
      // What the trade is waiting on. The leader has moved; this is how far the
      // best follower still is from it, which is the gap the trade lives in.
      leadGap: Number((leader.changeRateValue - leader.pairCandidates[0].changeRateValue).toFixed(2))
    });
  });

  // Widest gap first, because the gap is the room left in the trade. A negative
  // one says the follower already ran harder than the leader did, which is the
  // same theme read too late — worth showing, worth showing last.
  return [...byTheme.values()].sort((left, right) => right.leadGap - left.leadGap);
}

/** Attaches the 짝꿍 candidates behind each domestic leader. */
export async function attachPairCandidates(config, leaders, stocks) {
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

  if (wanted.size === 0) return leaders;

  let outside;

  try {
    outside = await loadOutsideQuotes(config, [...wanted]);
  } catch (error) {
    // Without the quotes there are no candidates to add, and the leader list is
    // still correct without them.
    console.warn("pair candidate quotes failed", error instanceof Error ? error.message : error);

    return leaders;
  }

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
