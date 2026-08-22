import { query } from "../db/client.mjs";

/**
 * 종가배팅 후보 — 오늘 종가에 사서 내일 시가에 팔 만한 자리.
 *
 * 조건은 추측이 아니라 scripts/measure-close-bet.mjs가 50만 종목-밤에서 남긴
 * 것입니다. 각 항목을 하나씩 빼서 값을 더하는지 확인했습니다.
 *
 *   활성화 양봉   60일 고점을 **오늘** 돌파한 양봉. 어제 이미 위였으면 아닙니다
 *   윗꼬리 30%↓   종가가 고가 근처. 긴 윗꼬리는 장 막판에 미끄러진 것입니다
 *   당일 10%↑     가장 큰 기여. 빼면 초과가 2.215 → 0.502%p로 무너집니다
 *   거래량 2배↑    20일 평균 대비
 *
 * 정배열(5>10>20)은 넣지 않았습니다. 넣으나 빼나 초과가 같은데 후보만 29% 줄고,
 * 단독으로는 50만 표본에서 +0.009%p로 0입니다.
 *
 * 밤은 예측하지 않습니다. 예측할 수도 없습니다 -- 미국과 이란이 전쟁을 하면
 * 코스피는 다 떨어지고 어느 종목을 골랐든 마찬가지입니다. 그래서 화면에 나가는
 * 숫자는 갭이 아니라 **그날 밤 평균 대비 초과분**이고, 나스닥 선물은 옆에 맥락으로
 * 두되 이 숫자에 섞지 않습니다. 섞으면 못 맞히는 것을 맞히는 척하게 됩니다.
 */

// 60거래일 = 약 3개월. "중요한 고점"의 조작적 정의입니다.
const lookback = 60;

// 하루 거래대금 10억 미만은 갭이 호가 한 칸에도 튀어서 후보가 될 수 없습니다.
const minimumTurnover = 1_000_000_000;

const minimumDayMove = 10;
const minimumVolumeRatio = 2;
const maximumUpperShadow = 0.3;

/**
 * 등급 문턱. 위로 갈수록 후보가 줄고 초과가 커집니다 -- 측정값은
 * kr_close_bet_calibration에 있고, 여기에는 경계만 둡니다.
 */
export const closeBetTiers = [
  { minDayMove: 20, tier: "강" },
  { minDayMove: 15, tier: "중" },
  { minDayMove: minimumDayMove, tier: "약" }
];

function tierFor(dayMove) {
  return closeBetTiers.find((entry) => dayMove >= entry.minDayMove)?.tier ?? "약";
}

/**
 * 조건을 만족한 하루치를 뽑는 SQL.
 *
 * `session` 이 주어지면 그날, 없으면 가장 최근 거래일입니다. 같은 쿼리를 캘리브레이션이
 * 과거 전체에 대해서도 돌리므로 조건 정의가 두 곳에 갈라지지 않습니다.
 */
export const closeBetCandidateSql = `
  WITH bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN ${lookback} PRECEDING AND 1 PRECEDING) AS prior_high,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN ${lookback + 1} PRECEDING AND 2 PRECEDING) AS prior_high_yesterday,
           avg(volume) OVER (PARTITION BY symbol ORDER BY session_date
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date
                          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS history
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  )
  SELECT symbol, session_date, open, high, low, close, volume, turnover, prior_high,
         next_open,
         (close / prev_close - 1) * 100 AS day_move,
         (high - close) / nullif(high - low, 0) AS upper_shadow,
         volume / nullif(avg_volume, 0) AS volume_ratio,
         (close / nullif(prior_high, 0) - 1) * 100 AS break_margin
    FROM bars
   WHERE prev_close > 0 AND close > 0 AND high > low AND history >= 20
     AND prior_high IS NOT NULL AND prior_high_yesterday IS NOT NULL
     AND close * volume >= ${minimumTurnover}
     AND close > open
     AND close > prior_high
     AND prev_close <= prior_high_yesterday
     AND (high - close) / nullif(high - low, 0) < ${maximumUpperShadow}
     AND (close / prev_close - 1) * 100 >= ${minimumDayMove}
     AND volume / nullif(avg_volume, 0) >= ${minimumVolumeRatio}
`;

async function loadCalibration(config) {
  const result = await query(
    config,
    "SELECT tier, samples, nights, beat_rate, excess_mean, gap_up_rate, calibrated_from::text, calibrated_to::text FROM kr_close_bet_calibration"
  );

  return new Map(result.rows.map((row) => [row.tier, {
    beatRate: Number(row.beat_rate),
    calibratedFrom: row.calibrated_from,
    calibratedTo: row.calibrated_to,
    excessMean: Number(row.excess_mean),
    gapUpRate: Number(row.gap_up_rate),
    nights: Number(row.nights),
    samples: Number(row.samples)
  }]));
}

/**
 * 오늘의 후보. 캘리브레이션이 없으면 빈 목록을 돌려줍니다 -- 성적표 없이 종목만
 * 내놓는 것이 이 화면이 하지 않기로 한 일입니다.
 */
export async function loadCloseBetCandidates(config, { limit = 12 } = {}) {
  if (!config.databaseUrl) return [];

  const calibration = await loadCalibration(config).catch(() => new Map());

  if (calibration.size === 0) return [];

  const result = await query(config, `
    WITH candidates AS (${closeBetCandidateSql})
    SELECT c.*, u.name, u.market, u.market_cap, u.trade_halted
      FROM candidates c
      LEFT JOIN kr_daily_universe u
        ON u.symbol = c.symbol AND u.session_date = c.session_date
     WHERE c.session_date = (SELECT max(session_date) FROM kr_daily_bars)
     ORDER BY c.turnover DESC
     LIMIT $1
  `, [limit]);

  return result.rows
    // 거래정지된 종목은 살 수 없습니다. 조건은 어제 만족했을 수 있어도 후보가
    // 아닙니다.
    .filter((row) => !row.trade_halted)
    .map((row) => {
      const dayMove = Number(row.day_move);
      const tier = tierFor(dayMove);
      const measured = calibration.get(tier);

      return {
        breakMargin: Number(Number(row.break_margin).toFixed(2)),
        changeRateValue: Number(dayMove.toFixed(2)),
        closePrice: Number(row.close),
        id: `close-bet-${row.symbol}`,
        market: row.market ?? "KR",
        marketCapValue: row.market_cap === null ? null : Number(row.market_cap),
        measured: measured
          ? {
            beatRate: measured.beatRate,
            excessMean: measured.excessMean,
            gapUpRate: measured.gapUpRate,
            nights: measured.nights,
            samples: measured.samples,
            window: `${measured.calibratedFrom} ~ ${measured.calibratedTo}`
          }
          : null,
        name: row.name ?? row.symbol,
        sessionDate: String(row.session_date).slice(0, 10),
        symbol: row.symbol,
        tier,
        turnoverValue: Number(row.turnover),
        upperShadow: Number(Number(row.upper_shadow).toFixed(3)),
        volumeRatio: Number(Number(row.volume_ratio).toFixed(2))
      };
    });
}
