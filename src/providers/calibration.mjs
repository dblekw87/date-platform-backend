import { closeBetCandidateSql, closeBetTiers } from "./close-bet.mjs";
import { limitPairSql, limitPairTiers } from "./limit-pair.mjs";
import { query } from "../db/client.mjs";

/**
 * 후보 화면들의 성적표를 다시 계산합니다.
 *
 * 스크립트와 수집기가 같은 함수를 부릅니다. 스크립트에만 있으면 손으로 돌리지 않는
 * 한 표본이 만들어진 날에 멈춰 있고, 화면은 몇 달 전 숫자를 오늘의 근거인 것처럼
 * 답하게 됩니다. 하루가 지나면 하루치가 늘어야 합니다.
 *
 * 후보를 뽑는 SQL과 성적을 재는 SQL이 같은 문자열이라는 원칙은 그대로입니다 --
 * 갈라지면 행에 붙은 숫자가 그 행을 뽑은 규칙을 설명하지 못합니다.
 */

// 등급 하나가 이보다 얇으면 쓰지 않습니다. 표본 스무 건짜리 확률은 확률이 아닙니다.
const minimumSamples = 100;

function summarise(list, pick) {
  const excess = list.map((row) => Number(row.excess));
  const gaps = list.map((row) => Number(row.raw_gap ?? row.gap));

  return {
    beatRate: excess.filter((value) => value > 0).length / excess.length,
    excessMean: excess.reduce((a, b) => a + b, 0) / excess.length,
    gapUpRate: gaps.filter((value) => value > 0).length / gaps.length,
    holdMean: pick ? list.map(pick).reduce((a, b) => a + b, 0) / list.length : 0,
    nights: new Set(list.map((row) => row.d)).size
  };
}

function span(rows) {
  return {
    from: rows.reduce((earliest, row) => (row.d < earliest ? row.d : earliest), "9999-99-99"),
    to: rows.reduce((latest, row) => (row.d > latest ? row.d : latest), "0000-00-00")
  };
}

/**
 * 종가배팅 — 등급은 규모입니다.
 */
export async function calibrateCloseBet(config, { log = () => {} } = {}) {
  const { rows } = await query(config, `
    WITH candidates AS (${closeBetCandidateSql}),
    universe AS (
      SELECT symbol, session_date, close,
             lead(open) OVER (PARTITION BY symbol ORDER BY session_date) AS next_open
        FROM kr_daily_bars
    ),
    nights AS (
      SELECT session_date, avg((next_open / close - 1) * 100) AS night_gap
        FROM universe
       WHERE next_open IS NOT NULL AND close > 0
       GROUP BY session_date
      HAVING count(*) >= 50
    )
    SELECT c.session_date::text AS d, c.size_label,
           (c.next_open / c.close - 1) * 100 AS gap,
           (c.next_open / c.close - 1) * 100 - n.night_gap AS excess
      FROM candidates c
      JOIN nights n ON n.session_date = c.session_date
     WHERE c.next_open IS NOT NULL
  `);
  const { from, to } = span(rows);
  let written = 0;

  for (const { tier } of closeBetTiers) {
    const list = rows.filter((row) => row.size_label === tier);

    if (list.length < minimumSamples) continue;

    const stats = summarise(list);

    await query(config, `
      INSERT INTO kr_close_bet_calibration
        (tier, min_day_move, samples, nights, beat_rate, excess_mean, gap_up_rate, calibrated_from, calibrated_to)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7::date, $8::date)
      ON CONFLICT (tier) DO UPDATE SET
        beat_rate = EXCLUDED.beat_rate,
        calibrated_from = EXCLUDED.calibrated_from,
        calibrated_to = EXCLUDED.calibrated_to,
        excess_mean = EXCLUDED.excess_mean,
        gap_up_rate = EXCLUDED.gap_up_rate,
        nights = EXCLUDED.nights,
        samples = EXCLUDED.samples,
        updated_at = now()
    `, [tier, list.length, stats.nights, stats.beatRate.toFixed(4), stats.excessMean.toFixed(4),
      stats.gapUpRate.toFixed(4), from, to]);

    written += 1;
    log(`close bet · ${tier} · ${list.length}건 · 상회 ${Math.round(stats.beatRate * 100)}% · 초과 ${stats.excessMean.toFixed(3)}%p`);
  }

  return { tiers: written, total: rows.length };
}

/**
 * 짝꿍매매 — 등급은 잠겼는가와 간격입니다.
 */
export async function calibrateLimitPair(config, { log = () => {} } = {}) {
  const allDaysSql = limitPairSql.replace("session_date = $1::date AND", "");
  const { rows } = await query(config, `
    WITH pairs AS (${allDaysSql}),
    bars AS (
      SELECT symbol, session_date, close,
             lead(open) OVER w AS next_open,
             lead(close) OVER w AS next_close
        FROM kr_daily_bars
       WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
    ),
    outcomes AS (
      SELECT symbol, session_date,
             (next_open / close - 1) * 100 AS gap,
             (next_close / close - 1) * 100 AS hold
        FROM bars WHERE close > 0 AND next_open IS NOT NULL AND next_close IS NOT NULL
    ),
    nights AS (
      SELECT session_date, avg(gap) AS market_gap, avg(hold) AS market_hold
        FROM outcomes GROUP BY session_date HAVING count(*) >= 50
    )
    SELECT p.session_date::text AS d, p.lead_gap, p.leader_move,
           o.gap - n.market_gap AS excess,
           o.hold - n.market_hold AS hold_excess,
           o.gap AS raw_gap
      FROM pairs p
      JOIN outcomes o ON o.symbol = p.second_symbol AND o.session_date = p.session_date
      JOIN nights n ON n.session_date = p.session_date
  `);
  const { from, to } = span(rows);
  let written = 0;

  for (const { locked, maxLeadGap, tier } of limitPairTiers) {
    const lower = limitPairTiers
      .filter((entry) => entry.locked && entry.maxLeadGap !== null && (maxLeadGap === null || entry.maxLeadGap < maxLeadGap))
      .reduce((widest, entry) => Math.max(widest, entry.maxLeadGap), 0);
    const list = rows.filter((row) => {
      const isLocked = Number(row.leader_move) >= 29;

      if (isLocked !== locked) return false;
      if (!locked) return true;

      const gap = Number(row.lead_gap);

      return gap > lower && (maxLeadGap === null || gap <= maxLeadGap);
    });

    if (list.length < minimumSamples) continue;

    const stats = summarise(list, (row) => Number(row.hold_excess));

    await query(config, `
      INSERT INTO kr_limit_pair_calibration
        (tier, min_leader_move, min_second_move, max_lead_gap, samples, nights,
         beat_rate, excess_mean, gap_up_rate, hold_excess_mean, calibrated_from, calibrated_to)
      VALUES ($1, $2, 15, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date)
      ON CONFLICT (tier) DO UPDATE SET
        beat_rate = EXCLUDED.beat_rate,
        calibrated_from = EXCLUDED.calibrated_from,
        calibrated_to = EXCLUDED.calibrated_to,
        excess_mean = EXCLUDED.excess_mean,
        gap_up_rate = EXCLUDED.gap_up_rate,
        hold_excess_mean = EXCLUDED.hold_excess_mean,
        max_lead_gap = EXCLUDED.max_lead_gap,
        nights = EXCLUDED.nights,
        samples = EXCLUDED.samples,
        updated_at = now()
    `, [tier, locked ? 29 : 27, maxLeadGap, list.length, stats.nights, stats.beatRate.toFixed(4),
      stats.excessMean.toFixed(4), stats.gapUpRate.toFixed(4), stats.holdMean.toFixed(4), from, to]);

    written += 1;
    log(`limit pair · ${tier} · ${list.length}건 · 상회 ${Math.round(stats.beatRate * 100)}% · 초과 ${stats.excessMean.toFixed(3)}%p`);
  }

  return { tiers: written, total: rows.length };
}
