import { limitPairSql, limitPairTiers } from "../src/providers/limit-pair.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 짝꿍매매 등급별 실측 성적을 다시 계산해 표에 씁니다.
 *
 * 후보를 뽑는 SQL과 성적을 재는 SQL이 같은 문자열입니다. 갈라지면 화면의 숫자가
 * 화면의 목록을 설명하지 못하게 됩니다.
 *
 * 재는 값은 갭이 아니라 그날 시장 평균 갭 대비 초과분입니다. 시장 전체가 갭상승하는
 * 밤에는 아무거나 사도 오르고, 그건 짝꿍 규칙의 공이 아닙니다.
 *
 *   npm run kr:limit-pair
 */

const config = readConfig();
const started = Date.now();

// 후보를 하루씩 뽑는 대신 전 기간을 한 번에 훑습니다. limitPairSql은 하루를 받으므로
// 날짜 조건만 바꿔 끼웁니다 -- 조건 자체는 한 글자도 다르지 않습니다.
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

console.log(`짝꿍 후보 ${rows.length}건 · 밤 ${new Set(rows.map((r) => r.d)).size}개`);

const from = rows.reduce((a, r) => (r.d < a ? r.d : a), "9999-99-99");
const to = rows.reduce((a, r) => (r.d > a ? r.d : a), "0000-00-00");
let written = 0;

for (const { locked, maxLeadGap, tier } of limitPairTiers) {
  const lower = limitPairTiers
    .filter((entry) => entry.locked && entry.maxLeadGap !== null && (maxLeadGap === null || entry.maxLeadGap < maxLeadGap))
    .reduce((widest, entry) => Math.max(widest, entry.maxLeadGap), 0);
  const list = rows.filter((r) => {
    const gap = Number(r.lead_gap);
    const isLocked = Number(r.leader_move) >= 29;

    if (isLocked !== locked) return false;
    if (!locked) return true;

    return gap > lower && (maxLeadGap === null || gap <= maxLeadGap);
  });

  if (list.length < 100) {
    console.log(`  ${tier} · ${list.length}건 · 표본 부족, 쓰지 않습니다`);
    continue;
  }

  const excess = list.map((r) => Number(r.excess));
  const holds = list.map((r) => Number(r.hold_excess));
  const gaps = list.map((r) => Number(r.raw_gap));
  const excessMean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const holdMean = holds.reduce((a, b) => a + b, 0) / holds.length;
  const beatRate = excess.filter((x) => x > 0).length / excess.length;
  const gapUpRate = gaps.filter((x) => x > 0).length / gaps.length;
  const nights = new Set(list.map((r) => r.d)).size;

  await query(config, `
    INSERT INTO kr_limit_pair_calibration
      (tier, min_leader_move, min_second_move, max_lead_gap, samples, nights,
       beat_rate, excess_mean, gap_up_rate, hold_excess_mean, calibrated_from, calibrated_to)
    VALUES ($1, $11, 15, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date)
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
  `, [tier, maxLeadGap, list.length, nights, beatRate.toFixed(4), excessMean.toFixed(4),
    gapUpRate.toFixed(4), holdMean.toFixed(4), from, to, locked ? 29 : 27]);

  written += 1;
  console.log(`  ${tier}${locked ? ` (간격 ${lower}~${maxLeadGap ?? "∞"}%p)` : " (27~29%)"} · ${list.length}건 · ${nights}밤 · 상회 ${Math.round(beatRate * 100)}% · 갭상승 ${Math.round(gapUpRate * 100)}% · 초과 ${excessMean >= 0 ? "+" : ""}${excessMean.toFixed(3)}%p · 하루보유 ${holdMean >= 0 ? "+" : ""}${holdMean.toFixed(3)}%p`);
}

console.log(`\n${written}개 등급 기록 · ${from} ~ ${to} · ${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
