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
/*
 * 상한가까지 얼마 남았을 때 부를 것인가 -- 규모마다 다릅니다.
 *
 * 처음엔 27(3%p 남음) 하나였습니다. 10세션·상한가 92건으로 재보니 소형주는 27%를
 * 넘긴 뒤 잠기기까지 **중앙값 1분**이고 60%가 2분 안에 잠깁니다. 5분마다 도는
 * 알림으로는 잠긴 뒤에야 보게 됩니다. 24%(6%p 남음)면 중앙값 5분이라 절반은 손 쓸
 * 시간이 있습니다. 대신 24%에 닿고도 안 잠기는 것이 늘어(잠김률 78% → 56%),
 * 그 값은 근거 조건이 걸러줍니다.
 *
 * 대형은 느립니다 -- 27%에서 잠기기까지 중앙값 5분, 24%에서는 20분이라 27로
 * 충분하고, 24로 내리면 잠기지 않는 것을 절반 넘게 부릅니다(잠김률 43%).
 * 표본이 7건뿐이라 방향만 믿습니다.
 */
const nearRateBySize = { 대형: 27, 중형: 24, 소형: 24 };
const nearRateFloor = Math.min(...Object.values(nearRateBySize));

/*
 * 이름·시총은 **가장 최근 유니버스 행**에서 옵니다. 오늘 날짜로 조인하면 15:50에
 * 그날 행이 생기기 전까지 전부 비어서, 장중 알림이 "082850 71분째"처럼 코드만
 * 들고 나갔습니다(2026-09-07 실측). 어제 시총이면 규모 판정에 충분합니다.
 */
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
      LEFT JOIN LATERAL (
        SELECT name, market, market_cap, close_price FROM kr_daily_universe
         WHERE symbol = s.symbol ORDER BY session_date DESC LIMIT 1
      ) u ON true
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

/**
 * 아직 안 잠겼지만 상한가까지 2~3%p 남은 종목.
 *
 * 잠긴 뒤에는 살 수 없습니다 -- 매도호가가 비어 있으니까요. 그래서 잠기기 전을
 * 따로 봅니다.
 *
 * **오늘 최고가가 아직 29% 아래인 것만** 돌려줍니다. 29를 넘긴 것은 잠김 쪽이
 * 맡으므로, 이렇게 나누면 한 종목이 두 경로에서 동시에 나오지 않습니다.
 *
 * 잠김과 달리 지속 시간을 요구하지 않습니다. 여기서 값은 **빠른 것**이고, 3분을
 * 기다리면 그 사이에 잠깁니다 -- 2026-09-02~04 실측에서 09시대에 27%를 넘긴
 * 종목들은 대개 몇 분 안에 상한가까지 갔습니다.
 *
 * 대신 근거를 요구합니다(부르는 쪽에서). 하루 7~14종목이 27%에 닿는데 그 시각까지
 * 공시나 기사가 있는 것은 4종목쯤이라, 근거를 안 걸면 알림이 세 배가 되고 그중
 * 대부분은 왜 오르는지 말해주지 못합니다.
 */
export async function loadNearLimitUps(config, day) {
  const { rows } = await query(config, `
    SELECT s.symbol,
           max(u.name) AS name,
           max(u.market) AS market,
           max(s.theme) AS theme,
           max(u.market_cap)::float8 AS market_cap,
           max(u.close_price)::float8 AS close_price,
           max(s.turnover)::float8 AS turnover,
           max(s.change_rate)::float8 AS top_rate
      FROM market_price_samples s
      LEFT JOIN LATERAL (
        SELECT name, market, market_cap, close_price FROM kr_daily_universe
         WHERE symbol = s.symbol ORDER BY session_date DESC LIMIT 1
      ) u ON true
     WHERE s.market = 'KR' AND s.source LIKE 'kis:krx%' AND s.session_date = $1::date
     GROUP BY s.symbol
    HAVING max(s.change_rate) >= $2 AND max(s.change_rate) < $3
     ORDER BY max(s.change_rate) DESC`,
    [day, nearRateFloor, limitRate]);

  return rows
    .map((row) => ({
      ...row,
      size: sizeOf(row.market_cap),
      name: row.name ?? row.symbol,
      // 상한가까지 남은 거리. 국내 제한폭은 ±30%입니다.
      gap: Number((30 - row.top_rate).toFixed(1))
    }))
    // 규모별 문턱은 여기서. SQL은 가장 낮은 문턱으로 넓게 받고 JS가 좁힙니다.
    .filter((row) => row.top_rate >= nearRateBySize[row.size]);
}
