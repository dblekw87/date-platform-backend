import { query } from "../db/client.mjs";

/**
 * 오늘 상한가에 붙어 있는 종목.
 *
 * **호가 잔량이 없어 "잠김"을 직접 확인할 수는 없습니다.** 우리가 받는 것은
 * 1분마다의 등락률뿐이라, 상한가에 **몇 분째 머물러 있는가**로 대신합니다.
 * 실측하면 이 대용이 잘 갈립니다 -- 2026-09-04에 TPC로보틱스는 172분,
 * KS인더스트리는 163분이었고, 스치기만 한 것들은 1~2분이었습니다.
 *
 * 위쪽 경계 30.5%가 조건입니다. 국내 가격제한폭이 ±30%라 그보다 큰 값은
 * 상한가가 아니라 **신규상장 첫날**입니다(제한폭이 없습니다). 경계를 안 두면
 * 등락률 114%짜리가 상한가 목록에 올라옵니다.
 *
 * 순위 밖 종목은 애초에 표본이 없다는 한계가 그대로 있습니다
 * ([[ranking-keyhole-finding]]). 상한가는 대개 상승률 상위에 들어오므로 실제로
 * 새는 것은 드물지만, "전부"라고는 말할 수 없습니다.
 */

const limitRate = 29;
const newListingRate = 30.5;
// 3분. 1~2분짜리는 상한가를 스친 것이지 잠긴 것이 아닙니다.
const minimumMinutes = 3;

const sizeOf = (cap) => {
  if (!(cap > 0)) return "소형";
  if (cap >= 1_000_000_000_000) return "대형";
  if (cap >= 300_000_000_000) return "중형";

  return "소형";
};

export async function loadLockedLimitUps(config, day) {
  const { rows } = await query(config, `
    SELECT s.symbol,
           max(u.name) AS name,
           max(u.market) AS market,
           max(s.theme) AS theme,
           max(u.market_cap)::float8 AS market_cap,
           max(u.close_price)::float8 AS close_price,
           max(s.turnover)::float8 AS turnover,
           count(*)::int AS minutes,
           min(s.observed_at) AS locked_at
      FROM market_price_samples s
      LEFT JOIN kr_daily_universe u ON u.symbol = s.symbol AND u.session_date = s.session_date
     WHERE s.market = 'KR' AND s.source LIKE 'kis:krx%' AND s.session_date = $1::date
       AND s.change_rate BETWEEN $2 AND $3
     GROUP BY s.symbol
    HAVING count(*) >= $4
     ORDER BY min(s.observed_at)`,
    [day, limitRate, newListingRate, minimumMinutes]);

  return rows.map((row) => ({
    ...row,
    size: sizeOf(row.market_cap),
    name: row.name ?? row.symbol
  }));
}
