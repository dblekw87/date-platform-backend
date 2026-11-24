import { query } from "../db/client.mjs";

/**
 * 종가배팅 알림 맨 위 한 줄: 미국 선물과 국내 현물이 얼마나 갈렸나, 국내 선물이 현물보다
 * 얼마나 눌렸나.
 *
 * 2026-11-23 사용자 요청("선물 쪽하고 현물 차이도 알 수 있게 해줘"). 그날 나스닥100 선물은
 * 국내 정규장 내내 +2.5~3.1%였는데 코스피는 −3%대로 반대로 갔습니다 -- 국내는 금요일 밤
 * 미국 폭락을 몰아서 반영하고 선물 반등은 따라가지 않았습니다. 다음 날 젠슨 황 복귀로
 * 하이닉스가 +10% 갭으로 열렸고, 15:20에 이 차이를 본 사람은 근거가 있었습니다.
 *
 * 나스닥 선물(NQ=F)은 야후라 10분 늦습니다(memory kospi-nq-intraday). 하루 상관 0.75,
 * 77%가 같은 방향이라 크게 갈리는 날이 드물고, 그래서 눈에 띄게 적습니다.
 *
 * 베이시스는 쏠림 표와 같은 정의입니다(코스피200 선물 − 현물, 직전 10일 평균과 견줌).
 * 12월물은 연말 배당 때문에 원래 음수라 부호보다 평소 대비가 읽을 값입니다.
 */
export async function loadFuturesGapLine(config, { maxAgeMinutes = 40 } = {}) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, value::float8 AS value, change_rate::float8 AS rate
      FROM macro_samples
     WHERE symbol IN ('NQ=F', 'KOSPI', 'F-K200', 'K200')
       AND observed_at >= now() - ($1 || ' minutes')::interval
     ORDER BY symbol, observed_at DESC`, [String(maxAgeMinutes)]);
  const by = Object.fromEntries(rows.map((row) => [row.symbol, row]));
  const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  const parts = [];

  if (by["NQ=F"] && by.KOSPI) {
    const gap = by["NQ=F"].rate - by.KOSPI.rate;
    const opposite = Math.abs(gap) >= 3 && Math.sign(by["NQ=F"].rate) !== Math.sign(by.KOSPI.rate);

    parts.push(`나스닥100 선물 ${pct(by["NQ=F"].rate)} · 코스피 ${pct(by.KOSPI.rate)} → 차이 ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}%p${opposite ? " ⚠ 방향 반대" : ""}`);
  } else if (by["NQ=F"]) {
    parts.push(`나스닥100 선물 ${pct(by["NQ=F"].rate)}`);
  }

  if (by["F-K200"] && by.K200 && by.K200.value > 0) {
    const basisPct = (by["F-K200"].value / by.K200.value - 1) * 100;
    const { rows: [usual] } = await query(config, `
      WITH f AS (SELECT date_trunc('minute', observed_at) t, avg(value::float8) v FROM macro_samples WHERE symbol = 'F-K200'
                  AND observed_at < date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
                  AND observed_at >= now() - interval '16 days'
                  AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:05' AND '15:15' GROUP BY 1),
           s AS (SELECT date_trunc('minute', observed_at) t, avg(value::float8) v FROM macro_samples WHERE symbol = 'K200'
                  AND observed_at < date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
                  AND observed_at >= now() - interval '16 days'
                  AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:05' AND '15:15' GROUP BY 1)
      SELECT avg((f.v / s.v - 1) * 100) pct FROM f JOIN s USING (t)`);
    const vsUsual = usual?.pct != null ? `, 평소 대비 ${basisPct - usual.pct >= 0 ? "+" : ""}${(basisPct - usual.pct).toFixed(2)}%p` : "";

    parts.push(`코스피200 선물−현물 ${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(2)}%${vsUsual}`);
  }

  return parts.length ? `🌐 ${parts.join(" | ")}` : null;
}
