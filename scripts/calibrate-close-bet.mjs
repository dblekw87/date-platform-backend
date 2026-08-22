import { readConfig } from "../src/config.mjs";
import { closeBetCandidateSql, closeBetTiers } from "../src/providers/close-bet.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅 등급별 실측 성적을 다시 계산해 표에 씁니다.
 *
 * 후보를 뽑는 조건과 성적을 재는 조건이 같은 SQL에서 나옵니다 -- 갈라지면 화면의
 * 숫자가 화면의 목록을 설명하지 못하게 됩니다.
 *
 * 재는 값은 갭이 아니라 그날 밤 시장 평균 갭 대비 초과분입니다. 밤이 갭의 대부분을
 * 정하므로, 절대값으로 재면 조건이 아니라 그 조건이 우연히 많이 걸린 밤을 재게 됩니다.
 *
 *   npm run kr:close-bet
 */

const config = readConfig();
const started = Date.now();

const { rows } = await query(config, `
  WITH candidates AS (${closeBetCandidateSql}),
  universe AS (
    SELECT symbol, session_date,
           lead(open) OVER (PARTITION BY symbol ORDER BY session_date) AS next_open,
           close
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
         (c.day_move) AS day_move,
         (c.next_open / c.close - 1) * 100 AS gap,
         (c.next_open / c.close - 1) * 100 - n.night_gap AS excess
    FROM candidates c
    JOIN nights n ON n.session_date = c.session_date
   WHERE c.next_open IS NOT NULL
`);

console.log(`후보 ${rows.length}건 · 밤 ${new Set(rows.map((r) => r.d)).size}개`);

const from = rows.reduce((a, r) => (r.d < a ? r.d : a), "9999-99-99");
const to = rows.reduce((a, r) => (r.d > a ? r.d : a), "0000-00-00");
let written = 0;

for (const { tier } of closeBetTiers) {
  const list = rows.filter((r) => r.size_label === tier);

  if (list.length < 100) {
    console.log(`  ${tier} · ${list.length}건 · 표본 부족, 쓰지 않습니다`);
    continue;
  }

  const excess = list.map((r) => Number(r.excess));
  const gaps = list.map((r) => Number(r.gap));
  const excessMean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const beatRate = excess.filter((x) => x > 0).length / excess.length;
  const gapUpRate = gaps.filter((x) => x > 0).length / gaps.length;
  const nights = new Set(list.map((r) => r.d)).size;

  await query(config, `
    INSERT INTO kr_close_bet_calibration
      (tier, min_day_move, samples, nights, beat_rate, excess_mean, gap_up_rate, calibrated_from, calibrated_to)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date)
    ON CONFLICT (tier) DO UPDATE SET
      beat_rate = EXCLUDED.beat_rate,
      calibrated_from = EXCLUDED.calibrated_from,
      calibrated_to = EXCLUDED.calibrated_to,
      excess_mean = EXCLUDED.excess_mean,
      gap_up_rate = EXCLUDED.gap_up_rate,
      min_day_move = EXCLUDED.min_day_move,
      nights = EXCLUDED.nights,
      samples = EXCLUDED.samples,
      updated_at = now()
  `, [tier, 0, list.length, nights, beatRate.toFixed(4), excessMean.toFixed(4), gapUpRate.toFixed(4), from, to]);

  written += 1;
  console.log(`  ${tier} · ${list.length}건 · ${nights}밤 · 밤평균 상회 ${Math.round(beatRate * 100)}% · 갭상승 ${Math.round(gapUpRate * 100)}% · 초과 ${excessMean >= 0 ? "+" : ""}${excessMean.toFixed(3)}%p`);
}

console.log(`\n${written}개 등급 기록 · ${from} ~ ${to} · ${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
