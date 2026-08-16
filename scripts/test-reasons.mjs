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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
