import { classifyDisclosure, isMachineHeadline, isReasonHeadline, mentionsBadNews } from "../src/providers/overnight-classify.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 종가배팅 알림의 재료 조건이 성적을 가르는가.
 *
 *   node scripts/measure-close-bet-material.mjs [--from 2026-08-18]
 *
 * 2026-10-12에 15:20 알림을 "재료(공시든 기사든) 있는 중·대형만"으로 바꿨습니다(사용자
 * 요청). 그 조건이 과거 신호에서 값이 있었는지를 같은 판정으로 잽니다 -- 알림이 쓰는
 * close-bet-alert.mjs의 loadMaterial과 똑같이, 직전 장 마감(15:30)부터 **그날 15:20**
 * 까지의 공시(classifyDisclosure "good", [기재정정] 제외)와 기사(isReasonHeadline,
 * 악재·기계기사 제외)를 봅니다. 15:20으로 자르는 것은 알림을 받는 시각에 볼 수 있었던
 * 것만 세기 위해서입니다.
 *
 * 기사는 2026-08-16부터 태깅돼 있어 그 뒤만 잽니다. 성적은 중앙값과 장 단위로 봅니다
 * -- 평균은 꼬리 몇 건이 정합니다([[measurement-pitfalls]]).
 */

const config = readConfig();
const args = process.argv.slice(2);
const at = args.indexOf("--from");
const from = at >= 0 && args[at + 1] ? args[at + 1] : "2026-08-18";

/* 시장 평균 갭은 open > 0으로 새로 계산합니다. 저장된 market_next_open보다 정확합니다. */
const { rows: signals } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date, open, close, lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
      FROM kr_daily_bars WHERE session_date >= $1::date - 10
  ), mk AS (
    SELECT session_date, avg((open / prev - 1) * 100) AS g FROM b WHERE prev > 0 AND open > 0 GROUP BY 1
  ), days AS (
    SELECT session_date AS d, lag(session_date) OVER (ORDER BY session_date) AS prev_d,
           lead(session_date) OVER (ORDER BY session_date) AS next_d
      FROM (SELECT DISTINCT session_date FROM kr_daily_bars WHERE session_date >= $1::date - 10) s
  )
  SELECT o.kind, o.tier, o.symbol, o.session_date::text AS d, days.prev_d::text AS prev_d, o.entry_rate::float8 AS rate,
         ((o.next_open / bb.close - 1) * 100 - mk.g)::float8 AS ex
    FROM kr_signal_outcomes o
    JOIN kr_daily_bars bb ON bb.symbol = o.symbol AND bb.session_date = o.session_date
    JOIN days ON days.d = o.session_date
    JOIN mk ON mk.session_date = days.next_d
   WHERE o.kind IN ('close_bet', 'offhigh_close_bet') AND o.session_date >= $1::date
     AND o.scored_at IS NOT NULL AND o.next_open > 0 AND bb.close > 0`, [from]);

const { rows: filed } = await query(config, `
  SELECT symbol, filed_at, report_name, title FROM market_disclosures
   WHERE market = 'KR' AND symbol = ANY($1) AND filed_at >= $2::date - 10 AND filed_at_source = 'dart'`,
[[...new Set(signals.map((row) => row.symbol))], from]);
const { rows: news } = await query(config, `
  SELECT s AS symbol, published_at, headline FROM market_news_items, unnest(related_symbols) AS s
   WHERE region = 'KR' AND s = ANY($1) AND published_at >= $2::date - 10`,
[[...new Set(signals.map((row) => row.symbol))], from]);

const goodFilings = filed.filter((row) => !String(row.report_name ?? "").startsWith("[기재정정]")
  && classifyDisclosure(row.report_name, row.title) === "good");
const reasonNews = news.filter((row) => isReasonHeadline(row.headline) && !mentionsBadNews(row.headline) && !isMachineHeadline(row.headline));

function materialOf(row) {
  const since = new Date(`${row.prev_d}T15:30:00+09:00`);
  const until = new Date(`${row.d}T15:20:00+09:00`);
  const inWindow = (time) => time >= since && time <= until;

  if (goodFilings.some((f) => f.symbol === row.symbol && inWindow(new Date(f.filed_at)))) return "공시";
  if (reasonNews.some((n) => n.symbol === row.symbol && inWindow(new Date(n.published_at)))) return "기사";

  return null;
}

const med = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function cell(label, rows) {
  if (!rows.length) return console.log(`  ${label.padEnd(30)}    0건`);

  const ex = rows.map((row) => row.ex);
  const byDay = new Map();

  for (const row of rows) byDay.set(row.d, [...(byDay.get(row.d) ?? []), row.ex]);

  const dayPlus = [...byDay.values()].filter((list) => list.reduce((a, b) => a + b, 0) > 0).length / byDay.size;
  const sign = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

  console.log(`  ${label.padEnd(30)} ${String(rows.length).padStart(4)}건/${String(byDay.size).padStart(3)}장`
    + ` · 중앙 ${sign(med(ex))} · 평균 ${sign(ex.reduce((a, b) => a + b, 0) / ex.length)}`
    + ` · 상회 ${Math.round(100 * ex.filter((v) => v > 0).length / ex.length)}% · 장 플러스 ${Math.round(100 * dayPlus)}%`);
}

for (const row of signals) row.material = materialOf(row);

console.log(`종가배팅 재료 조건 · ${from} ~ · 다음날 시가 초과(시장 갭 차감)\n`);

for (const [kind, label] of [["close_bet", "종가배팅(신고점)"], ["offhigh_close_bet", "미돌파"]]) {
  console.log(label);

  for (const tiers of [["대형", "중형"], ["소형"]]) {
    const pool = signals.filter((row) => row.kind === kind && tiers.includes(row.tier));
    const name = tiers.join("·");

    cell(`${name} 재료 있음`, pool.filter((row) => row.material));
    cell(`${name}   ├ 공시`, pool.filter((row) => row.material === "공시"));
    cell(`${name}   └ 기사`, pool.filter((row) => row.material === "기사"));
    cell(`${name} 재료 없음`, pool.filter((row) => !row.material));

    // 상한가(29.5%+)는 종가에 사기 어렵습니다(체결되면 무너지는 날). 살 수 있는 칸만 따로.
    if (tiers.includes("소형")) {
      cell(`${name} 재료 있음 · 상한가 아님`, pool.filter((row) => row.material && row.rate < 29.5));
      cell(`${name} 재료 있음 · 상한가`, pool.filter((row) => row.material && row.rate >= 29.5));
    }
  }

  console.log("");
}

process.exit(0);
