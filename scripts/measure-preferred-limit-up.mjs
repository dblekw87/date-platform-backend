import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 우선주 상한가 다음 날 -- 연속 상한가(2연상)가 보통주와 다른가.
 *
 *   node scripts/measure-preferred-limit-up.mjs
 *
 * 2026-11-09 사용자가 덕성우를 2연상 자리(6,950, 상한가 6,990 바로 아래)에서
 * 종가배팅으로 샀습니다. 11/06 폭락장부터 우선주 상한가가 매일 여럿 나왔는데
 * (한진칼우·깨끗한나라우·덕성우·동양2우B), 우선주 상한가의 다음 날을 잰 적이 없었습니다.
 *
 * 우선주는 코드 끝자리로 가립니다(5 = 우, 7 = 2우B, 9 = 3우B). kr_daily_universe의
 * 이름은 2026-08-23부터라 2025년을 못 덮습니다. 상한가는 종가 등락 +29.5% 이상,
 * "잠김"은 종가 = 고가입니다. 다음 날 시가 갭과 종가를 그날 전 종목 동일가중 시가 갭에서
 * 뺀 초과로 봅니다(시가 0인 불량행은 시장 평균에서 뺍니다 -- measurement-pitfalls).
 */
const config = readConfig();

const { rows } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date, open::float8 o, high::float8 h, close::float8 c,
           lag(close::float8) OVER w pc,
           lead(open::float8) OVER w no,
           lead(close::float8) OVER w nc,
           lead(session_date) OVER w nd
      FROM kr_daily_bars
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  r AS (
    SELECT *, c / nullif(pc, 0) - 1 AS ret,
           lag(c / nullif(pc, 0) - 1) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_ret
      FROM b
  ),
  mkt AS (
    SELECT session_date, avg(o / nullif(pc, 0) - 1) gap
      FROM b WHERE o > 0 AND pc > 0 GROUP BY session_date
  ),
  ev AS (
    SELECT r.*, (r.symbol ~ '^[0-9]{5}[579KL]$') pref, (r.c >= r.h) locked,
           CASE WHEN r.prev_ret >= 0.295 THEN '2연상+' ELSE '첫 상한가' END streak,
           (r.no / r.c - 1) * 100 gap, (r.nc / r.c - 1) * 100 next_close,
           (r.no / r.c - 1 - m.gap) * 100 excess
      FROM r JOIN mkt m ON m.session_date = r.nd
     WHERE r.ret >= 0.295 AND r.no > 0 AND r.nc > 0 AND r.session_date < $1::date
  )
  SELECT CASE WHEN pref THEN '우선주' ELSE '보통주' END kind, streak,
         CASE WHEN locked THEN '잠김' ELSE '풀림' END lock,
         count(*) n,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric, 2) gap_med,
         round(avg(gap)::numeric, 2) gap_avg,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY excess)::numeric, 2) ex_med,
         round(100.0 * avg((excess > 0)::int), 0) beat,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY next_close)::numeric, 2) close_med,
         round(100.0 * avg((gap <= -3)::int), 0) gap_le_m3,
         round(100.0 * avg((next_close >= 29.5)::int), 0) close_limit,
         round(100.0 * avg((next_close <= -10)::int), 0) close_le_m10,
         count(DISTINCT symbol) symbols
    FROM ev GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`, [new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)]);

// 다음 날 종가는 두 봉우리입니다(또 상한가 아니면 크게 밀림) -- 중앙값은 몇 건에 크게
// 흔들립니다(11/09 K·L 코드 8건을 더하자 +4.9 → +29.8). 양 끝 비율을 같이 봅니다.
console.log("종류 | 연속 | 마감 | 건수(종목) | 시가갭 중앙 | 평균 | 초과 중앙 | 상회% | 다음종가 중앙 | 다음종가 상한가% | 다음종가 −10% 이하% | 갭 −3% 이하%");
for (const row of rows) {
  console.log([row.kind, row.streak, row.lock, `${row.n}(${row.symbols})`, row.gap_med, row.gap_avg, row.ex_med, row.beat, row.close_med, row.close_limit, row.close_le_m10, row.gap_le_m3].join(" | "));
}

const { rows: cases } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date, high::float8 h, close::float8 c,
           lag(close::float8) OVER w pc, lead(open::float8) OVER w no, lead(close::float8) OVER w nc
      FROM kr_daily_bars WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  r AS (
    SELECT *, c / nullif(pc, 0) - 1 ret,
           lag(c / nullif(pc, 0) - 1) OVER (PARTITION BY symbol ORDER BY session_date) prev_ret
      FROM b
  )
  SELECT r.session_date::text d, r.symbol,
         (SELECT name FROM kr_daily_universe u WHERE u.symbol = r.symbol ORDER BY session_date DESC LIMIT 1) name,
         (r.c >= r.h) locked, round(((r.no / r.c - 1) * 100)::numeric, 2) gap, round(((r.nc / r.c - 1) * 100)::numeric, 2) nclose
    FROM r
   WHERE r.symbol ~ '^[0-9]{5}[579KL]$' AND r.ret >= 0.295 AND r.prev_ret >= 0.295 AND r.no > 0
   ORDER BY r.session_date DESC LIMIT 25`);

console.log("");
console.log("우선주 2연상+ 최근 사례 (날짜 · 종목 · 잠김 · 다음 시가 · 다음 종가)");
for (const row of cases) console.log(`${row.d} ${row.symbol} ${row.name ?? ""} · ${row.locked ? "잠김" : "풀림"} · ${row.gap}% · ${row.nclose}%`);

process.exit(0);
