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
 * 검증 대상은 웹에 공개된 종가베팅 기법들이 공통으로 말하는 조건입니다. 다행히
 * 대부분 반증 가능한 형태로 적혀 있어 그대로 옮길 수 있습니다.
 *
 *   활성화 양봉    중요한 고점을 막 돌파한 양봉만 사고, 이어가는 것은 사지 않는다
 *                 (머니스푼즈 <종가베팅 매매기법>)
 *   윗꼬리         "윗꼬리가 짧으면 짧을수록 좋다. 긴 윗꼬리는 장 막판에 미끄러진 것"
 *   이평선         5·7·10일선 지지, 20일선 눌림 후 거래량 터지며 반등
 *   역배열 회피    "캔들이 이평선 아래에 눌리는 역배열 모양은 반드시 회피"
 *   전고점 이격    "신고가 경신 또는 전고점과 이격이 좁은 종목"
 *   거래대금       "최근 거래일 대비 눈에 띄는 거래대금"
 *
 * 매도 시점은 출처들이 대체로 일치합니다 -- "시초가에서 1분 가량 매도, 9시 5분
 * 이내 전량". 그래서 여기 갭은 시초가 매도를 그대로 옮긴 값입니다.
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
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma5,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) AS ma10,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS history
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  scored AS (
    SELECT *,
           (next_open / close - 1) * 100 AS gap,
           (close / prev_close - 1) * 100 AS day_move,
           close > open AS bullish,
           close > prior_high AS broke_today,
           prev_close > prior_high_yesterday AS broke_yesterday,
           -- 윗꼬리 비율. 0이면 종가가 고가와 같다는 뜻이고, 1이면 고점에서
           -- 저점까지 미끄러진 것입니다.
           (high - close) / nullif(high - low, 0) AS upper_shadow,
           -- 몸통 비율. 장대양봉일수록 1에 가깝습니다.
           abs(close - open) / nullif(high - low, 0) AS body,
           -- 전고점과의 이격. 음수면 아직 아래, 0 근처면 "이격이 좁다"입니다.
           (close / nullif(prior_high, 0) - 1) * 100 AS gap_to_high,
           ma5 > ma10 AND ma10 > ma20 AS aligned,
           close > ma20 AS above_ma20,
           (low / nullif(ma20, 0) - 1) * 100 AS low_vs_ma20
      FROM bars
     WHERE next_open IS NOT NULL AND prev_close > 0 AND close > 0 AND high > low
       AND prior_high IS NOT NULL AND prior_high_yesterday IS NOT NULL
       AND history >= 20 AND close * volume >= $2
  ),
  nights AS (
    SELECT session_date, avg(gap) AS night_gap
      FROM scored GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT s.session_date::text AS d, s.symbol, s.gap, s.day_move, s.turnover,
         s.bullish, s.broke_today, s.broke_yesterday, s.upper_shadow, s.body,
         s.gap_to_high, s.aligned, s.above_ma20, s.low_vs_ma20,
         s.volume / nullif(s.avg_volume, 0) AS volume_ratio,
         s.gap - n.night_gap AS excess
    FROM scored s
    JOIN nights n ON n.session_date = s.session_date
`, [lookback, minTurnover]);

const num = (v) => (v === null ? null : Number(v));
const report = (label, list) => {
  if (list.length < 30) {
    console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 표본 부족`);

    return;
  }

  const excess = list.map((r) => num(r.excess));
  const gaps = list.map((r) => num(r.gap));
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const beat = excess.filter((x) => x > 0).length;
  const up = gaps.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 갭상승 ${String(Math.round((up / gaps.length) * 100)).padStart(3)}% · 밤평균 상회 ${String(Math.round((beat / excess.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

const activated = (r) => r.bullish && r.broke_today && !r.broke_yesterday;

console.log(`표본 ${rows.length}건 · 신고점 ${lookback}일 · 거래대금 ${(minTurnover / 1e8).toFixed(0)}억 이상`);
console.log(`밤 ${new Set(rows.map((r) => r.d)).size}개 · ${rows.reduce((a, r) => (r.d < a ? r.d : a), "9999")} ~ ${rows.reduce((a, r) => (r.d > a ? r.d : a), "0")}`);
console.log("\n기준선은 같은 밤의 평균 갭입니다. 초과가 0이면 그 조건은 밤만큼만 한 것입니다.\n");

report("전체", rows);

console.log("\n[1] 양봉 3분류 — 머니스푼즈");
report("2번 활성화 양봉 (돌파 직후)", rows.filter(activated));
report("3번 돌파 이어가기", rows.filter((r) => r.bullish && r.broke_today && r.broke_yesterday));
report("1번 박스권 양봉", rows.filter((r) => r.bullish && !r.broke_today));
report("음봉", rows.filter((r) => !r.bullish));

console.log("\n[2] 윗꼬리 — \"짧을수록 좋다\"");
report("윗꼬리 10% 미만 (종가≈고가)", rows.filter((r) => num(r.upper_shadow) < 0.1));
report("윗꼬리 10~30%", rows.filter((r) => num(r.upper_shadow) >= 0.1 && num(r.upper_shadow) < 0.3));
report("윗꼬리 30~50%", rows.filter((r) => num(r.upper_shadow) >= 0.3 && num(r.upper_shadow) < 0.5));
report("윗꼬리 50% 이상 (막판 미끄러짐)", rows.filter((r) => num(r.upper_shadow) >= 0.5));

console.log("\n[3] 장대양봉 — 몸통 비율");
report("몸통 70% 이상 + 양봉", rows.filter((r) => r.bullish && num(r.body) >= 0.7));
report("몸통 40% 미만 + 양봉", rows.filter((r) => r.bullish && num(r.body) < 0.4));

console.log("\n[4] 이평선");
report("정배열 (5>10>20)", rows.filter((r) => r.aligned));
report("역배열", rows.filter((r) => !r.aligned));
report("20일선 위", rows.filter((r) => r.above_ma20));
report("20일선 아래 (회피 대상)", rows.filter((r) => !r.above_ma20));
report("20일선 눌림 후 반등 (저가가 20일선 ±2%)", rows.filter((r) => r.bullish && Math.abs(num(r.low_vs_ma20)) <= 2 && num(r.day_move) > 0));

console.log("\n[5] 전고점 이격 — \"신고가 또는 이격이 좁은 종목\"");
report("전고점 돌파 (이격 > 0)", rows.filter((r) => num(r.gap_to_high) > 0));
report("전고점 −3% 이내", rows.filter((r) => num(r.gap_to_high) <= 0 && num(r.gap_to_high) >= -3));
report("전고점 −10% 아래", rows.filter((r) => num(r.gap_to_high) < -10));

console.log("\n[6] 거래대금·거래량");
report("거래량 2배 이상", rows.filter((r) => num(r.volume_ratio) >= 2));
report("거래량 5배 이상", rows.filter((r) => num(r.volume_ratio) >= 5));
report("거래대금 500억 이상", rows.filter((r) => num(r.turnover) >= 5e10));

console.log("\n[7] 상승률만 보고 사면");
report("당일 5% 이상", rows.filter((r) => num(r.day_move) >= 5));
report("당일 10% 이상", rows.filter((r) => num(r.day_move) >= 10));
report("당일 20% 이상", rows.filter((r) => num(r.day_move) >= 20));

console.log("\n[8] 조합 — 출처들이 함께 말하는 조건을 겹치면");
const clean = rows.filter((r) => activated(r) && num(r.upper_shadow) < 0.3 && r.aligned);

report("활성화+윗꼬리30%↓+정배열", clean);
report("  + 거래량 2배", clean.filter((r) => num(r.volume_ratio) >= 2));
report("  + 당일 10% 이상", clean.filter((r) => num(r.day_move) >= 10));
report("  + 거래대금 500억", clean.filter((r) => num(r.turnover) >= 5e10));

/*
 * 수급 - 기관·외국인이 연속으로 사고 있었는가.
 *
 * kr_investor_flow는 종목당 하루 한 행으로 개인·외국인·기관 순매수를 담습니다.
 * 일봉보다 훨씬 짧아서(2026-07-07부터) 표본이 얇습니다. 게다가 이 값은 16:10에
 * 정산돼 나오므로 15:30 종가에 살 때는 아직 존재하지 않습니다 - 종가 전에 볼 수
 * 있는 것은 장중 프로그램매매와 외국인 추정이고 둘 다 2026-08-21에 시작했습니다.
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

console.log(`\n[9] 수급 · 겹치는 ${withFlow.length}건 (2026-07-07~, 얇음)`);
report("겹치는 전체", withFlow);
report("기관 3일 연속 순매수", withFlow.filter((r) => Number(r.flow.institution_streak) === 3));
report("외국인 3일 연속 순매수", withFlow.filter((r) => Number(r.flow.foreign_streak) === 3));
report("둘 다 3일 연속", withFlow.filter((r) => Number(r.flow.foreign_streak) === 3 && Number(r.flow.institution_streak) === 3));

process.exit(0);
