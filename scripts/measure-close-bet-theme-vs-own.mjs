import { classifyDisclosure, isMachineHeadline, isReasonHeadline, mentionsBadNews } from "../src/providers/overnight-classify.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 종가배팅: 그날 테마 묶음의 대장을 사는 것과 회사 고유 재료를 사는 것이 다른가.
 *
 *   node scripts/measure-close-bet-theme-vs-own.mjs [--from 2026-08-18] [--split 2026-10-20]
 *
 * 2026-11-11 사용자: "지금 종가배팅이 잘 안 먹힌다, 테마주 장세라서". 10/29 이후 사용자
 * 종가배팅 6연속 손실(한화비전·라온로보틱스·파수AI·한화솔루션·덕성우·대한항공)이 전부
 * 그날 테마 묶음의 대장이었고, 같은 기간 시스템 종가배팅(재료 붙은 신고점)은 +4.56%p였다.
 *
 * 후보는 사람이 종가에 고르는 자리와 맞춥니다: 그날 +10% 이상, 거래대금 50억 이상,
 * ETF·ETN·스팩 제외. 상한가(29.5%+)는 종가에 못 사는 날이 많아 따로 칸을 냅니다.
 *
 * 두 축으로 가릅니다.
 *   묶음   그 종목이 든 사업 테마(밸류업·신규상장 같은 바구니 제외) 중 하나에서
 *          **다른 멤버 3개 이상이 +5% 이상** 오른 날
 *   고유   직전 장 15:30 ~ 그날 15:20에 그 종목의 호재 공시(classifyDisclosure good)
 *          또는 **그 종목 하나·둘만 태깅된** 이유 기사(isReasonHeadline, 악재·기계기사 제외).
 *          여러 종목이 함께 태깅된 기사("반도체 기판주 전반 강세")는 묶음 기사라 빼고 셉니다.
 *
 * 값은 종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭(open > 0) 차감. 익일 종가도
 * 같이 봅니다. 중앙값과 장 단위로 읽습니다([[measurement-pitfalls]]).
 */

const config = readConfig();
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const from = option("from", "2026-08-18");
const split = option("split", "2026-10-20");
const basket = /(밸류업|기업인수목적|신규상장|리츠\(REITs\)|국내 상장 중국기업|지주사|코스피 200|코스닥 150)/;

const { rows: picks } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date, open, close, lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
      FROM kr_daily_bars WHERE session_date >= $1::date - 10
  ), mk AS (
    SELECT session_date, avg((open / prev - 1) * 100) AS g, avg((close / prev - 1) * 100) AS c
      FROM b WHERE prev > 0 AND open > 0 GROUP BY 1
  ), days AS (
    SELECT session_date AS d, lag(session_date) OVER (ORDER BY session_date) AS prev_d,
           lead(session_date) OVER (ORDER BY session_date) AS next_d
      FROM (SELECT DISTINCT session_date FROM kr_daily_bars WHERE session_date >= $1::date - 10) s
  )
  SELECT u.symbol, u.name, u.session_date::text AS d, days.prev_d::text AS prev_d, u.change_rate::float8 AS rate,
         (u.turnover / 1e8)::float8 AS t,
         ((nb.open / bb.close - 1) * 100 - mk.g)::float8 AS ex_open,
         ((nb.close / bb.close - 1) * 100 - mk.g - (mk.c - mk.g))::float8 AS ex_close,
         ((nb.open / bb.close - 1) * 100)::float8 AS gap,
         ((nb.close / nb.open - 1) * 100)::float8 AS day_move,
         ((nb.close / bb.close - 1) * 100)::float8 AS next_rate,
         ((nb.high / bb.close - 1) * 100)::float8 AS next_high
    FROM kr_daily_universe u
    JOIN kr_daily_bars bb ON bb.symbol = u.symbol AND bb.session_date = u.session_date
    JOIN days ON days.d = u.session_date
    JOIN kr_daily_bars nb ON nb.symbol = u.symbol AND nb.session_date = days.next_d
    JOIN mk ON mk.session_date = days.next_d
   WHERE u.session_date >= $1::date AND u.change_rate >= 10 AND u.turnover >= 50e8
     AND u.name !~ '(ETF|ETN|KODEX|TIGER|KBSTAR|HANARO|RISE |ACE |SOL |PLUS |스팩|레버리지|인버스)'
     AND bb.close > 0 AND nb.open > 0
     AND (nb.open / bb.close - 1) * 100 > -31`, [from]);

/* 같은 날 전 종목 등락 -- 테마 멤버가 몇 개 올랐는지 세는 데 씁니다. */
const { rows: moves } = await query(config, `
  SELECT symbol, session_date::text AS d, change_rate::float8 AS r FROM kr_daily_universe
   WHERE session_date >= $1::date AND change_rate >= 5`, [from]);
const { rows: members } = await query(config, "SELECT DISTINCT theme_name, symbol FROM kr_theme_members");

const themesOf = new Map();
const membersOf = new Map();

for (const row of members) {
  if (basket.test(row.theme_name)) continue;
  themesOf.set(row.symbol, [...(themesOf.get(row.symbol) ?? []), row.theme_name]);
  membersOf.set(row.theme_name, [...(membersOf.get(row.theme_name) ?? []), row.symbol]);
}

const upOn = new Map();

for (const row of moves) {
  if (!upOn.has(row.d)) upOn.set(row.d, new Set());
  upOn.get(row.d).add(row.symbol);
}

function groupOf(row) {
  const up = upOn.get(row.d) ?? new Set();
  let best = null;

  for (const theme of themesOf.get(row.symbol) ?? []) {
    const others = (membersOf.get(theme) ?? []).filter((symbol) => symbol !== row.symbol && up.has(symbol)).length;

    if (others >= 3 && (!best || others > best.others)) best = { others, theme };
  }

  return best;
}

const symbols = [...new Set(picks.map((row) => row.symbol))];
const { rows: filed } = await query(config, `
  SELECT symbol, filed_at, report_name, title FROM market_disclosures
   WHERE market = 'KR' AND symbol = ANY($1) AND filed_at >= $2::date - 10 AND filed_at_source = 'dart'`, [symbols, from]);
const { rows: news } = await query(config, `
  SELECT s AS symbol, published_at, headline, cardinality(related_symbols) AS tags
    FROM market_news_items, unnest(related_symbols) AS s
   WHERE region = 'KR' AND s = ANY($1) AND published_at >= $2::date - 10`, [symbols, from]);

const goodFilings = filed.filter((row) => !String(row.report_name ?? "").startsWith("[기재정정]")
  && classifyDisclosure(row.report_name, row.title) === "good");
const ownNews = news.filter((row) => row.tags <= 2 && isReasonHeadline(row.headline)
  && !mentionsBadNews(row.headline) && !isMachineHeadline(row.headline));

function ownOf(row) {
  const since = new Date(`${row.prev_d}T15:30:00+09:00`);
  const until = new Date(`${row.d}T15:20:00+09:00`);
  const inWindow = (time) => time >= since && time <= until;

  if (goodFilings.some((f) => f.symbol === row.symbol && inWindow(new Date(f.filed_at)))) return "공시";
  if (ownNews.some((n) => n.symbol === row.symbol && inWindow(new Date(n.published_at)))) return "기사";

  return null;
}

for (const row of picks) {
  row.group = groupOf(row);
  row.own = ownOf(row);
}

const med = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sign = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

function cell(label, rows) {
  if (!rows.length) return console.log(`  ${label.padEnd(26)}    0건`);

  const open = rows.map((row) => row.ex_open);
  const close = rows.map((row) => row.ex_close);
  const byDay = new Map();

  for (const row of rows) byDay.set(row.d, [...(byDay.get(row.d) ?? []), row.ex_open]);

  const dayPlus = [...byDay.values()].filter((list) => list.reduce((a, b) => a + b, 0) > 0).length / byDay.size;

  console.log(`  ${label.padEnd(26)} ${String(rows.length).padStart(4)}건/${String(byDay.size).padStart(3)}장`
    + ` · 시가 중앙 ${sign(med(open))} 상회 ${Math.round(100 * open.filter((v) => v > 0).length / open.length)}%`
    + ` 장+ ${Math.round(100 * dayPlus)}%`
    + ` · 종가 중앙 ${sign(med(close))} 상회 ${Math.round(100 * close.filter((v) => v > 0).length / close.length)}%`);
}

function table(title, pool) {
  console.log(title);
  for (const [label, buyable] of [["상한가 아님(살 수 있음)", (row) => row.rate < 29.5], ["상한가", (row) => row.rate >= 29.5]]) {
    const rows = pool.filter(buyable);

    console.log(` ${label}`);
    cell("고유 재료만", rows.filter((row) => row.own && !row.group));
    cell("묶음 + 고유 재료", rows.filter((row) => row.own && row.group));
    cell("묶음만(테마 대장)", rows.filter((row) => !row.own && row.group));
    cell("  └ 묶음 안 거래대금 1위", rows.filter((row) => !row.own && row.group && row.leader));
    cell("둘 다 없음", rows.filter((row) => !row.own && !row.group));
  }
  console.log("");
}

/* 묶음 안 1위: 같은 날 같은 테마로 묶인 후보 중 거래대금이 가장 큰 종목. */
const byTheme = new Map();

for (const row of picks.filter((pick) => pick.group)) {
  const key = `${row.d}|${row.group.theme}`;

  if (!byTheme.has(key) || byTheme.get(key).t < row.t) byTheme.set(key, row);
}
for (const row of byTheme.values()) row.leader = true;

console.log(`종가배팅 · 테마 묶음 대장 vs 회사 고유 재료 · ${from} ~ · 익일 시가·종가 초과(시장 차감)`);
console.log(`후보 +10%↑ · 거래대금 50억↑ · ${picks.length}건\n`);
table(`전체 (${from} ~)`, picks);
table(`${split} 전`, picks.filter((row) => row.d < split));
table(`${split} 이후 (최근 장세)`, picks.filter((row) => row.d >= split));

/*
 * 2026-11-11 사용자 질문: "다음날 시가가 +10% 넘게 뜨는 건 2연상으로 가고, +10%가 안 되는
 * 테마주는 돈이 다른 데로 빠져 단물이 빠지는가". 다음날 시가 갭 칸별로, 시가에서 종가까지
 * (시가에 산 사람의 하루)와 다음날 상한가 마감 비율, 고가가 상한가에 닿은 비율을 봅니다.
 * 상한가 아님(그날 종가에 살 수 있던 것)과 상한가를 나눕니다.
 */
function gapTable(title, pool) {
  const bands = [["+10% 이상", (g) => g >= 10], ["+5~10%", (g) => g >= 5 && g < 10], ["0~+5%", (g) => g >= 0 && g < 5], ["−5~0%", (g) => g >= -5 && g < 0], ["−5% 미만", (g) => g < -5]];

  console.log(title);
  for (const [label, test] of bands) {
    const rows = pool.filter((row) => test(row.gap));

    if (!rows.length) {
      console.log(`  ${label.padEnd(10)}    0건`);
      continue;
    }

    const days = new Set(rows.map((row) => row.d)).size;
    const pct = (fn) => Math.round(100 * rows.filter(fn).length / rows.length);

    console.log(`  ${label.padEnd(10)} ${String(rows.length).padStart(4)}건/${String(days).padStart(3)}장`
      + ` · 시가→종가 중앙 ${sign(med(rows.map((row) => row.day_move)))} 플러스 ${pct((row) => row.day_move > 0)}%`
      + ` · 다음날 상한가 마감 ${pct((row) => row.next_rate >= 29.5)}% · 고가 상한가 터치 ${pct((row) => row.next_high >= 29.5)}%`
      + ` · 다음날 종가 중앙 ${sign(med(rows.map((row) => row.next_rate)))}`);
  }
  console.log("");
}

console.log("─".repeat(40));
console.log("다음날 시가 갭 칸별 (시가→종가는 시가에 산 사람의 하루)\n");
for (const [label, keep] of [["전체", () => true], [`${split} 이후`, (row) => row.d >= split]]) {
  const pool = picks.filter(keep);

  gapTable(`[${label}] 상한가 아님 · 묶음만(테마 대장)`, pool.filter((row) => row.rate < 29.5 && row.group && !row.own));
  gapTable(`[${label}] 상한가 아님 · 고유 재료 있음`, pool.filter((row) => row.rate < 29.5 && row.own));
  gapTable(`[${label}] 상한가 · 전부`, pool.filter((row) => row.rate >= 29.5));
}

process.exit(0);
