import { query } from "../db/client.mjs";
import { themeFamily } from "./theme-family.mjs";

/**
 * 애프터마켓에 더 지켜볼 종목.
 *
 * 애프터마켓 표본은 그날 정규장에서 순위에 든 종목만 받았습니다. 그래서 2026-09-08
 * 18:55에 한화오션 태국 호위함 수주가 확정됐을 때, 한화오션도 현대힘스(조선기자재,
 * 그날 20억)도 애프터 표본이 한 행도 없었습니다 -- 다음 날 아침 프리마켓에서
 * 현대힘스가 +9.04%로 열린 것을 보고서야 시간외에 움직였다는 걸 알았습니다.
 * 재료가 시간외에 나오는 날은 **그 재료의 종목과 가족**이 순위 밖에 있어도 봐야
 * 합니다. 순위는 낮의 결과이고, 저녁 재료는 낮의 순위를 모릅니다.
 *
 * 그날 재료 알림에 뜬 종목 + 그 테마 가족의 사전 회원을, 어제 거래대금 순으로
 * 상한까지 더합니다. KIS 호출은 다섯 개씩 묶여 종목 하나가 1초 안쪽이라 80개면
 * 5분 주기 안에 넉넉합니다.
 */

const extraLimit = 80;

export async function loadAfterHoursWatchlist(config, day) {
  const material = await query(config, `
    SELECT DISTINCT symbol FROM kr_signal_outcomes
     WHERE kind LIKE '%material'
       AND (detected_at AT TIME ZONE 'Asia/Seoul')::date = $1::date`, [day]);
  const leaders = material.rows.map((row) => row.symbol);

  if (!leaders.length) return [];

  const themes = await query(config, `
    SELECT symbol, max(theme) AS theme FROM market_price_samples
     WHERE market = 'KR' AND symbol = ANY($1) AND session_date >= $2::date - 5 AND session_date <= $2::date
     GROUP BY symbol`, [leaders, day]);
  const family = new Set();

  for (const row of themes.rows) for (const label of themeFamily(row.theme)) family.add(label);

  const members = family.size
    ? await query(config, `
        SELECT DISTINCT symbol FROM kr_theme_members WHERE theme_name = ANY($1)`, [[...family]])
    : { rows: [] };
  const candidates = [...new Set([...leaders, ...members.rows.map((row) => row.symbol)])];

  const ordered = await query(config, `
    SELECT symbol FROM kr_daily_universe
     WHERE symbol = ANY($1)
       AND session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date < $2::date)
       AND coalesce(trade_halted, false) = false
     ORDER BY turnover DESC NULLS LAST LIMIT $3`, [candidates, day, extraLimit]);

  // 재료 종목 자체는 거래대금과 무관하게 들어갑니다 -- 그것이 이 목록의 이유입니다.
  return [...new Set([...leaders, ...ordered.rows.map((row) => row.symbol)])];
}
