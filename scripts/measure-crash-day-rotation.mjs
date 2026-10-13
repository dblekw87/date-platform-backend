import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 급락장에 돈이 전날 테마(상한가)로 가는가.
 *
 *   node scripts/measure-crash-day-rotation.mjs
 *
 * 사용자 관찰(2026-10-13, 코스피 −7.02%): "급락장일 땐 테마주로 간다." 그날 호남반도체
 * (서산 상한가)·보안주만 버텼습니다. 처음엔 전 종목 평균 −3% 이하로 급락일을 골랐다가,
 * 그날 전 종목 평균은 −1.12%뿐이라는 것을 보고 다시 쟀습니다 -- 코스피는 삼성·하이닉스가
 * 정합니다. 그래서 둘을 따로 봅니다:
 *
 *   지수 대용  최근 시총 상위 30종목을 최근 시총으로 고정 가중한 평균(10-12 −3.71 / 10-13 −6.63,
 *              실제 −3.65 / −7.02)
 *   전 종목    그날 전 종목 단순 평균
 *
 * 하한가(−30%) 밖의 하락은 액면분할·병합이라 뺍니다(일봉이 수정주가가 아닙니다).
 * 초과는 전 종목 평균 대비, 중앙값과 상회율로 봅니다.
 */
const c = readConfig();
/* 지수 대용: 최근 시총 상위 30종목을 최근 시총으로 고정 가중한 평균. 코스피는 삼성·하이닉스 비중이 커서 단순평균과 크게 다릅니다. */
const sql = `
WITH w AS (
  SELECT symbol, market_cap::float8 cap FROM (
    SELECT DISTINCT ON (symbol) symbol, market_cap FROM kr_daily_universe WHERE market_cap > 0 ORDER BY symbol, session_date DESC) t
  ORDER BY market_cap DESC LIMIT 30
), b AS (
  SELECT symbol, session_date, open, high, close, lag(close) OVER w2 prev
    FROM kr_daily_bars WHERE session_date >= '2025-01-01' WINDOW w2 AS (PARTITION BY symbol ORDER BY session_date)
), r AS (SELECT *, (close/prev-1)*100 ret FROM b WHERE prev>0 AND open>0 AND close>0 AND (close/prev-1)*100 > -31),
m AS (
  SELECT r.session_date, avg(r.ret) mv, sum(r.ret * w.cap) FILTER (WHERE w.cap IS NOT NULL) / nullif(sum(w.cap) FILTER (WHERE w.cap IS NOT NULL), 0) idx
    FROM r LEFT JOIN w USING (symbol) GROUP BY 1 HAVING count(*) > 1000
)`;
const { rows: check } = await query(c, sql + ` SELECT session_date::text d, round(idx::numeric,2) idx, round(mv::numeric,2) mv FROM m WHERE session_date >= '2026-10-07' ORDER BY 1`);
console.log("지수 대용 확인 (실제 코스피 10-12 −3.65%, 10-13 −7.02%)"); console.table(check);
const { rows } = await query(c, sql + `,
x AS (
  SELECT r.symbol, r.session_date d, r.ret, (r.high/r.prev-1)*100 h, lag(r.ret) OVER (PARTITION BY r.symbol ORDER BY r.session_date) prev_ret, m.mv, m.idx
    FROM r JOIN m USING (session_date)
)
SELECT CASE WHEN idx <= -3 AND mv <= -2 THEN '1 지수·전종목 같이 급락' WHEN idx <= -3 THEN '2 지수만 급락(중소형 버팀)' WHEN idx <= -1.5 THEN '3 지수 -3~-1.5%' WHEN idx < 1 THEN '4 보통' ELSE '5 지수 ≥+1%' END kind,
       count(*)::int n, count(DISTINCT d)::int days,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ret - mv))::numeric,2) ex_med,
       round(100*avg((ret - mv > 0)::int),0) beat,
       round(100*avg((h >= 29.5)::int),0) relimit,
       round(avg(mv)::numeric,2) mkt, round(avg(idx)::numeric,2) idx
  FROM x WHERE prev_ret >= 29.5 GROUP BY 1 ORDER BY 1`);
console.log("전날 상한가 종목의 다음 날 — 그날 지수 대용으로 가름 (초과 = 전 종목 평균 대비)"); console.table(rows);
process.exit(0);
