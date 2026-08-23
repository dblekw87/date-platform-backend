import { loadNightTriggers } from "./night-triggers.mjs";
import { query } from "../db/client.mjs";

/**
 * 짝꿍매매 — 같은 테마 1등주가 상한가에 잠겼을 때의 2등주.
 *
 * 메커니즘이 상한가에 있습니다. 상한가는 더 높은 값에 거래가 안 되는 상태라, 그
 * 종목을 사려던 수요가 갈 곳을 잃고 같은 테마의 다음 종목으로 넘칩니다. 미국에서
 * 같은 매매가 성립하지 않은 이유도 같습니다 -- 가격제한폭이 없으면 수요가 그 종목
 * 안에서 소화됩니다.
 *
 * 99,108개 테마-일을 396개 장에 걸쳐 재서 나온 조건입니다. 전부 그날 시장 평균 갭
 * 대비 초과분입니다.
 *
 *   1등주 상한가 & 2등주 15%↑   2,260건   +2.305%p   상회 57%
 *   1등주 20~29% & 2등주 15%↑     843건   -0.031%p   상회 45%
 *
 * 상한가를 찍어야만 값이 있습니다. 20%대 후반까지 갔다가 못 잠긴 날은 0입니다.
 *
 * 세 가지가 예전 짝꿍 패널과 다릅니다.
 *
 *   순위를 거래대금이 아니라 **상승률**로 매깁니다. 짝꿍은 돈이 몰린 순서가 아니라
 *   오른 순서의 문제입니다.
 *
 *   2등주도 달리고 있어야 합니다. 상한가인 날에도 2등주가 5% 미만이면 -0.045%p,
 *   10% 이상이면 +1.753%p입니다. 뒤처진 종목이 따라오는 매매가 아닙니다.
 *
 *   간격은 **좁을수록** 좋습니다. 둘 다 15%↑일 때 간격 0~2%p가 +3.778%p에 상회
 *   64%이고 2~5%p는 -0.026%p입니다. 예전 패널은 넓은 순으로 정렬했습니다.
 *
 * 짝은 **공유하는 테마가 하나라도 있으면** 성립합니다. 종목마다 대표 테마 하나를
 * 붙이는 classifyTheme으로는 안 됩니다 -- 우리기술은 원전주인데 편입 중 theme_no가
 * 가장 낮은 것이 방위산업이라 대표 라벨이 그쪽으로 잡히고, 그러면 한전산업이
 * 상한가를 가도 같은 테마로 묶이지 않습니다. 여기서는 kr_theme_members를 통째로
 * 씁니다.
 */

// 국내 가격제한폭은 ±30%입니다. 잠긴 것은 +29% 위로 보고, 그 아래 27%까지를
// "근접"으로 함께 냅니다 -- 실제 매매가 상한가와 그 근처를 같이 보기 때문입니다.
//
// 경계가 27인 것은 측정입니다(2등주 15%↑ 조건):
//
//   1등주 20~25%   571건   -0.240%p   상회 42%
//   1등주 25~27%   166건   +0.170%p   상회 48%
//   1등주 27~29%   106건   +0.776%p   상회 58%
//   1등주 29%↑   2,257건   +2.322%p   상회 56%
//
// 25~27%는 사실상 0이고 그 아래는 마이너스입니다. 근접이라도 27%는 넘어야 합니다.
const limitUpMove = 29;
const nearLimitMove = 27;

// 2등주가 이만큼은 달리고 있어야 합니다.
const minimumSecondMove = 15;

// 호가 한 칸에 갭이 튀는 종목은 후보가 될 수 없습니다.
const minimumTurnover = 500_000_000;

/**
 * 상승률 1·2위를 테마별로 뽑는 SQL. 캘리브레이션과 화면이 같은 문자열을 씁니다 --
 * 갈라지면 행에 붙은 숫자가 그 행을 뽑은 규칙을 설명하지 못하게 됩니다.
 *
 * $1은 기준일입니다.
 */
/**
 * 하루치를 물을 때는 일봉 스캔을 그 하루 언저리로 줄입니다.
 *
 * 창이 `lag(close)` 하나라 직전 영업일만 있으면 답이 같습니다. 경계를 안 주면
 * 147만 행 전체에 창을 돌리고 4천 행만 씁니다 -- 2.6초 중 2.3초가 그것이었습니다.
 * 연휴를 감안해 10일을 봅니다.
 *
 * 캘리브레이션은 전 기간을 한 번에 훑으므로 경계도 날짜 필터도 없이 부릅니다.
 * 조건 정의는 한 문자열에 그대로 남습니다.
 */
export function limitPairSql({ oneDay = false } = {}) {
  const scanBound = oneDay ? "WHERE b.session_date BETWEEN $1::date - 10 AND $1::date" : "";
  const dayFilter = oneDay ? "session_date = $1::date AND" : "";

  return `
  WITH members AS (
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_members
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)'
  ),
  moves AS (
    SELECT b.symbol, b.session_date, b.close, b.close * b.volume AS turnover,
           (b.close / lag(b.close) OVER (PARTITION BY b.symbol ORDER BY b.session_date) - 1) * 100 AS day_move
      FROM kr_daily_bars b
      ${scanBound}
  ),
  today AS (
    SELECT * FROM moves
     WHERE ${dayFilter} day_move IS NOT NULL AND turnover >= ${minimumTurnover}
  ),
  ranked AS (
    -- 날짜로도 나눠야 합니다. 테마로만 나누면 하루치를 볼 때는 맞지만, 캘리브레이션이
    -- 전 기간을 한 번에 훑을 때 테마당 하루만 1등이 되어 표본이 247건으로 줄어듭니다.
    -- 동률일 때 순서를 못 박습니다. 상승률만으로 정렬하면 같은 상승률 두 종목의
    -- 1등·2등이 실행할 때마다 바뀌어, 새로고침만 해도 패널의 1등주가 뒤집힙니다.
    SELECT t.*, m.theme_name,
           row_number() OVER (PARTITION BY m.theme_name, t.session_date
                              ORDER BY t.day_move DESC, t.turnover DESC, t.symbol) AS move_rank
      FROM today t
      JOIN members m ON m.symbol = t.symbol
  )
  -- 매매 하나에 행 하나입니다.
  --
  -- 짝은 테마마다 따로 나오는데 두 종목이 테마를 여러 개 공유하는 일이 흔합니다 --
  -- 하림지주→마니커는 육계·사료·여름·구제역·스포츠행사로 하루에 다섯 번 나왔습니다.
  -- 사는 것은 같은 날 같은 2등주 하나인데 성적표에는 다섯 번 들어가서, 표본이 24%
  -- 부풀고(2,369 → 1,806) 테마를 많이 단 축산·바이오 쪽으로 가중치가 쏠렸습니다.
  --
  -- 남기는 것은 간격이 가장 좁은 짝입니다. 화면이 이미 그 행을 골라 보여주고
  -- 있으므로(간격 오름차순, 2등주 기준 중복 제거), 성적을 재는 행과 화면에 뜨는
  -- 행이 같아집니다.
  SELECT DISTINCT ON (l.session_date, s.symbol)
         l.session_date, l.theme_name,
         l.symbol AS leader_symbol, l.day_move AS leader_move, l.turnover AS leader_turnover,
         s.symbol AS second_symbol, s.day_move AS second_move, s.turnover AS second_turnover,
         s.close AS second_close,
         l.day_move - s.day_move AS lead_gap
    FROM ranked l
    JOIN ranked s ON s.theme_name = l.theme_name AND s.session_date = l.session_date AND s.move_rank = 2
   WHERE l.move_rank = 1
     AND l.day_move >= ${nearLimitMove}
     AND s.day_move >= ${minimumSecondMove}
   ORDER BY l.session_date, s.symbol, l.day_move - s.day_move, l.day_move DESC, l.symbol
`;
}

/**
 * 등급은 두 축입니다 -- 1등주가 잠겼는가, 그리고 둘이 얼마나 붙어 있는가.
 *
 * 잠기지 않은 근접(27~29%)은 잠긴 것의 1/3이라 간격으로 더 나누지 않고 하나로
 * 둡니다. 표본도 106건뿐입니다.
 */
export const limitPairTiers = [
  { locked: true, maxLeadGap: 2, tier: "상한가·밀착" },
  { locked: true, maxLeadGap: 5, tier: "상한가·근접" },
  { locked: true, maxLeadGap: null, tier: "상한가·여유" },
  { locked: false, maxLeadGap: null, tier: "상한가 근접" }
];

export function limitPairTierFor(leadGap, locked) {
  if (!locked) return "상한가 근접";

  return limitPairTiers.find((entry) => entry.locked && (entry.maxLeadGap === null || leadGap <= entry.maxLeadGap))?.tier ?? "상한가·여유";
}

async function loadCalibration(config) {
  const result = await query(
    config,
    `SELECT tier, samples, nights, beat_rate, excess_mean, gap_up_rate, hold_excess_mean,
            calibrated_from::text, calibrated_to::text
       FROM kr_limit_pair_calibration`
  );

  return new Map(result.rows.map((row) => [row.tier, {
    beatRate: Number(row.beat_rate),
    calibratedFrom: row.calibrated_from,
    calibratedTo: row.calibrated_to,
    excessMean: Number(row.excess_mean),
    gapUpRate: Number(row.gap_up_rate),
    holdExcessMean: Number(row.hold_excess_mean),
    nights: Number(row.nights),
    samples: Number(row.samples)
  }]));
}

/**
 * 장중 후보 -- 분봉에서, 캔들이 닫히기 전에.
 *
 * 짝꿍매매는 스캘핑에 가깝습니다. 1등주가 상한가에 잠기는 그 순간에 2등주를 잡는
 * 것이라, 일봉으로 계산하면 후보가 15:50에야 생기고 그때는 이미 끝난 자리입니다.
 * 목록이 장중 내내 살아 있어야 하고 몇 분 단위로 바뀌는 것이 정상입니다.
 *
 * 그래서 같은 조건을 분봉으로 계산합니다. 상한가 판정은 등락률이라 그대로 되고,
 * 순위도 등락률이라 그대로 됩니다 -- 일봉이 필요한 곳은 없습니다.
 *
 * 모집단은 분봉이 닿는 종목입니다. 상한가 종목은 거의 항상 순위에 들어오므로
 * 1등주는 안전하지만, 2등주가 순위 밖일 수 있습니다.
 */
const livePairSql = `
  WITH members AS (
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_members
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)'
  ),
  today AS (
    SELECT DISTINCT ON (symbol) symbol, name, change_rate AS day_move, turnover, market_cap, observed_at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date
       AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
       AND turnover >= ${minimumTurnover}
     ORDER BY symbol, observed_at DESC
  ),
  ranked AS (
    SELECT t.*, m.theme_name,
           row_number() OVER (PARTITION BY m.theme_name ORDER BY t.day_move DESC) AS move_rank
      FROM today t
      JOIN members m ON m.symbol = t.symbol
  )
  SELECT l.theme_name, l.observed_at,
         l.symbol AS leader_symbol, l.name AS leader_name, l.day_move AS leader_move,
         l.turnover AS leader_turnover,
         s.symbol AS second_symbol, s.name AS second_name, s.day_move AS second_move,
         s.turnover AS second_turnover, s.market_cap,
         l.day_move - s.day_move AS lead_gap
    FROM ranked l
    JOIN ranked s ON s.theme_name = l.theme_name AND s.move_rank = 2
   WHERE l.move_rank = 1
     AND l.day_move >= ${nearLimitMove}
     AND s.day_move >= ${minimumSecondMove}
   ORDER BY l.day_move - s.day_move ASC
`;

/**
 * 오늘의 짝꿍 후보. 성적표가 없으면 빈 목록입니다 -- 숫자 없이 종목만 내놓는 것이
 * 이 화면이 하지 않기로 한 일입니다.
 *
 * 오늘 분봉이 있으면 그것으로, 없으면(주말·개장 전) 마지막 장의 일봉으로 답합니다.
 *
 * 같은 2등주가 여러 테마에서 걸릴 수 있습니다(우리기술은 원전·풍력·방산에 동시
 * 편입). 가장 좁은 간격 하나만 남깁니다 -- 같은 종목을 세 번 보여주는 것은 후보가
 * 셋이라는 뜻으로 읽힙니다.
 */
export async function loadLimitPairCandidates(config, { limit = 10, sessionDate } = {}) {
  if (!config.databaseUrl) return [];

  const calibration = await loadCalibration(config).catch(() => new Map());

  if (calibration.size === 0) return [];

  const barDay = (await query(config, "SELECT max(session_date)::text AS day FROM kr_daily_bars")).rows[0]?.day;
  const sampleDay = sessionDate ?? (await query(
    config,
    "SELECT max(session_date)::text AS day FROM market_price_samples WHERE market = 'KR' AND source LIKE 'kis:krx%'"
  )).rows[0]?.day;
  // 오늘 봉이 아직 없으면 장중입니다.
  const live = Boolean(sampleDay && barDay && sampleDay > barDay);
  const day = live ? sampleDay : barDay;

  if (!day) return [];

  const result = live
    ? await query(config, livePairSql, [day])
    : await query(config, `
      WITH pairs AS (${limitPairSql({ oneDay: true })})
      SELECT p.*, u.name AS second_name, lu.name AS leader_name, u.market, u.market_cap, u.trade_halted
        FROM pairs p
        LEFT JOIN kr_daily_universe u ON u.symbol = p.second_symbol AND u.session_date = $1::date
        LEFT JOIN kr_daily_universe lu ON lu.symbol = p.leader_symbol AND lu.session_date = $1::date
       ORDER BY p.lead_gap ASC
    `, [day]);
  const seen = new Set();
  const shown = result.rows
    .filter((row) => !row.trade_halted)
    .filter((row) => {
      if (seen.has(row.second_symbol)) return false;

      seen.add(row.second_symbol);

      return true;
    })
    .slice(0, limit);
  // 짝꿍은 2등주를 삽니다. 밤 지표도 2등주 것을 봅니다.
  const nightTriggers = await loadNightTriggers(config, shown.map((row) => row.second_symbol));

  return shown
    .map((row) => {
      const leadGap = Number(Number(row.lead_gap).toFixed(2));
      const locked = Number(row.leader_move) >= limitUpMove;
      const tier = limitPairTierFor(leadGap, locked);
      const measured = calibration.get(tier);

      return {
        id: `limit-pair-${row.second_symbol}`,
        leadGap,
        leader: {
          changeRateValue: Number(Number(row.leader_move).toFixed(2)),
          name: row.leader_name ?? row.leader_symbol,
          symbol: row.leader_symbol,
          turnoverValue: Number(row.leader_turnover)
        },
        market: row.market ?? "KR",
        marketCapValue: row.market_cap === null ? null : Number(row.market_cap),
        measured: measured
          ? {
            beatRate: measured.beatRate,
            excessMean: measured.excessMean,
            gapUpRate: measured.gapUpRate,
            holdExcessMean: measured.holdExcessMean,
            nights: measured.nights,
            samples: measured.samples,
            window: `${measured.calibratedFrom} ~ ${measured.calibratedTo}`
          }
          : null,
        // 짝꿍도 밤을 넘기는 매매입니다. 2등주의 테마에 맞는 미국 지표를 답니다.
        nightTrigger: nightTriggers.get(row.second_symbol) ?? null,
        second: {
          changeRateValue: Number(Number(row.second_move).toFixed(2)),
          closePrice: Number(row.second_close),
          name: row.second_name ?? row.second_symbol,
          symbol: row.second_symbol,
          turnoverValue: Number(row.second_turnover)
        },
        // 장중 값은 잠정입니다. 1등주가 상한가에서 풀릴 수도, 2등주가 더 갈 수도
        // 있어서 목록이 몇 분 만에 바뀝니다.
        observedAt: row.observed_at ? new Date(row.observed_at).toISOString() : null,
        provisional: live,
        // 잠긴 것과 근접한 것은 성적이 세 배 차이라 화면이 구분해야 합니다.
        locked,
        sessionDate: day,
        theme: row.theme_name,
        tier
      };
    });
}
