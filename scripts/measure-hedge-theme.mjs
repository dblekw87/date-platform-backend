import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 급락일 헷지 테마 -- 보안주가 지수 급락일에 버티는가.
 *
 *   node scripts/measure-hedge-theme.mjs [테마이름]
 *
 * 2026-10-30 사용자: "보안주가 헷지 테마일 때가 있더라고, 그리고 신규주".
 * 10/13(코스피 -7%)과 10/30(-3.5%) 둘 다 보안주가 버텼습니다(라온시큐어 +13, 안랩 +18).
 * 신규주는 measure-ipo-down-market.mjs에서 따로 잽니다.
 *
 * 지수와 국면 가르기는 measure-crash-day-rotation.mjs와 같습니다(시총 상위 30 고정 가중).
 * 테마별로 그날 멤버 등락 중앙값과 상위 3종목 중앙값(대장만 가는 날)을 같이 봅니다.
 * 기준선은 같은 날 다른 테마들입니다 -- 급락일엔 어떤 테마든 하나는 버티니,
 * 보안주가 그 "하나"에 남들보다 자주 드는지가 질문입니다.
 * 멤버십은 지금의 네이버 테마 목록이라 과거 날짜엔 조금 앞을 봅니다.
 */
const c = readConfig();
const target = process.argv[2] ?? "보안주(정보)";
const sql = `
WITH w AS (
  SELECT symbol, market_cap::float8 cap FROM (
    SELECT DISTINCT ON (symbol) symbol, market_cap FROM kr_daily_universe WHERE market_cap > 0 ORDER BY symbol, session_date DESC) t
  ORDER BY market_cap DESC LIMIT 30
), b AS (
  SELECT symbol, session_date, open, close, lag(close) OVER w2 prev
    FROM kr_daily_bars WHERE session_date >= '2025-01-01' WINDOW w2 AS (PARTITION BY symbol ORDER BY session_date)
), r AS (SELECT *, (close/prev-1)*100 ret FROM b WHERE prev>0 AND open>0 AND close>0 AND (close/prev-1)*100 > -31),
m AS (
  SELECT r.session_date, avg(r.ret) mv, sum(r.ret * w.cap) FILTER (WHERE w.cap IS NOT NULL) / nullif(sum(w.cap) FILTER (WHERE w.cap IS NOT NULL), 0) idx
    FROM r LEFT JOIN w USING (symbol) GROUP BY 1 HAVING count(*) > 1000
), tm AS (SELECT DISTINCT theme_name, symbol FROM kr_theme_members),
t AS (
  SELECT tm.theme_name, r.session_date d, count(*) n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ret - m.mv) med,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FROM unnest((array_agg(r.ret - m.mv ORDER BY r.ret DESC))[1:3]) v) top3,
         m.mv, m.idx
    FROM r JOIN tm USING (symbol) JOIN m USING (session_date)
   GROUP BY tm.theme_name, r.session_date, m.mv, m.idx HAVING count(*) >= 8
), ranked AS (
  SELECT *, percent_rank() OVER (PARTITION BY d ORDER BY med) pr_med, percent_rank() OVER (PARTITION BY d ORDER BY top3) pr_top FROM t
)`;
const { rows } = await query(c, sql + `
SELECT CASE WHEN idx <= -3 AND mv <= -2 THEN '1 지수·전종목 같이 급락' WHEN idx <= -3 THEN '2 지수만 급락' WHEN idx <= -1.5 THEN '3 지수 -3~-1.5%' WHEN idx < 1 THEN '4 보통' ELSE '5 지수 ≥+1%' END kind,
  count(*)::int days,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY med))::numeric,2) med_ex,
  round(100*avg((med > 0)::int)) med_pos,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY top3))::numeric,2) top3_ex,
  round(100*avg((top3 >= 10)::int)) top3_10,
  round(100*avg(pr_med)::numeric) rank_med,
  round(100*avg(pr_top)::numeric) rank_top3,
  round(100*avg((pr_top >= 0.9)::int)) top10pct
FROM ranked WHERE theme_name = $1 GROUP BY 1 ORDER BY 1`, [target]);
console.log(`${target} -- 그날 국면별 (초과 = 전 종목 평균 대비, 순위 = 그날 테마들 중 백분위, 100이 1등)`);
console.table(rows);
const { rows: days } = await query(c, sql + `
SELECT d::text, round(idx::numeric,2) idx, round(mv::numeric,2) mv, n, round(med::numeric,2) med, round(top3::numeric,2) top3, round(100*pr_top) rank_top3
  FROM ranked WHERE theme_name = $1 AND idx <= -3 ORDER BY d`, [target]);
console.log("지수 -3% 이하 날 하루씩"); console.table(days);
process.exit(0);
