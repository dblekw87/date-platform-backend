import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 장 초반 테마별 거래대금 쏠림 -- 어느 테마로 돈이 몰리고 있나.
 *
 *   node scripts/theme-flow-check.mjs [YYYY-MM-DD] [HH:MM]
 *
 * 2026-10-30 사용자가 보안주를 찾은 순서(memory trader-brain): 판을 읽고 →
 * 거래대금이 쏠리는 테마를 보고 → 뉴스로 이유를 확인 → 누적 거래대금으로 대장 서열.
 * "주도주는 보통 09:10~09:20~30에 결정난다"고 해서 그 시각에 돌리는 확인용입니다.
 *
 * 시점까지의 종목별 마지막 표본(순위 1분·전 종목 6분)만 씁니다. 테마는 네이버 테마
 * 멤버십이고, 테마별로 상위 3종목 거래대금 합과 최근 10분 증가분, 상위 3종목 등락
 * 중앙값을 봅니다. 한 종목이 여러 테마에 들어 있어 같은 돈이 여러 테마에 잡힙니다.
 * 오르는 종목(+0% 초과)만 셉니다 -- 빠지는 대형주 거래대금이 테마를 부풀렸습니다
 * (10/30 09:33 삼성전자 -4.4% 8,983억이 '의료기기' 1위를 만듦). 그날 상장한 종목은
 * 테마가 없어서 '신규상장' 묶음으로 따로 넣습니다(10/30 인텔리빅스).
 * 판정이 아니라 사람이 보는 표입니다. 진입 권유로 쓰지 않습니다.
 */
const config = readConfig();
const kst = new Date(Date.now() + 9 * 3600_000).toISOString();
const day = process.argv[2] ?? kst.slice(0, 10);
const at = process.argv[3] ?? kst.slice(11, 16);

const { rows } = await query(config, `
  WITH s AS (
    SELECT symbol, name, change_rate::float8 r, turnover::float8 t, observed_at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1 AND source LIKE 'kis:krx%'
       AND observed_at <= ($1::date + $2::time) AT TIME ZONE 'Asia/Seoul'
       AND observed_at >= ($1::date + time '09:00') AT TIME ZONE 'Asia/Seoul'
  ),
  now AS (SELECT DISTINCT ON (symbol) symbol, name, r, t FROM s ORDER BY symbol, observed_at DESC),
  ago AS (
    SELECT DISTINCT ON (symbol) symbol, t FROM s
     WHERE observed_at <= ($1::date + $2::time - interval '10 minutes') AT TIME ZONE 'Asia/Seoul'
     ORDER BY symbol, observed_at DESC
  ),
  j AS (
    SELECT tm.theme_name, n.symbol, n.name, n.r, n.t, n.t - coalesce(a.t, 0) dt,
           row_number() OVER (PARTITION BY tm.theme_name ORDER BY n.t DESC) k
      FROM now n
      JOIN (SELECT DISTINCT theme_name, symbol FROM kr_theme_members
            UNION SELECT '신규상장', symbol FROM kr_listings WHERE listed_on = $1) tm USING (symbol)
      LEFT JOIN ago a USING (symbol)
     WHERE n.r > 0
  )
  SELECT theme_name, count(*) n,
         sum(t) FILTER (WHERE k <= 3) / 1e8 top3_t,
         sum(dt) FILTER (WHERE k <= 3) / 1e8 top3_dt,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE k <= 3) top3_r,
         string_agg(name || ' ' || round(r::numeric, 1) || '% ' || round((t / 1e8)::numeric) || '억', ' > ' ORDER BY k) FILTER (WHERE k <= 3) leaders
    FROM j GROUP BY theme_name
   HAVING percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE k <= 3) >= 3
   ORDER BY sum(dt) FILTER (WHERE k <= 3) DESC NULLS LAST
   LIMIT 8`, [day, at]);
const { rows: [market] } = await query(config, `
  SELECT symbol, change_rate FROM macro_samples
   WHERE symbol IN ('KOSPI', 'KOSDAQ') AND observed_at <= ($1::date + $2::time) AT TIME ZONE 'Asia/Seoul'
   ORDER BY observed_at DESC LIMIT 1`, [day, at]);

console.log(`${day} ${at} 테마 쏠림 (상위 3종목 · 최근 10분 거래대금 증가 순 · 대장 등락 중앙 +3% 이상만)${market ? ` · ${market.symbol} ${market.change_rate}%` : ""}`);
for (const row of rows) {
  console.log(`${row.theme_name} | 10분 +${Math.round(row.top3_dt)}억 · 누적 ${Math.round(row.top3_t)}억 · 대장 중앙 ${Number(row.top3_r).toFixed(1)}% | ${row.leaders}`);
}
process.exit(0);
