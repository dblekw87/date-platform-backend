/**
 * Theme classification for leading stocks.
 *
 * A theme is a sector story a trader can act on — 반도체, 조선, 원전 — not a
 * description of the ranking that surfaced the stock. Turnover is what decides
 * which theme leads the day, so scores aggregate trading value per theme.
 */

import { formatTradingAmount } from "./format.mjs";

const symbolThemes = {
  // 반도체 / 소부장
  "000660": "반도체",
  "005930": "반도체",
  "000990": "반도체",
  "042700": "반도체",
  "058470": "반도체",
  "036930": "반도체",
  "240810": "반도체",
  "403870": "반도체",
  "095340": "반도체",
  "357780": "반도체",
  "140860": "반도체",
  "036810": "반도체",
  "080580": "반도체",

  // 전자부품
  "009150": "MLCC·전자부품",
  "001820": "MLCC·전자부품",
  "011070": "전자부품·전장",

  // 2차전지
  "373220": "2차전지",
  "006400": "2차전지",
  "003670": "2차전지",
  "247540": "2차전지",
  "086520": "2차전지",
  "066970": "2차전지",

  // 조선
  "009540": "조선",
  "010140": "조선",
  "042660": "조선",
  "010620": "조선",
  "077970": "조선",

  // 방산
  "012450": "방산",
  "047810": "방산",
  "079550": "방산",
  "064350": "방산",
  "272210": "방산",

  // 원전 / 전력
  "034020": "원전",
  "298040": "전력기기",
  "103590": "전력기기",
  "007070": "전력기기",

  // 바이오
  "207940": "바이오",
  "068270": "바이오",
  "302440": "바이오",
  "950160": "바이오",

  // 자동차
  "005380": "자동차·전장",
  "000270": "자동차·전장",
  "012330": "자동차·전장",
  "307950": "자동차·전장",
  "204320": "자동차·전장",
  "125490": "자동차·전장",
  "007340": "자동차·전장",
  "000430": "자동차·전장",

  // 가전·전자
  "066570": "전자부품·전장",
  "011070": "전자부품·전장",

  // 플랫폼 / 콘텐츠
  "035420": "플랫폼 AI",
  "035720": "플랫폼 AI",
  "402340": "플랫폼 AI",
  "108860": "AI·소프트웨어",
  "352820": "게임·엔터",
  "036570": "게임·엔터",

  // 소재 / 화학 / 철강
  "051910": "화학·에너지",
  "010060": "화학·에너지",
  "005490": "원자재",
  "004020": "원자재",

  // 금융 / 통신
  "105560": "금리 수혜",
  "055550": "금리 수혜",
  "086790": "금리 수혜",
  "017670": "통신장비",
  "030200": "통신장비",

  // 로봇 / 물류자동화
  "319400": "로봇",
  "056080": "로봇",
  "108490": "로봇",
  "058610": "로봇",
  "090360": "로봇",
  "117730": "로봇",

  // 재생에너지 / 전기설비
  "475150": "재생에너지",
  "001210": "전력기기",

  // 지주
  "078930": "지주",
  "034730": "지주",
  "003550": "지주",

  // 기타 개별 테마
  "011330": "비건가죽",
  "336260": "수소·연료전지",
  "000155": "지주·리밸런싱",
  "005935": "반도체",

  // US
  AMD: "반도체",
  AVGO: "반도체",
  AXTI: "반도체",
  INTC: "반도체",
  MU: "반도체",
  NVDA: "반도체",
  SKHY: "반도체",
  SNDK: "반도체",
  TSM: "반도체",
  WDC: "반도체",
  AMAT: "반도체",
  LRCX: "반도체",
  KLAC: "반도체",
  ARM: "반도체",
  COHR: "광통신·네트워크",
  MRVL: "광통신·네트워크",
  ANET: "광통신·네트워크",
  APP: "AI·소프트웨어",
  APPS: "AI·소프트웨어",
  MSFT: "AI·소프트웨어",
  NBIS: "AI·소프트웨어",
  ORCL: "AI·소프트웨어",
  CRWV: "AI·소프트웨어",
  WDAY: "AI·소프트웨어",
  HUBS: "AI·소프트웨어",
  CRM: "AI·소프트웨어",
  NOW: "AI·소프트웨어",
  SNOW: "AI·소프트웨어",
  DDOG: "AI·소프트웨어",
  WIX: "플랫폼 AI",
  SHOP: "AI 커머스",
  UNH: "바이오",
  AVAH: "바이오",
  LLY: "바이오",
  ARX: "금리 수혜",
  SOFI: "핀테크 결제",
  NOK: "통신장비",
  ERIC: "통신장비",
  SMCI: "AI·소프트웨어",
  DELL: "AI·소프트웨어",
  ONDS: "항공우주",
  PATH: "로봇",
  GOOG: "AI 검색",
  GOOGL: "AI 검색",
  META: "AI 검색",
  AMZN: "AI 커머스",
  PLTR: "AI·방산",
  LMT: "방산",
  RTX: "방산",
  NOC: "방산",
  TSLA: "자동차·전장",
  RIVN: "자동차·전장",
  GEV: "전력기기",
  VST: "전력기기",
  CEG: "원전",
  OKLO: "원전",
  SMR: "원전",
  LEU: "원전",
  BE: "수소·연료전지",
  PLUG: "수소·연료전지",
  FSLR: "재생에너지",
  ENPH: "재생에너지",
  RKLB: "항공우주",
  SPCX: "민간 우주",
  ASTS: "항공우주",
  SURG: "핀테크 결제",
  COIN: "핀테크 결제",
  HOOD: "핀테크 결제",
  PAVS: "AI 게임",
  AZI: "자동차 애프터마켓"
};

const etfPattern = /(^|\s)(KODEX|TIGER|ACE|RISE|SOL|PLUS|HANARO|KOSEF|KBSTAR|ARIRANG|TIMEFOLIO|히어로즈|마이티|HK)|ETF|ETN|인버스|레버리지|채권|회사채|국고채|액티브|Nifty|TOP10|리츠|REIT/i;
// Preferred shares are the same company as their common stock, so they double
// up a theme with a name that is not a separate leader. Korean tickers mark
// them with a trailing 우 (현대차2우B, 삼성전자우), which the lookbehind keeps
// from catching real names ending in 대우.
const nonOperatingPattern = /스팩|SPAC|우선주|(?<!대)\d?우[BC]?$/i;

// Ordered: the first rule that matches wins, so narrower themes come first.
const themeRules = [
  [/조선|중공업|해양|shipbuild|shipyard/i, "조선"],
  [/방산|함정|미사일|무기|항공우주산업|defen[cs]e|missile|weapon/i, "방산"],
  [/반도체|메모리|비메모리|파운드리|hbm|ddr|dram|nand|wafer|웨이퍼|패키징|후공정|소부장|semiconductor|\bchips?\b/i, "반도체"],
  [/2차전지|이차전지|배터리|전해액|양극재|음극재|분리막|리튬|니켈|battery|lithium|cathode|anode/i, "2차전지"],
  [/수소|연료전지|hydrogen|fuel cell/i, "수소·연료전지"],
  [/신재생|재생에너지|태양광|풍력|해상풍력|renewable|solar|wind/i, "재생에너지"],
  [/원전|원자력|nuclear|uranium|우라늄|smr/i, "원전"],
  [/전력기기|전력|변압기|송전|배전|전선|초고압|전기설비|grid|transformer|power equipment|utility/i, "전력기기"],
  [/바이오|제약|신약|임상|항암|진단|의료기기|헬스케어|bio|biotech|pharma|medical|diagnostics|therapeutics|health|healthcare|hospital|fda/i, "바이오"],
  [/ai defense|defense ai|military ai|국방 ai|방산 ai/i, "AI·방산"],
  [/mlcc|적층세라믹|콘덴서|커패시터|capacitor|ceramic capacitor/i, "MLCC·전자부품"],
  [/광통신|광모듈|광부품|광네트워크|optical|photonics|coherent|networking|data infrastructure/i, "광통신·네트워크"],
  [/ai|인공지능|소프트웨어|클라우드|데이터센터|보안|cyber|software|cloud|data center|saas/i, "AI·소프트웨어"],
  [/로봇|자동화|robot|automation/i, "로봇"],
  [/항공우주|우주|위성|로켓|발사체|space|aerospace|satellite|rocket|launch/i, "항공우주"],
  [/카메라모듈|기판|패키지기판|광학솔루션|전자부품|전장부품|camera module|substrate|electronics component/i, "전자부품·전장"],
  [/자동차|전기차|자율주행|전장|타이어|vehicle|ev\b|autonomous|mobility|auto parts/i, "자동차·전장"],
  [/통신|5g|6g|네트워크|rf|telecom|network|wireless/i, "통신장비"],
  [/검색|포털|portal|search/i, "AI 검색"],
  [/커머스|commerce|shopping/i, "AI 커머스"],
  [/인터넷|플랫폼|platform/i, "플랫폼 AI"],
  [/게임|엔터|음원|콘텐츠|미디어|드라마|웹툰|웹소설|game|gaming|entertainment|media|content/i, "게임·엔터"],
  [/결제|핀테크|payment|fintech|crypto|bitcoin/i, "핀테크 결제"],
  [/화장품|미용|의류|패션|소비재|식품|cosmetic|beauty|fashion|consumer|food/i, "소비재"],
  [/은행|보험|증권|금융|brokerage|bank|insurance|financial/i, "금리 수혜"],
  [/건설|건자재|시멘트|인프라|철도|construction|cement|infrastructure/i, "인프라 투자"],
  [/철강|비철|구리|알루미늄|소재|steel|copper|aluminum|materials/i, "원자재"],
  [/화학|정유|석유|가스|lng|lpg|chemical|oil|crude|gas|refining/i, "화학·에너지"],
  [/해운|항공|물류|운송|shipping|airline|logistics|transport/i, "운임 반등"]
];

export function isEtfLike(name) {
  return etfPattern.test(String(name ?? ""));
}

export function isNonOperatingEquity(name) {
  return nonOperatingPattern.test(String(name ?? ""));
}

/** Returns a sector theme, or "미분류" when nothing matches. */
export function classifyTheme(symbol, name) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedName = String(name ?? "").trim();

  if (isEtfLike(normalizedName)) return "ETF";

  const mapped = symbolThemes[normalizedSymbol];

  if (mapped) return mapped;

  const text = `${normalizedSymbol} ${normalizedName}`;
  const rule = themeRules.find(([pattern]) => pattern.test(text));

  return rule ? rule[1] : "미분류";
}

// A theme needs real money behind it before its move counts as leadership.
const minimumThemeTurnover = 50_000_000_000;

/**
 * Ranks themes by strength, not size.
 *
 * Sorting on turnover alone just re-lists the largest caps: 반도체 wins every
 * session because SK하이닉스 and 삼성전자 dominate turnover whether or not the
 * sector is actually moving. Ranking on turnover-weighted change rate answers
 * the question the board is asking — where is money pushing prices today —
 * while the turnover floor keeps a thin micro-cap from topping the list on a
 * single spike.
 */
export function themeScores(leaders, limit = 4) {
  const byTheme = new Map();

  leaders.forEach((leader) => {
    const theme = leader.theme ?? classifyTheme(leader.symbol, leader.name);

    if (theme === "ETF" || theme === "미분류") return;

    const turnover = Number(leader.turnoverValue);
    const changeRate = Number(leader.changeRateValue);

    if (!Number.isFinite(turnover) || turnover <= 0) return;
    if (!Number.isFinite(changeRate)) return;

    const score = byTheme.get(theme) ?? { count: 0, leaders: [], theme, turnover: 0, weightedChange: 0 };

    score.turnover += turnover;
    score.weightedChange += turnover * changeRate;
    score.count += 1;
    if (score.leaders.length < 3) score.leaders.push(leader.name);
    byTheme.set(theme, score);
  });

  return [...byTheme.values()]
    .map((score) => ({ ...score, changeRate: score.weightedChange / score.turnover }))
    .filter((score) => score.turnover >= minimumThemeTurnover && score.changeRate > 0)
    .sort((left, right) => right.changeRate - left.changeRate)
    .slice(0, limit);
}

export function buildThemeBrief(id, region, leaders, currency, checkedAt) {
  const scores = themeScores(leaders, currency === "USD" ? 3 : 4);

  if (scores.length === 0) return null;

  return {
    id,
    region,
    // Phrased so no subject particle is needed: 이/가 depends on whether the
    // theme name ends in a consonant, and these names are not all Korean.
    title: `오늘 가장 강한 테마는 ${scores[0].theme}입니다.`,
    points: [
      ...scores.map((score) =>
        `${score.theme}: ${score.changeRate > 0 ? "+" : ""}${score.changeRate.toFixed(2)}% · 거래대금 ${formatTradingAmount(score.turnover, currency)} · ${score.count}종목 · ${score.leaders.join(", ")}`),
      "거래대금 가중 평균 등락률 순입니다. 테마는 DATE 룰 기반 분류이며 세부 원인은 뉴스·공시 확인이 필요합니다."
    ],
    source: "market",
    timestamp: checkedAt
  };
}
