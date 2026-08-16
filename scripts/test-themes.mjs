import { themeForIndustryCode } from "../src/providers/industry.mjs";
import { classifyTheme, isEtfLike, isNonOperatingEquity, themeScores } from "../src/providers/themes.mjs";

/**
 * Theme classification is three layers deep — a curated symbol map, name rules,
 * and the registered industry underneath — and a stock lands in the wrong bucket
 * quietly. Nothing throws, the board just files a camera lens maker under 바이오
 * and the only way anyone finds out is by recognising the company on screen.
 *
 * These cases are the ones that were wrong at some point. A regression here
 * means a rule change reached further than intended.
 */

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;

  if (!ok) failures += 1;

  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);

  if (!ok) console.log(`          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTheme(symbol, name, expected) {
  check(`${name} → ${expected}`, classifyTheme(symbol, name), expected);
}

function checkIndustry(code, expected, note) {
  check(`${code} ${note} → ${expected}`, themeForIndustryCode(code), expected);
}

console.log("curated symbols");
checkTheme("005930", "삼성전자", "반도체");
checkTheme("000660", "SK하이닉스", "반도체");
checkTheme("005380", "현대차", "자동차·전장");
checkTheme("042660", "한화오션", "조선");
checkTheme("012450", "한화에어로스페이스", "방산");
// Carriers are not the companies that sell them antennas.
checkTheme("017670", "SK텔레콤", "통신서비스");
checkTheme("030200", "KT", "통신서비스");
// Substrate makers are their own group. They sat in 전자부품·전장 next to the
// camera modules, which offered 심텍 as a 짝꿍 for LG이노텍 — two businesses that
// do not move on the same news.
checkTheme("222800", "심텍", "패키지기판·PCB");
checkTheme("007810", "코리아써키트", "패키지기판·PCB");
checkTheme("007660", "이수페타시스", "패키지기판·PCB");
checkTheme("090460", "비에이치", "패키지기판·PCB");
// Registered as chemicals and machinery, overridden because plating chemistry
// and substrate inspection lines are priced off substrate orders.
checkTheme("251370", "와이엠티", "패키지기판·PCB");
checkTheme("420770", "기가비스", "패키지기판·PCB");
checkTheme("011070", "LG이노텍", "전자부품·전장");

console.log("\nname rules");
checkTheme("999001", "가상로봇", "로봇");
// 로보틱스 and 로보티즈 are how most robot makers are actually named, and a rule
// matching only 로봇 left 두산로보틱스 unclassified.
checkTheme("454910", "두산로보틱스", "로봇");
checkTheme("999002", "레인보우로보틱스", "로봇");
checkTheme("999003", "로보티즈", "로봇");
checkTheme("999004", "이름없는회사", "미분류");
// A company named for a board is a board maker, so 기판 leads to the substrate
// theme rather than to the electronics-components catch-all it used to.
checkTheme("999005", "코스텍기판", "패키지기판·PCB");
checkTheme("999006", "한성전자부품", "전자부품·전장");

console.log("\nkeywords caught inside longer words");
// Korean has no word boundary, so every one of these matched a real keyword
// sitting inside a name that means something else. Found by running the rules
// over all 3,927 registrations and grouping by the keyword that matched.
checkTheme("999010", "나무기술", "미분류");           // 나(무기)술 — a cloud company
checkTheme("999011", "대원전선", "전력기기");          // 대(원전)선 — cable
checkTheme("999012", "보해양조", "미분류");           // 보(해양)조 — a distillery
checkTheme("999013", "삼양패키징", "미분류");          // bottles, not chips
checkTheme("999014", "패션플랫폼", "소비재");          // clothes
checkTheme("999015", "메가스터디", "미분류");          // 메(가스)터디 — a cram school
checkTheme("999016", "조선선재", "미분류");           // welding rod
checkTheme("999017", "디지틀조선", "미분류");          // a newspaper
checkTheme("999018", "우주일렉트로", "미분류");         // connectors
// The same keywords still have to work where they mean what they say.
checkTheme("999019", "대한조선", "조선");
checkTheme("999020", "SK가스", "화학·에너지");
checkTheme("999021", "심플랫폼", "플랫폼 AI");
// Parts makers were filed with the airlines by the 항공 rule at the bottom.
checkTheme("999022", "케이피항공산업", "항공우주");
checkTheme("999023", "제주항공", "운임 반등");

console.log("\nshells carry no theme");
// The leader ranking screened these, but the 짝꿍 pool is built from
// classifyTheme over every registration and screened only on ETF and 미분류,
// so every blank-cheque company in the market arrived as a candidate — most of
// them registered as 기업인수목적 without 스팩 anywhere in the traded name.
checkTheme("999030", "하나금융14호기업인수목적", "미분류");
checkTheme("999031", "대우증권그린코리아기업인수목적회사", "미분류");
checkTheme("999032", "한국투자ANKOR유전해외자원개발특별자산투자회사1호", "미분류");
check("기업인수목적 is non-operating", isNonOperatingEquity("하나금융14호기업인수목적"), true);

console.log("\nregistered industry, split where a KSIC division mixes trades");
// Division 27 is 의료·정밀·광학기기 및 시계 — four unrelated businesses under one
// prefix. Mapping the division put 재영솔루텍, a camera optics maker, in 바이오.
checkIndustry("27309", "광학·카메라", "사진장비·광학기기");
checkIndustry("27101", "의료기기", "의료용 기기");
checkIndustry("27212", "정밀기기", "측정·시험기기");
checkIndustry("21102", "바이오", "의약품");
// Supplying electricity is not manufacturing the equipment.
checkIndustry("35111", "전력·유틸리티", "발전업");
checkIndustry("28112", "전력기기", "전동기·발전기");
// 61 is the carriers; 72 is construction engineering, not software.
checkIndustry("61220", "통신서비스", "무선통신업");
checkIndustry("72111", "인프라 투자", "건축설계·엔지니어링");
checkIndustry("62010", "AI·소프트웨어", "소프트웨어 개발");
// 운임 반등 is a shipping-rate theme and describes neither trucking nor airlines.
checkIndustry("50121", "운임 반등", "외항 화물운송");
checkIndustry("49231", "물류·운송", "화물자동차 운송");
checkIndustry("51100", "항공운송", "항공 여객운송");
checkIndustry("26410", "통신장비", "통신장비 제조");
// 2622 is split out of 262 the same way 27 was split: the division mixes
// display panels and connectors in with the board makers.
checkIndustry("26221", "패키지기판·PCB", "인쇄회로기판 제조");
checkIndustry("26211", "전자부품·전장", "전자표시장치 제조");
checkIndustry("31111", "조선", "선박 건조");
check("unknown code → undefined", themeForIndustryCode("99999"), undefined);
check("empty code → undefined", themeForIndustryCode(""), undefined);

console.log("\nnon-operating equities are excluded");
check("삼성전자우 is a preferred share", isNonOperatingEquity("삼성전자우"), true);
check("CJ씨푸드1우 is a preferred share", isNonOperatingEquity("CJ씨푸드1우"), true);
check("소프트센우 is a preferred share", isNonOperatingEquity("소프트센우"), true);
check("교보14호스팩 is a SPAC", isNonOperatingEquity("교보14호스팩"), true);
// The one that keeps breaking: 대우 ends in 우 without being a preferred share.
check("미래에셋대우 is an operating company", isNonOperatingEquity("미래에셋대우"), false);
check("삼성전자 is an operating company", isNonOperatingEquity("삼성전자"), false);
check("KODEX 200 is an ETF", isEtfLike("KODEX 200"), true);
check("TIGER 미국S&P500 is an ETF", isEtfLike("TIGER 미국S&P500"), true);
check("삼성전자 is not an ETF", isEtfLike("삼성전자"), false);

console.log("\ntheme ranking");

function leader(name, theme, changeRateValue, turnoverValue) {
  return { symbol: name, name, theme, changeRateValue, turnoverValue };
}

// A mega cap up 2% against five mid caps up 20%. Turnover weighting gave the
// score to whichever member traded most, so 반도체 topped the list on a day it
// barely moved.
const mixed = themeScores([
  leader("삼성전자", "반도체", 2, 5_000_000_000_000),
  leader("SK하이닉스", "반도체", 2, 7_000_000_000_000),
  leader("로봇A", "로봇", 20, 10_000_000_000),
  leader("로봇B", "로봇", 20, 10_000_000_000)
]);

check("the group that moved ranks first", mixed[0]?.theme, "로봇");
check("every member counts the same", Math.round(mixed[0]?.changeRate), 20);
check("the mega caps still appear", mixed[1]?.theme, "반도체");

// One name under a sector heading is a 주도주, which has its own list.
const single = themeScores([
  leader("혼자", "바이오", 25, 900_000_000_000),
  leader("둘A", "조선", 5, 100_000_000_000),
  leader("둘B", "조선", 5, 100_000_000_000)
]);

check("a one-stock theme is dropped", single.some((score) => score.theme === "바이오"), false);
check("a two-stock theme is kept", single[0]?.theme, "조선");

// Below the per-stock floor a name is a quote rather than a participant.
const illiquid = themeScores([
  leader("잡주A", "테마X", 29, 500_000_000),
  leader("잡주B", "테마X", 29, 500_000_000),
  leader("실체A", "조선", 4, 100_000_000_000),
  leader("실체B", "조선", 4, 100_000_000_000)
]);

check("illiquid names cannot form a theme", illiquid.some((score) => score.theme === "테마X"), false);

check("falling groups are excluded", themeScores([
  leader("하락A", "조선", -5, 100_000_000_000),
  leader("하락B", "조선", -5, 100_000_000_000)
]).length, 0);

check("ETF and 미분류 never form a theme", themeScores([
  leader("KODEX 200", "ETF", 5, 900_000_000_000),
  leader("KODEX 인버스", "ETF", 5, 900_000_000_000),
  leader("모름A", "미분류", 9, 900_000_000_000),
  leader("모름B", "미분류", 9, 900_000_000_000)
]).length, 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
