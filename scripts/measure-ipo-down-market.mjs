import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 시장이 빠진 날 상장한 신규주가 더 오르는가.
 *
 *   node scripts/measure-ipo-down-market.mjs
 *
 * 2026-10-30 인텔리빅스(공모가 대비 +85% -> +197%)가 코스피 매도 사이드카 날
 * 지수 저점에서 혼자 돌았습니다. 사용자 가설: "신규주는 그날의 헷지 테마다" --
 * 지수 바구니(프로그램 매매)에 없으니 시장이 무너지는 날 돈이 몰린다.
 *
 * 상장일은 backtest-ipo.mjs와 같이 일봉에 처음 나타난 날입니다. 공모가가 없어서
 * 첫날 수익은 시초가 기준(시초가 -> 종가, 시초가 -> 고가)으로만 잽니다.
 * 시장은 그날 전 종목 평균 전일 대비(국면 가르기)와 평균 시초가 -> 종가(초과 계산)
 * 두 가지를 씁니다. 시장 평균에는 open > 0이 필수입니다(measurement-pitfalls).
 */
const config = readConfig();

const { rows } = await query(config, `
  WITH first AS (
    SELECT symbol, min(session_date) AS listed FROM kr_daily_bars GROUP BY symbol
  ),
  seq AS (
    SELECT symbol, session_date, open::float8, high::float8, close::float8,
           row_number() OVER (PARTITION BY symbol ORDER BY session_date) AS n
      FROM kr_daily_bars WHERE open > 0 AND close > 0
  ),
  market AS (
    SELECT s.session_date,
           avg((s.close / p.close - 1) * 100) AS move,
           avg((s.close / s.open - 1) * 100) AS intraday
      FROM seq s
      JOIN seq p ON p.symbol = s.symbol AND p.n = s.n - 1
     GROUP BY s.session_date HAVING count(*) >= 50
  )
  SELECT d.symbol, coalesce(l.name, u.name) AS name, d.session_date::text AS d,
         (d.close / d.open - 1) * 100 AS oc,
         (d.high / d.open - 1) * 100 AS oh,
         m.move, m.intraday
    FROM seq d
    JOIN first t ON t.symbol = d.symbol AND t.listed = d.session_date
    JOIN market m ON m.session_date = d.session_date
    LEFT JOIN kr_listings l ON l.symbol = d.symbol
    LEFT JOIN LATERAL (SELECT name FROM kr_daily_universe x WHERE x.symbol = d.symbol LIMIT 1) u ON true
   WHERE d.session_date >= '2025-03-01'
     AND coalesce(l.name, u.name) IS NOT NULL
     AND coalesce(l.name, u.name) !~ '스팩|ETN|TIGER|KODEX|RISE|PLUS|ACE|SOL |TIMEFOLIO|KIWOOM|히어로즈|파워 |마이티|WON |BNK|UNICORN|프리미어|액티브|리츠|1Q |Reg.S'
`);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
const buckets = [
  { label: "시장 -1.5% 이하", test: (m) => m <= -1.5 },
  { label: "-1.5 ~ -0.5", test: (m) => m > -1.5 && m <= -0.5 },
  { label: "-0.5 ~ +0.5", test: (m) => m > -0.5 && m < 0.5 },
  { label: "+0.5 ~ +1.5", test: (m) => m >= 0.5 && m < 1.5 },
  { label: "+1.5 이상", test: (m) => m >= 1.5 }
];

console.log(`상장일 ${rows.length}건 (${rows[0]?.d} ~)`);
console.log("국면 | 건수 | 날수 | 시초→종가 중앙 | 상승 비율 | 시장 대비 초과 중앙 | 초과>0 | 시초→고가 중앙");

for (const bucket of buckets) {
  const picked = rows.filter((row) => bucket.test(Number(row.move)));

  if (!picked.length) continue;

  const oc = picked.map((row) => Number(row.oc));
  const excess = picked.map((row) => Number(row.oc) - Number(row.intraday));
  const oh = picked.map((row) => Number(row.oh));
  const days = new Set(picked.map((row) => row.d)).size;

  console.log([
    bucket.label, picked.length, days, fmt(median(oc)),
    `${Math.round(oc.filter((v) => v > 0).length / oc.length * 100)}%`,
    fmt(median(excess)),
    `${Math.round(excess.filter((v) => v > 0).length / excess.length * 100)}%`,
    fmt(median(oh))
  ].join(" | "));
}

console.log("\n시장 -1.5% 이하 날 상장 건:");
for (const row of rows.filter((r) => Number(r.move) <= -1.5).sort((a, b) => a.d.localeCompare(b.d))) {
  console.log(`${row.d} ${row.name} 시장 ${fmt(Number(row.move))} · 시초→종가 ${fmt(Number(row.oc))} · 시초→고가 ${fmt(Number(row.oh))}`);
}
process.exit(0);
