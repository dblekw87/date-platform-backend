import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅 조건별 실측 — 밤을 통제한 채로.
 *
 * 종가배팅은 "오늘 종가에 사서 내일 시가에 판다"이고, 성패는 갭 하나로 갈립니다.
 * 문제는 갭의 대부분이 종목이 아니라 그날 밤에서 온다는 것입니다: 우리 분봉 3개
 * 밤의 갭상승 확률이 43% / 71% / 30%였습니다. 그 폭 안에서는 어떤 조건이든 좋아
 * 보이거나 나빠 보이게 만들 수 있습니다.
 *
 * 그래서 재는 값은 갭이 아니라 **그날 밤 평균 대비 초과분**입니다. 미국과 이란이
 * 전쟁을 하면 모든 종목이 같이 떨어지고, 그건 양변에서 상쇄됩니다. 남는 것이
 * 종목 선택의 몫이고, 그것만이 화면에 올릴 자격이 있습니다.
 *
 * 검증 대상은 머니스푼즈 <종가베팅 매매기법>이 말하는 "활성화 양봉"입니다.
 * 그 글은 양봉을 셋으로 나눕니다.
 *
 *   1번  박스권 안의 평범한 양봉        - 사지 말 것
 *   2번  중요한 고점을 막 돌파한 양봉   - 이것만 살 것 (활성화 양봉)
 *   3번  돌파 이후 이어지는 양봉        - 에너지 소진 구간, 리스크가 높음
 *
 * 반증 가능한 명세라서 그대로 옮길 수 있습니다. 2번과 3번을 가르는 것은 "직후"
 * 하나입니다 - 어제도 이미 고점 위였다면 3번입니다.
 *
 *   node scripts/measure-close-bet.mjs [--lookback 60] [--min-turnover 1000000000]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
// 60거래일 = 약 3개월. 글이 말하는 "중요한 신고점"은 52주 신고가에 가깝지만,
// 그 기준으로는 표본이 너무 얇아져 조건별 비교가 되지 않습니다.
const lookback = flag("lookback", 60);
// 하루 거래대금 10억 미만은 갭이 호가 한 칸으로도 튀어서 측정이 무의미합니다.
const minTurnover = flag("min-turnover", 1_000_000_000);

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN $1 PRECEDING AND 1 PRECEDING) AS prior_high,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN $1 + 1 PRECEDING AND 2 PRECEDING) AS prior_high_yesterday,
           avg(volume) OVER (PARTITION BY symbol ORDER BY session_date
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  scored AS (
    SELECT *,
           (next_open / close - 1) * 100 AS gap,
           (close / prev_close - 1) * 100 AS day_move,
           close > open AS bullish,
           close > prior_high AS broke_today,
           prev_close > prior_high_yesterday AS broke_yesterday
      FROM bars
     WHERE next_open IS NOT NULL AND prev_close > 0 AND close > 0
       AND prior_high IS NOT NULL AND prior_high_yesterday IS NOT NULL
       AND close * volume >= $2
  ),
  nights AS (
    SELECT session_date, avg(gap) AS night_gap, count(*) AS night_n
      FROM scored GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT s.session_date::text AS d, s.symbol, s.gap, s.day_move, s.turnover,
         s.bullish, s.broke_today, s.broke_yesterday,
         s.volume / nullif(s.avg_volume, 0) AS volume_ratio,
         n.night_gap, s.gap - n.night_gap AS excess
    FROM scored s
    JOIN nights n ON n.session_date = s.session_date
`, [lookback, minTurnover]);

const num = (v) => (v === null ? null : Number(v));
const report = (label, list) => {
  if (list.length === 0) {
    console.log(`  ${label.padEnd(30)} (표본 없음)`);

    return;
  }

  const excess = list.map((r) => num(r.excess));
  const gaps = list.map((r) => num(r.gap));
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const beat = excess.filter((x) => x > 0).length;
  const up = gaps.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 갭상승 ${String(Math.round((up / gaps.length) * 100)).padStart(3)}% · 밤평균 상회 ${String(Math.round((beat / excess.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log(`표본 ${rows.length}건 · 신고점 기준 ${lookback}일 · 거래대금 ${(minTurnover / 1e8).toFixed(0)}억 이상`);
console.log(`밤 ${new Set(rows.map((r) => r.d)).size}개 · 기간 ${rows.reduce((a, r) => (r.d < a ? r.d : a), "9999")} ~ ${rows.reduce((a, r) => (r.d > a ? r.d : a), "0")}`);
console.log("\n비교 기준: 같은 밤의 평균 갭. 초과가 0에 가까우면 그 조건은 밤만큼만 한 것입니다.\n");

report("전체", rows);
console.log("\n머니스푼즈 양봉 3분류");
report("2번 활성화 양봉 (돌파 직후)", rows.filter((r) => r.bullish && r.broke_today && !r.broke_yesterday));
report("3번 돌파 이어가기", rows.filter((r) => r.bullish && r.broke_today && r.broke_yesterday));
report("1번 박스권 양봉", rows.filter((r) => r.bullish && !r.broke_today));
report("음봉", rows.filter((r) => !r.bullish));

console.log("\n활성화 양봉에 조건을 더하면");
const activated = rows.filter((r) => r.bullish && r.broke_today && !r.broke_yesterday);

report("+ 거래량 2배 이상", activated.filter((r) => num(r.volume_ratio) >= 2));
report("+ 당일 5% 이상 상승", activated.filter((r) => num(r.day_move) >= 5));
report("+ 당일 10% 이상 상승", activated.filter((r) => num(r.day_move) >= 10));
report("+ 거래대금 500억 이상", activated.filter((r) => num(r.turnover) >= 5e10));

console.log("\n비교 - 상승률만 보고 사면");
report("당일 10% 이상 (돌파 무관)", rows.filter((r) => num(r.day_move) >= 10));
report("당일 20% 이상 (돌파 무관)", rows.filter((r) => num(r.day_move) >= 20));

/*
 * 수급 - 기관·외국인이 연속으로 사고 있었는가.
 *
 * kr_investor_flow는 종목당 하루 한 행으로 개인·외국인·기관 순매수를 담습니다.
 * 일봉보다 훨씬 짧아서(2026-07-07부터) 표본이 얇지만, 얇다는 것까지 같이 보고하면
 * 읽는 쪽이 스스로 판단할 수 있습니다.
 */
const flow = await query(config, `
  SELECT symbol, session_date::text AS d, foreign_amount, institution_amount,
         sum(CASE WHEN foreign_amount > 0 THEN 1 ELSE 0 END)
           OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS foreign_streak,
         sum(CASE WHEN institution_amount > 0 THEN 1 ELSE 0 END)
           OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS institution_streak
    FROM kr_investor_flow
`);
const flowBy = new Map(flow.rows.map((row) => [`${row.symbol}:${row.d}`, row]));
const withFlow = rows
  .map((row) => ({ ...row, flow: flowBy.get(`${row.symbol}:${row.d}`) }))
  .filter((row) => row.flow);
const activatedRow = (row) => row.bullish && row.broke_today && !row.broke_yesterday;

console.log(`
수급 조건 · kr_investor_flow와 겹치는 ${withFlow.length}건`);
report("겹치는 전체", withFlow);
report("외국인 당일 순매수", withFlow.filter((r) => num(r.flow.foreign_amount) > 0));
report("기관 당일 순매수", withFlow.filter((r) => num(r.flow.institution_amount) > 0));
report("외국인+기관 동시 순매수", withFlow.filter((r) => num(r.flow.foreign_amount) > 0 && num(r.flow.institution_amount) > 0));
report("외국인 3일 연속", withFlow.filter((r) => Number(r.flow.foreign_streak) === 3));
report("기관 3일 연속", withFlow.filter((r) => Number(r.flow.institution_streak) === 3));
report("둘 다 3일 연속", withFlow.filter((r) => Number(r.flow.foreign_streak) === 3 && Number(r.flow.institution_streak) === 3));
report("활성화 양봉 + 둘 다 순매수", withFlow.filter((r) => activatedRow(r) && num(r.flow.foreign_amount) > 0 && num(r.flow.institution_amount) > 0));

process.exit(0);
