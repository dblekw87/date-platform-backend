import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 기관이 며칠째 사던 종목이 급등 마감하면 다음 날 시가가 나은가.
 *
 *   node scripts/measure-close-bet-institution.mjs
 *
 * 2026-10-21 사용자 질문입니다. 삼성E&A가 기관 8일 연속 순매수(합 약 538억) 끝에
 * +9.4%로 마감했고, "전날 회전율이 높았던 건 매집일 수도 있다"고 했습니다. 가격과
 * 거래대금만으로는 매집과 손절을 못 가르므로 `kr_investor_flow`의 기관 순매수로 잽니다.
 *
 * 대상은 당일 +5~29% 마감·거래대금 100억+입니다. 성적은 종가 매수 → 익일 시가,
 * 그날 밤 시장 평균 갭(open > 0)을 뺀 초과입니다.
 *
 * **당일 기관 숫자는 15:20에 볼 수 없습니다** -- 표는 16시 넘어 받는 확정치입니다.
 * 15:20에 알 수 있는 것은 전날까지의 연속 일수뿐이니 그쪽이 쓸 수 있는 축이고,
 * 당일 칸은 참고로만 냅니다.
 *
 * 기간은 `kr_daily_universe`가 있는 2026-08-21 뒤로 묶입니다. 그 창 전체가 대금
 * 큰 종목 위주라 마이너스이므로 칸끼리의 차이로 읽어야 합니다.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH f AS (
    SELECT symbol, session_date, institution_amount AS ia,
           sum(CASE WHEN institution_amount <= 0 THEN 1 ELSE 0 END)
             OVER (PARTITION BY symbol ORDER BY session_date) AS grp
      FROM kr_investor_flow
  ), streaks AS (
    -- Each non-buy day opens a new group, so a buying day's streak is its row count
    -- in the group minus that opening row (group 0 has no opening row).
    SELECT symbol, session_date, ia,
           CASE WHEN ia > 0 THEN count(*) OVER (PARTITION BY symbol, grp ORDER BY session_date)
                                 - CASE WHEN grp = 0 THEN 0 ELSE 1 END
                ELSE 0 END AS streak
      FROM f
  ), b AS (
    SELECT symbol, session_date, open, close,
           lag(close) OVER w AS prev, lead(open) OVER w AS next_open, lead(session_date) OVER w AS next_day
      FROM kr_daily_bars WHERE session_date >= '2026-07-01'
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ), mk AS (
    SELECT session_date, avg(open / prev - 1) AS gap FROM b WHERE prev > 0 AND open > 0 GROUP BY 1
  ), x AS (
    SELECT b.close / b.prev - 1 AS rate,
           (b.next_open / b.close - 1 - mk.gap) * 100 AS ex,
           lag(s.streak) OVER (PARTITION BY b.symbol ORDER BY b.session_date) AS prior_streak,
           s.ia AS today_ia,
           u.turnover::float8 AS value
      FROM b
      JOIN mk ON mk.session_date = b.next_day
      JOIN streaks s ON s.symbol = b.symbol AND s.session_date = b.session_date
      JOIN kr_daily_universe u ON u.symbol = b.symbol AND u.session_date = b.session_date
     WHERE b.prev > 0 AND b.open > 0 AND b.next_open > 0 AND b.close > 0
  )
  SELECT CASE WHEN prior_streak IS NULL THEN '?'
              WHEN prior_streak = 0 THEN '0'
              WHEN prior_streak <= 2 THEN '1-2'
              WHEN prior_streak <= 4 THEN '3-4'
              ELSE '5+' END AS streak,
         CASE WHEN today_ia > 0 THEN 'buy' ELSE 'sell' END AS today,
         count(*)::int AS n,
         avg(ex)::float8 AS avg,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY ex))::float8 AS median,
         avg((ex > 0)::int)::float8 AS beat
    FROM x
   WHERE rate BETWEEN 0.05 AND 0.29 AND value >= 1e10
   GROUP BY 1, 2
   ORDER BY 2, 1`);

console.log("prior streak | today inst |    n |    avg | median | beat");

for (const row of rows) {
  console.log([
    row.streak.padEnd(12),
    row.today.padEnd(10),
    String(row.n).padStart(4),
    row.avg.toFixed(2).padStart(6),
    row.median.toFixed(2).padStart(6),
    `${Math.round(row.beat * 100)}%`.padStart(4)
  ].join(" | "));
}

process.exit(0);
