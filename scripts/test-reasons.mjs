import { readConfig } from "../src/config.mjs";
import { attachLeaderReasons } from "../src/providers/reasons.mjs";

/**
 * The reason engine against the cases it was built for.
 *
 * Every leader here is a real one and every headline is written the way the
 * feeds carry it. The point of the fixture is the paths: a reason arriving
 * through the ownership graph, through a headline about somebody else, through
 * an industry story that named nobody, and through the index alone. Each of
 * those was 이유 미확인 before, and a regression here means one path went quiet.
 *
 * Reads the real 지분 그래프, so it needs the database and a completed
 * `npm run kr:ownership`. Without them the ownership assertions fail loudly
 * rather than passing on an empty graph.
 */

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;

  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);

  if (!ok && detail !== undefined) console.log(`          ${detail}`);
}

function leader(symbol, name, theme, changeRateValue, peerCount = 0) {
  return {
    caution: "-",
    changeRateValue,
    market: "KR",
    name,
    pairTrade: peerCount > 0 ? "테마 주도" : "단독 주도",
    peerCount,
    symbol,
    theme
  };
}

function headline(text, relatedSymbols = []) {
  return {
    id: text,
    label: "",
    originalUrl: "https://example.test",
    publishedAt: "2026-08-16T00:00:00.000Z",
    relatedSymbols,
    text
  };
}

const config = readConfig();
const leaders = [
  leader("017670", "SK텔레콤", "통신서비스", 6.2, 1),
  leader("222800", "심텍", "패키지기판·PCB", 9.1, 3),
  leader("112040", "위메이드", "게임·엔터", 12.4)
];
const headlines = [
  headline("Anthropic 기업가치 재평가, 투자자 주목"),
  headline("정부, 이동통신 요금제 개편안 발표… 통신서비스 전반 영향"),
  headline("엔비디아 실적 호조에 국내 패키지기판·PCB 동반 상승", ["222800"]),
  headline("위메이드, 텐센트에 지분 100% 매각 추진", ["112040"])
];
const macroSnapshot = [{ changeRate: "-1.40%", id: "kospi-day-future", value: "2,540.11" }];

const results = await attachLeaderReasons(config, leaders, { headlines, macroSnapshot });
const bySymbol = new Map(results.map((result) => [result.symbol, result]));
const reasonsOf = (symbol) => bySymbol.get(symbol)?.reasons ?? [];
const pathsOf = (symbol) => reasonsOf(symbol).map((reason) => reason.path);
const titlesOf = (symbol) => reasonsOf(symbol).map((reason) => reason.title);

console.log("보유 지분 — the path nothing else can reach");
// Anthropic is not listed, has no price and no theme. Only the graph connects it.
check(
  "SK텔레콤 carries its 앤트로픽 stake",
  titlesOf("017670").some((title) => title.includes("Anthropic")),
  `got ${JSON.stringify(titlesOf("017670"))}`
);
check(
  "and it ranks first, because today's news named Anthropic",
  reasonsOf("017670")[0]?.path === "보유 지분",
  `got ${JSON.stringify(pathsOf("017670"))}`
);
check(
  "with the figures behind it",
  (reasonsOf("017670")[0]?.evidence ?? []).some((line) => line.includes("장부가")),
  `got ${JSON.stringify(reasonsOf("017670")[0]?.evidence)}`
);

console.log("\n산업 뉴스 — a headline that named no company at all");
check(
  "요금제 개편 reaches SK텔레콤 through its theme",
  pathsOf("017670").includes("산업 뉴스"),
  `got ${JSON.stringify(pathsOf("017670"))}`
);

console.log("\n전방 수요 — whose event is it");
// The old rules filed this as 심텍's own 실적, which then told the reader there
// was no 짝꿍 behind a move the whole theme was making.
check(
  "엔비디아 실적 is 심텍's reason by way of 엔비디아, not as 심텍's own",
  reasonsOf("222800").some((reason) => reason.path === "전방 수요" && reason.kind === "공유"),
  `got ${JSON.stringify(reasonsOf("222800").map((reason) => `${reason.path}/${reason.kind}/${reason.title}`))}`
);

console.log("\n종목 뉴스 — the sale that used to be filed as an overhang");
check(
  "위메이드 carries the 텐센트 stake sale",
  titlesOf("112040").some((title) => title.includes("지분 매각")),
  `got ${JSON.stringify(titlesOf("112040"))}`
);

console.log("\n시장 국면 — no headline exists for this one");
check(
  "rising against a falling index is its own reason",
  pathsOf("017670").concat(pathsOf("222800")).includes("시장 국면") || reasonsOf("017670").length >= 3,
  `got ${JSON.stringify(pathsOf("017670"))} / ${JSON.stringify(pathsOf("222800"))}`
);

console.log("\nrestraint");
check("at most three reasons per leader", results.every((result) => (result.reasons ?? []).length <= 3));
check(
  "reasons are ordered by evidence",
  results.every((result) => (result.reasons ?? []).every((reason, index, list) =>
    index === 0 || list[index - 1].confidence >= reason.confidence))
);

const quiet = await attachLeaderReasons(config, [leader("000000", "조용한회사", "개별 종목", 3.1)], {
  headlines: [],
  macroSnapshot: []
});

check("a stock with no evidence gets no invented reason", (quiet[0].reasons ?? []).length === 0);

console.log("\n미국 — the same engine, two generators short");

function usLeader(symbol, name, theme, changeRateValue, peerCount = 0) {
  return { ...leader(symbol, name, theme, changeRateValue, peerCount), market: "US" };
}

function usHeadline(text, relatedSymbols = []) {
  return { ...headline(text, relatedSymbols), region: "US" };
}

const us = await attachLeaderReasons(
  config,
  [
    usLeader("MU", "Micron Technology, Inc.", "반도체", 7.4, 3),
    usLeader("SNDK", "Sandisk Corporation Common Stock", "반도체", 5.2, 3),
    usLeader("TSLA", "Tesla, Inc. Common Stock", "자동차·전장", 0.7)
  ],
  {
    headlines: [
      usHeadline("Nvidia earnings beat lifts memory names as HBM demand accelerates", ["MU"]),
      usHeadline("Sandisk announces $2B share repurchase program", ["SNDK"]),
      usHeadline("Tesla recalls 400,000 vehicles over autopilot software", ["TSLA"])
    ],
    macroSnapshot: [{ changeRate: "-0.90%", id: "sp500-future", value: "6,100" }],
    market: "US"
  }
);
const usBySymbol = new Map(us.map((result) => [result.symbol, result]));
const usReasons = (symbol) => usBySymbol.get(symbol)?.reasons ?? [];

// The subject dictionary is the top 400 US names by dollar volume, so this also
// checks that the query behind it still returns something.
check(
  "Nvidia's earnings are Micron's reason by way of Nvidia",
  usReasons("MU").some((reason) => reason.path === "전방 수요" && reason.kind === "공유" && reason.title.includes("Nvidia")),
  `got ${JSON.stringify(usReasons("MU").map((reason) => `${reason.path}/${reason.title}`))}`
);
check(
  "a buyback is the company's own",
  usReasons("SNDK").some((reason) => reason.path === "종목 뉴스" && reason.kind === "고유"),
  `got ${JSON.stringify(usReasons("SNDK").map((reason) => `${reason.path}/${reason.title}`))}`
);
// A recall is adverse, and only rising stocks are ranked — it is not why one rose.
check("a recall is not a reason to have risen", usReasons("TSLA").length === 0, `got ${JSON.stringify(usReasons("TSLA"))}`);
check(
  "the index is the S&P, not the KOSPI",
  usReasons("MU").some((reason) => (reason.evidence ?? []).some((line) => line.includes("S&P 500"))),
  `got ${JSON.stringify(usReasons("MU").flatMap((reason) => reason.evidence))}`
);
// The registered name is not what anyone calls the company.
check(
  "the trimmed name is what shows",
  usReasons("SNDK").some((reason) => (reason.evidence ?? []).some((line) => line.includes("Sandisk +") && !line.includes("Common Stock"))),
  `got ${JSON.stringify(usReasons("SNDK").flatMap((reason) => reason.evidence))}`
);
// The 13F churn is a genre, not news: one machine-written article per manager
// per quarter per holding, and `acquires` reads as 인수·합병. A small registered
// adviser rebalancing was filed as the reason AMD rose 6.5%.
const churn = await attachLeaderReasons(
  config,
  [usLeader("AMD", "Advanced Micro Devices, Inc.", "반도체", 6.5)],
  {
    // A 424B5 is a shelf takedown — supply arriving, not a reason to have risen.
    disclosures: [{ action: "원문 Item 확인", filedAt: "2026-08-16T00:00:00Z", originalUrl: "https://x", symbol: "AMD", title: "AMD · 증권 발행", urgency: "증권" }],
    // All seven shapes the template was seen in on one day's board. The first
    // version of this filter knew only the active voice and let four through.
    headlines: [
      usHeadline("One Day In July LLC Acquires Shares of 1,647 Advanced Micro Devices, Inc. $AMD", ["AMD"]),
      usHeadline("Pinnacle Associates Ltd. Sells 2,276 Shares of Advanced Micro Devices, Inc. $AMD", ["AMD"]),
      usHeadline("Advanced Micro Devices, Inc. $AMD Shares Sold by Oakwell Private Wealth Management LLC", ["AMD"]),
      usHeadline("Advanced Micro Devices, Inc. $AMD Shares Bought by TCW Group Inc.", ["AMD"]),
      usHeadline("25,592 Shares in Advanced Micro Devices, Inc. $AMD Bought by Meridian Wealth Management LLC", ["AMD"]),
      usHeadline("Advanced Micro Devices, Inc. $AMD Stock Position Reduced by Janney Montgomery Scott LLC", ["AMD"]),
      usHeadline("Trust Asset Management LLC Has $53.58 Million Stock Holdings in Advanced Micro Devices, Inc.", ["AMD"])
    ],
    macroSnapshot: [],
    market: "US"
  }
);

check("a 13F rebalance is not why a stock rose", (churn[0].reasons ?? []).length === 0, `got ${JSON.stringify((churn[0].reasons ?? []).map((reason) => reason.title))}`);

// The other half of the same reading: what the churn filter must not swallow.
// US headlines write a quarter as Q2, which a rule that only knew the word
// earnings never matched — "Nebius Group Shares Surge After Q2 Beat" went
// unexplained on a day the stock rose 8.9%.
const quarterly = await attachLeaderReasons(
  config,
  [usLeader("NBIS", "Nebius Group N.V.", "AI·소프트웨어", 8.9)],
  {
    headlines: [usHeadline("Nebius Group (NBIS) Shares Surge After Q2 Beat; Price-to-Sales Valuation", ["NBIS"])],
    macroSnapshot: [],
    market: "US"
  }
);

check(
  "a Q2 beat is an earnings reason",
  (quarterly[0].reasons ?? []).some((reason) => reason.title === "실적"),
  `got ${JSON.stringify((quarterly[0].reasons ?? []).map((reason) => reason.title))}`
);

// 보유 지분 and 산업 뉴스 are domestic only, both for reasons written down in
// reasons.mjs. A US leader picking one up means that decision was undone.
check(
  "no US reason comes through a domestic-only path",
  us.every((result) => (result.reasons ?? []).every((reason) => reason.path !== "보유 지분" && reason.path !== "산업 뉴스"))
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
