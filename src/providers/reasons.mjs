import { classifyHeadline } from "./catalyst.mjs";
import { formatTradingAmount } from "./format.mjs";
import { query } from "../db/client.mjs";
import { readThroughCache } from "../cache.mjs";

/**
 * 오른 이유 — several candidates per leader, each with the path that makes it
 * this stock's reason, scored on evidence rather than asserted.
 *
 * The catalyst layer this sits above answers with one label off one headline,
 * and measuring it against the reasons a real screen gave for SK텔레콤 on
 * 2026-08-16 — 앤트로픽 지분 가치, 방어주 선호, 5G SA 상용화, 요금제 개편 —
 * returned 이유 미확인 four times out of four. The failures were not vocabulary.
 * They were structural, and all three are addressed here:
 *
 *   the subject is not the stock   앤트로픽 was revalued, 텐센트 bought a stake,
 *                                  엔비디아 reported. The rules classified the
 *                                  event and then filed it as the stock's own,
 *                                  which is how "엔비디아 실적 호조에 국내 반도체
 *                                  동반 상승" became 심텍's 고유/실적.
 *   the headline never names it    "이동통신 요금제 개편안" reaches no symbol,
 *                                  because tagging matches company names.
 *   the driver is not listed       Anthropic has no price and no theme, so no
 *                                  amount of co-movement can find it. Only the
 *                                  ownership graph can.
 *
 * So a reason is (주체, 사건, 경로) and the engine's job is the third part: why
 * this event is this stock's reason. Five generators propose candidates, each
 * carrying its own path, and the score is how much evidence stands behind one —
 * never a probability that the stock keeps rising.
 */

// A reason nobody can check is not worth showing. Every candidate below carries
// figures in `evidence`, and one that cannot is dropped rather than softened.
const minimumConfidence = 25;

// Three is what a reader will actually read. Beyond it the list stops being an
// answer and becomes a search result.
const maximumReasons = 3;

/* ------------------------------------------------------------------ 지분 */

// A stake worth naming. 한국자산신탁 holds SK하이닉스, 삼성전자, 테슬라 and
// 엔비디아 in amounts that matched every headline about any of them — 24억 —
// while SK텔레콤's Anthropic stake is 1조 3,762억. Percentage cannot separate
// them, because Anthropic is 0.3% and it is the whole story. Size can.
const minimumStakeBookValue = 50_000_000_000;
const minimumStakeRevaluation = 30_000_000_000;

const ownershipCacheTtlMs = 6 * 60 * 60_000;

/**
 * Filers write footnote markers and qualifiers into the name field —
 * "한화엔진\n주3)", "앱클론(상장)" — and a name carrying a line break matches
 * nothing and reads worse. Names that open with a bracket keep their original
 * text, because cutting at the first one leaves nothing at all.
 */
function cleanName(value) {
  const text = String(value ?? "").trim();
  const head = text.split(/[\n(（]/)[0].trim();

  return head || text;
}

/**
 * Every material stake in the market, keyed by holder.
 *
 * Read whole rather than per leader: the same map answers both directions, and
 * the second direction — which listed company owns the private one a headline
 * just named — is the one that finds 앤트로픽 → SK텔레콤.
 */
async function loadStakes(config, businessYear) {
  return readThroughCache(`kr-stakes-${businessYear}`, ownershipCacheTtlMs, async () => {
    const result = await query(
      config,
      `SELECT holder_symbol, investee_name, stake_pct, book_value, valuation_change
         FROM kr_ownership_edges
        WHERE business_year = $1
          AND (book_value >= $2 OR valuation_change >= $3)
        ORDER BY valuation_change DESC NULLS LAST`,
      [businessYear, minimumStakeBookValue, minimumStakeRevaluation]
    );
    const byHolder = new Map();

    result.rows.forEach((row) => {
      if (!byHolder.has(row.holder_symbol)) byHolder.set(row.holder_symbol, []);

      byHolder.get(row.holder_symbol).push({
        bookValue: Number(row.book_value),
        investeeName: cleanName(row.investee_name),
        stakePct: row.stake_pct === null ? null : Number(row.stake_pct),
        valuationChange: row.valuation_change === null ? null : Number(row.valuation_change)
      });
    });

    return byHolder;
  });
}

// Two characters is a substring of half the language. Three is the shortest
// name that identifies a company on its own — 텐센트, 앤트로픽, TSMC.
const minimumEntityNameLength = 3;

// How many US names to recognise as possible subjects. English has word
// boundaries, so the substring problem that forces the Korean dictionary to be
// exhaustive does not apply; the risk here is the opposite one — Apple, Gap,
// Block and Target are ordinary words, and a dictionary of all 5,320 listed
// common stocks would find a company in every other sentence. Ranking by what
// actually trades keeps the list to the companies headlines are written about.
const usEntityLimit = 400;

const usEntityCacheTtlMs = 24 * 60 * 60_000;

/**
 * The legal tail of a US company name, which no headline ever prints.
 * "Sandisk Corporation Common Stock" is written about as Sandisk.
 */
const legalSuffixPattern = /\b(?:common\s+stock|ordinary\s+shares?|class\s+[a-z]|depositary\s+shares?|incorporated|inc|corporation|corp|company|co|limited|ltd|plc|nv|sa|ag|holdings?|group)\b\.?/gi;

function normalizeUsName(value) {
  return String(value ?? "")
    .replace(legalSuffixPattern, " ")
    .replace(/[,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * US company names worth recognising as the subject of a headline.
 *
 * Ranked by dollar volume out of our own daily bars rather than by market cap,
 * because what gets written about is what is being traded. Names are kept with
 * their original capitalisation and matched case-sensitively on a word
 * boundary, which is what keeps Gap and Block from matching "the gap between"
 * and "block trade".
 */
async function loadUsEntityNames(config) {
  return readThroughCache("us-entity-names", usEntityCacheTtlMs, async () => {
    const result = await query(
      config,
      `SELECT t.symbol, t.name
         FROM us_daily_bars b
         JOIN us_tickers t ON t.symbol = b.symbol
                          AND t.as_of = (SELECT max(as_of) FROM us_tickers)
        WHERE b.session_date > current_date - 45
          AND t.type = 'CS'
          AND t.name IS NOT NULL
        GROUP BY t.symbol, t.name
        ORDER BY avg(b.close * b.volume) DESC NULLS LAST
        LIMIT $1`,
      [usEntityLimit]
    );

    return result.rows
      .map((row) => normalizeUsName(row.name))
      .filter((name) => name.length >= 4);
  });
}

/**
 * Company names a headline might use, from every stake in the market.
 *
 * Separate from the material stakes above, and deliberately unfiltered: 엔비디아
 * appears in the graph only as a 7억 line in a trust company's portfolio, far
 * below anything worth calling a reason, and yet "엔비디아 실적 호조에 국내
 * 반도체 동반 상승" cannot be read correctly without knowing 엔비디아 is a
 * company. Recognising a name and acting on a stake are different jobs.
 *
 * 32,842 names is the largest company dictionary either repository has, and it
 * cost nothing extra — it is the same table read a second way.
 */
async function loadEntityNames(config, businessYear) {
  return readThroughCache(`kr-entity-names-${businessYear}`, ownershipCacheTtlMs, async () => {
    const result = await query(
      config,
      "SELECT DISTINCT investee_name FROM kr_ownership_edges WHERE business_year = $1",
      [businessYear]
    );

    return [...new Set(result.rows.map((row) => cleanName(row.investee_name)))]
      .filter((name) => name.length >= minimumEntityNameLength);
  });
}

/**
 * Stakes as reasons — but only the ones today's news is about.
 *
 * A stake is a standing fact. SK하이닉스 has held BCPE Pangea Cayman2 Limited,
 * the vehicle it bought Intel's NAND business through, for years; showing it
 * against a 4.65% day says the stock rose because of a Cayman holding company,
 * which is false and unreadable at the same time. Every large filer has several
 * of these, so scoring them low was not enough — on a quiet day they were the
 * only thing left and became the answer by default.
 *
 * So the headline is what creates the candidate, not what lifts it. Anthropic
 * is SK텔레콤's reason on the day Anthropic is written about and on no other
 * day, which is exactly what the screen said.
 */
function ownershipReasons(leader, stakes, headlineText) {
  return (stakes.get(leader.symbol) ?? [])
    .filter((stake) => stake.investeeName.length >= minimumEntityNameLength
      && headlineText.includes(stake.investeeName))
    .slice(0, 2)
    .map((stake) => {
      const evidence = [`지분 ${stake.stakePct === null ? "비공개" : `${stake.stakePct}%`} · 장부가 ${formatTradingAmount(stake.bookValue, "KRW")}`];

      // formatTradingAmount answers "확인 중" for anything not positive, so the
      // sign is carried separately rather than handed to it.
      if (stake.valuationChange) {
        evidence.push(`전년 대비 ${stake.valuationChange > 0 ? "+" : "−"}${formatTradingAmount(Math.abs(stake.valuationChange), "KRW")} · 사업보고서 기준`);
      }

      evidence.push(`오늘 뉴스가 ${stake.investeeName}를 언급했습니다`);

      // Size ranks the stakes a headline did name; it never promotes one it did
      // not. Scoring on book value alone put 하나금융지주, which nobody wrote
      // about, above a live 요금제 개편 headline purely for being large.
      const size = Math.min(1, stake.bookValue / 1_000_000_000_000);

      return {
        confidence: Math.round(55 + size * 30),
        evidence,
        kind: "고유",
        path: "보유 지분",
        title: `${stake.investeeName} 지분 가치`
      };
    });
}

/* ------------------------------------------------------------------ 뉴스 */

/**
 * Whose event is it.
 *
 * "엔비디아 실적 호조에 국내 반도체 동반 상승" is 엔비디아's earnings, and filing
 * it as 심텍's own reason is the mistake that made the caution text tell a
 * reader there was no 짝꿍 behind a move the whole theme was making. The test is
 * positional and deliberately crude: if another company is named before this
 * one, the sentence is about that company and this stock is downstream of it.
 */
function subjectOf(text, leaderName, otherNames, findAt) {
  const own = leaderName ? findAt(text, leaderName) : -1;

  for (const name of otherNames) {
    const at = findAt(text, name);

    if (at >= 0 && (own < 0 || at < own)) return name;
  }

  return undefined;
}

/** Korean has no word boundary, so a plain substring is the only test. */
function findKoreanAt(text, name) {
  return text.indexOf(name);
}

/**
 * English does have one, and it is doing real work: Gap, Block, Apple and
 * Target are companies and ordinary words at the same time. Matching is
 * case-sensitive for the same reason — "the gap between" is not Gap Inc.
 */
function findEnglishAt(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).exec(text);

  return match ? match.index : -1;
}

/**
 * The 13F churn, which is a genre rather than news.
 *
 * US feeds carry a steady stream of machine-written filings coverage — "One Day
 * In July LLC Acquires Shares of 1,647 Advanced Micro Devices", "Pinnacle
 * Associates Ltd. Sells 2,276 Shares of…" — one per manager per quarter per
 * holding. They name the stock, so they reach it, and `acquires` reads as
 * 인수·합병, which had a small registered adviser rebalancing filed as the
 * reason AMD rose 6.5%.
 *
 * Screened here rather than in the news layer on purpose: the headlines are
 * real and belong in the flow, they are simply never why anything moved.
 */
// Three shapes, because the template is written three ways and the first
// version of this caught only the active one:
//   active     "One Day In July LLC Acquires Shares of 1,647 …"
//   passive    "… $AMD Shares Sold by Oakwell Private Wealth Management"
//   possessive "Mitsubishi UFJ Trust Has $27.52 Million Position in Nebius"
const churnVerb = "acquires?|buys?|sells?|purchases?|boosts?|lowers?|trims?|raises?|reduces?|takes?|grows?|cuts?";
const churnObject = "shares?|stake|position|holdings?";
const institutionalChurnPattern = new RegExp([
  `\\b(?:${churnVerb})\\s+(?:a\\s+)?(?:new\\s+)?(?:[\\d,]+\\s+)?(?:${churnObject})\\s+(?:of|in)\\b`,
  `\\b(?:${churnObject})\\b[^.\\n]{0,40}\\b(?:sold|bought|purchased|acquired|reduced|raised|trimmed|boosted|lowered|cut|grown)\\s+by\\b`,
  `\\bhas\\s+\\$[\\d.,]+\\s*(?:million|billion|thousand)?\\s*(?:stock\\s+)?(?:${churnObject})\\s+in\\b`,
  "\\b13[FDG]\\b"
].join("|"), "i");

function stockNewsReasons(leader, headlines, otherNames, findAt) {
  return headlines
    .filter((headline) => (headline.relatedSymbols ?? []).includes(leader.symbol))
    .filter((headline) => !institutionalChurnPattern.test(`${headline.label ?? ""} ${headline.text ?? ""}`))
    .flatMap((headline) => {
      const catalyst = classifyHeadline(headline);

      if (!catalyst || catalyst.adverse) return [];

      const text = `${headline.label ?? ""} ${headline.text ?? ""}`;
      const subject = subjectOf(text, leader.name, otherNames, findAt);

      return [{
        confidence: subject ? 45 : 60,
        evidence: [headline.text ?? headline.label ?? ""],
        // An event that happened to somebody else is by definition shared with
        // everyone downstream of them, whatever the rule said in isolation.
        kind: subject ? "공유" : catalyst.kind,
        originalUrl: headline.originalUrl,
        path: subject ? "전방 수요" : "종목 뉴스",
        publishedAt: headline.publishedAt,
        title: subject ? `${subject} ${catalyst.label}` : catalyst.label
      }];
    });
}

/**
 * Headlines about the industry rather than about a company.
 *
 * These carry no symbol and so reached nobody. A story about 요금제 개편 is a
 * reason for every 통신서비스 name on the board, and the honest way to say that
 * is to attach it to the theme and score it lower than a headline that named
 * the stock — because it did not.
 */
function themeNewsReasons(leader, headlines) {
  const theme = leader.theme;

  if (!theme || theme === "개별 종목") return [];

  return headlines
    .filter((headline) => (headline.relatedSymbols ?? []).length === 0)
    // The story only. The pipeline's own label is a coarse bucket and matches
    // by substring — 조선·방산 contains 조선 — which turned a Reuters report on
    // Houthi missiles into a 조선 reason for 한화오션.
    .filter((headline) => `${headline.text ?? ""} ${headline.originalText ?? ""}`.includes(theme)
      || (headline.relatedThemes ?? []).includes(theme))
    .flatMap((headline) => {
      const catalyst = classifyHeadline(headline);

      if (!catalyst || catalyst.adverse || catalyst.kind === "고유") return [];

      return [{
        confidence: leader.peerCount > 0 ? 42 : 28,
        evidence: [
          headline.text ?? headline.label ?? "",
          leader.peerCount > 0
            ? `같은 테마 ${leader.peerCount}종목 동반 상승`
            : "종목명이 없는 기사라 테마 전체에 붙였습니다"
        ],
        kind: "공유",
        originalUrl: headline.originalUrl,
        path: "산업 뉴스",
        publishedAt: headline.publishedAt,
        title: `${theme} ${catalyst.label}`
      }];
    });
}

/* ------------------------------------------------------------------ 공시 */

/**
 * Filings that are supply arriving rather than a reason to have risen.
 *
 * A 424B5 is a shelf takedown and a 13D/G is somebody else's position; the
 * catalyst rules already treat 증자·메자닌 and 수급 부담 as adverse for exactly
 * this reason, and only rising stocks are ranked here. AMD's registration
 * statement was ranking first on a day it rose 6.5%, ahead of the news.
 */
const supplyFilingPattern = /^(?:증권|지분|자금조달)$/;

/**
 * Filings a company makes because the calendar says so.
 *
 * Asking DART about the leaders by name finally made the 공시 path fire, and
 * most of what came back was 반기보고서 — one per company, every company, the
 * same week. A periodic report is the strongest kind of evidence about a
 * business and no evidence at all about a day.
 */
const routineFilingPattern = /반기보고서|분기보고서|사업보고서|감사보고서|결산|지급수단별|소유상황보고서|기업지배구조|영업보고서|정정신고|주주총회소집|동일인등출자|상품ㆍ용역거래|계열회사와의/;

/**
 * Filings that are material and are the opposite of a reason to have risen.
 *
 * Only rising stocks are ranked here, so a derivative loss is not why one rose
 * — and SK하이닉스 took 파생상품거래손실발생 as its first reason on a day it
 * rose 4.65%, ahead of the 710억 달러 주주환원 headline that actually explains
 * it. The catalyst rules already draw this line for news; filings need it too.
 */
const adverseFilingPattern = /손실발생|손상차손|소송|제재|과징금|횡령|배임|거래정지|상장폐지|회생절차|부도|감사의견\s?거절|불성실공시|리콜/;

/**
 * A filing's own name, which says more than the bucket it was sorted into.
 * The domestic classifier answers 공시 for anything it does not recognise, and
 * "공시" is not a reason anyone can read.
 */
function disclosureTitle(disclosure) {
  const reportName = String(disclosure.title ?? "").split("·").pop()?.trim();

  if (disclosure.urgency && disclosure.urgency !== "공시") return disclosure.urgency;

  return reportName || "공시";
}

function disclosureReasons(leader, disclosures) {
  return disclosures
    .filter((disclosure) => disclosure.symbol === leader.symbol)
    .filter((disclosure) => !supplyFilingPattern.test(String(disclosure.urgency ?? "")))
    .filter((disclosure) => !routineFilingPattern.test(String(disclosure.title ?? "")))
    .filter((disclosure) => !adverseFilingPattern.test(String(disclosure.title ?? "")))
    .slice(0, 1)
    .map((disclosure) => ({
      // A filing is the company saying it itself, which is the strongest
      // evidence on the board — nothing here is inferred.
      confidence: 70,
      evidence: [disclosure.title, disclosure.action].filter(Boolean),
      kind: "고유",
      originalUrl: disclosure.originalUrl,
      path: "공시",
      publishedAt: disclosure.filedAt,
      title: disclosureTitle(disclosure)
    }));
}

/* ------------------------------------------------------------- 시장 국면 */

// Rising against a falling index is the whole signal, and a flat tape says
// nothing — a stock up 3% on a day the index is up 3% is not defensive demand,
// it is the market.
const indexFallThreshold = -0.3;

// Capped below anything read off a document, and deliberately. A regime reason
// is an observation about where money went, not a cause anyone can check, and
// scoring it on how far the stock beat the index made it circular: the bigger
// the move, the more certain the board became that the move explained itself.
// 심텍 up 9.1% took 지수 역행 강세 as its first reason over 엔비디아 실적, which
// is the board describing the move back to the reader.
const maximumRegimeConfidence = 38;

function toChangeRate(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);

  return match ? Number(match[0]) : undefined;
}

/**
 * Money choosing a kind of stock rather than a company.
 *
 * No headline has to exist for this one, which is the point: 방어주 선호 is
 * visible only in the relationship between one stock and the index, and the
 * board already has both numbers.
 */
function regimeReasons(leader, indexChange, indexLabel, displayName) {
  if (indexChange === undefined || indexChange > indexFallThreshold) return [];
  if (!(leader.changeRateValue > 0)) return [];
  // Rotation is a group arriving somewhere, so it needs a group. One stock up
  // against a falling index is that stock, and calling it 방어주 선호 would put
  // a story on every solo mover on a red day.
  if (leader.peerCount < 1) return [];

  const gap = leader.changeRateValue - indexChange;

  return [{
    confidence: Math.min(maximumRegimeConfidence, 20 + Math.round(gap * 2)),
    evidence: [
      // The trimmed name, because the registered one is not what anyone calls
      // the company: "Sandisk Corporation Common Stock +5.20%" is the ticker
      // file talking, not the board.
      `${indexLabel} ${indexChange.toFixed(2)}% · ${displayName} ${leader.changeRateValue > 0 ? "+" : ""}${leader.changeRateValue.toFixed(2)}%`,
      `지수 대비 ${gap.toFixed(2)}%p 앞섰고 같은 테마 ${leader.peerCount}종목이 함께 올랐습니다`
    ],
    kind: "공유",
    path: "시장 국면",
    title: "지수 역행 강세"
  }];
}

/* ------------------------------------------------------------------ 조립 */

/**
 * What a leader's reasons imply about its 짝꿍, which is what the reader acts
 * on. A reason belonging to one balance sheet has nobody behind it however many
 * peers happen to be green.
 */
function cautionFor(leader, reasons) {
  if (reasons.length === 0) return leader.caution;

  const [top] = reasons;

  // Written with a dash rather than 은/는, the same way the theme brief is.
  // The particle depends on whether the last syllable ends in a consonant, and
  // these titles end in company names that are not all Korean — "Anthropic
  // 지분 가치은" and "지수 역행 강세은" both came out of the version that
  // guessed one.
  if (top.kind === "고유") {
    return leader.pairTrade === "테마 주도"
      ? `${top.title} — 이 종목만의 재료입니다. 테마가 함께 올랐어도 같은 이유는 아닐 수 있으니 동반 종목의 재료를 따로 확인하세요.`
      : `${top.title} — 이 종목만의 재료라 따라 오를 종목이 없습니다. 원문으로 지속성을 확인하세요.`;
  }

  return leader.pairTrade === "테마 주도"
    ? `${top.title} — 같은 업종이 공유하는 재료입니다. 동반 종목의 반응 속도와 거래대금 유지를 확인하세요.`
    : `${top.title} — 업종이 공유할 재료인데 아직 함께 오른 종목이 없습니다. 뒤따르는 종목이 있는지 확인하세요.`;
}

/**
 * What each market brings to the engine.
 *
 * The two are not symmetric, and the asymmetry is measured rather than
 * accidental:
 *
 * 보유 지분 is domestic only. DART's 타법인 출자현황 gives a stake's percentage,
 * its book value and the year's revaluation, which is what makes Anthropic an
 * answer rather than a footnote. No free US filing carries that. 13F points the
 * other way entirely — it says Vanguard owns Nvidia, which explains nothing
 * about why Nvidia moved — and EX-21 lists subsidiary names with no figures at
 * all. A weaker imitation would read like the same evidence without being it.
 *
 * 산업 뉴스 is domestic only too. The fan-out has to recognise that a headline is
 * about a theme without naming a company, and reusing classifyTheme on the
 * sentence was the obvious way — it does not work. "Tesla recalls 400,000
 * vehicles over autopilot software" comes back AI·소프트웨어, because software
 * matched before vehicle, and a Reuters report on Houthi missiles in Yemen comes
 * back 방산. Those rules classify company names; a sentence trips several at once
 * and the first one wins. The Korean side matches the theme name literally,
 * which is exact, and no such name appears in an English headline.
 */
const marketProfiles = {
  KR: { findAt: findKoreanAt, indexId: "kospi-day-future", indexLabel: "KOSPI" },
  US: { findAt: findEnglishAt, indexId: "sp500-future", indexLabel: "S&P 500" }
};

/**
 * Attaches the ranked reasons behind each leader.
 *
 * Everything that reads the database is optional: a database that is down costs
 * the 지분 path and the subject dictionary, and leaves the rest standing.
 */
export async function attachLeaderReasons(config, leaders, { disclosures = [], headlines = [], macroSnapshot = [], market = "KR" } = {}) {
  if (leaders.length === 0) return leaders;

  const profile = marketProfiles[market] ?? marketProfiles.KR;
  const domestic = market === "KR";
  const businessYear = new Date().getFullYear() - 1;
  let stakes = new Map();
  let entityNames = [];

  try {
    [stakes, entityNames] = domestic
      ? await Promise.all([loadStakes(config, businessYear), loadEntityNames(config, businessYear)])
      : [new Map(), await loadUsEntityNames(config)];
  } catch (error) {
    console.warn(`${market} reason dictionaries unavailable`, error instanceof Error ? error.message : error);
  }

  const headlineText = headlines.map((headline) => `${headline.label ?? ""} ${headline.text ?? ""}`).join(" ");
  const indexChange = toChangeRate(macroSnapshot.find((item) => item.id === profile.indexId)?.changeRate);
  const leaderNames = leaders.map((leader) => domestic ? leader.name : normalizeUsName(leader.name)).filter(Boolean);
  const knownNames = [...new Set([...leaderNames, ...entityNames])]
    .filter((name) => name.length >= minimumEntityNameLength);
  // Headlines carry the region they came from, and a US leader has no business
  // being explained by a Korean market story.
  const ownHeadlines = headlines.filter((headline) => !headline.region || headline.region === market);

  return leaders.map((leader) => {
    // A subsidiary named after its parent is not a different subject: 글로벌심텍
    // in a 심텍 headline is 심텍, and Micron Technology in a Micron headline is
    // Micron. Excluded both ways, since either can be the longer string.
    const ownName = domestic ? leader.name : normalizeUsName(leader.name);
    const otherNames = knownNames.filter((name) =>
      !ownName?.includes(name) && !name.includes(ownName ?? " "));
    const reasons = [
      ...(domestic ? ownershipReasons(leader, stakes, headlineText) : []),
      ...stockNewsReasons(leader, ownHeadlines, otherNames, profile.findAt),
      ...(domestic ? themeNewsReasons(leader, ownHeadlines) : []),
      ...disclosureReasons(leader, disclosures),
      ...regimeReasons(leader, indexChange, profile.indexLabel, ownName || leader.name)
    ]
      .filter((reason) => reason.confidence >= minimumConfidence)
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, maximumReasons)
      .map((reason, index) => ({ ...reason, id: `reason-${leader.symbol}-${index}` }));

    return { ...leader, caution: cautionFor(leader, reasons), reasons };
  });
}
