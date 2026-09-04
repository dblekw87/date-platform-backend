import { query } from "../db/client.mjs";

/**
 * 상장일을 기록합니다.
 *
 * 사용자가 신규 상장주를 그날 헷지주로 씁니다. 재료도 차트도 안 보고 **신규라는
 * 사실 자체**를 조건으로 삼는 매매인데, 우리에게 그 사실을 담을 자리가 없었습니다.
 * 2026-09-04 스카이랩스가 거래대금 1,233억으로 그날 최상위였는데 테마도 안 붙고
 * 일봉도 0건이라 어느 화면에도 못 올라왔습니다.
 *
 * **첫 등장일을 상장일로 씁니다.** `kr_daily_universe`가 전 종목 일별 스냅샷이라
 * 상장 당일에 들어옵니다. KIND 일정(`providers/krx.mjs`)은 날짜와 회사명은 주지만
 * 종목코드가 없어 이름으로 맞춰야 하고, 이름은 바뀌거나 겹칩니다. 코드가 확실한
 * 쪽을 원본으로 둡니다.
 *
 * **ETF·리츠·스팩은 뺍니다.** 이 매매의 대상이 아니고, 신규 상장 ETF가 매주
 * 여럿이라 그대로 두면 목록이 그것으로 찹니다. 이름 규칙으로 거릅니다 -- 종목
 * 유형을 주는 표가 우리에게 없어 지금은 이게 유일한 길입니다.
 */

// 종목코드가 6자리 숫자가 아닌 것은 ETF·ETN·신주인수권 등입니다. 0233A0 같은 것.
const stockCode = /^\d{6}$/;
const fundName = /(ETF|ETN|KODEX|TIGER|KBSTAR|ARIRANG|HANARO|SOL |ACE |RISE |PLUS |KIWOOM |MIDAS |마이티|TIMEFOLIO|리츠|스팩|기업인수목적)/i;

function isTradableStock(symbol, name) {
  if (!stockCode.test(symbol)) return false;

  return !fundName.test(String(name ?? ""));
}

/**
 * 새로 보인 종목을 기록합니다. 이미 있는 종목은 건드리지 않습니다 -- 처음 본
 * 날이 상장일이고, 나중에 다시 봤다고 날짜가 바뀌면 안 됩니다.
 */
export async function recordKrListings(config, { log = () => {} } = {}) {
  if (!config.databaseUrl) return 0;

  const result = await query(config, `
    WITH span AS (SELECT min(session_date) AS start FROM kr_daily_universe),
    first_seen AS (
      SELECT u.symbol,
             min(u.session_date) AS listed_on,
             (array_agg(u.name ORDER BY u.session_date))[1] AS name,
             (array_agg(u.market ORDER BY u.session_date))[1] AS market
        FROM kr_daily_universe u
       GROUP BY u.symbol
    )
    INSERT INTO kr_listings (symbol, name, listed_on, market, source, before_collection)
    SELECT f.symbol, f.name, f.listed_on, f.market, 'universe',
           -- 수집 첫날에 이미 있던 종목은 상장일을 모릅니다. 그날 이전이라는 것만
           -- 압니다. 표시해 두지 않으면 4,300종목이 전부 그날 상장한 것이 됩니다.
           f.listed_on <= (SELECT start FROM span)
      FROM first_seen f
     WHERE f.symbol ~ '^[0-9]{6}$'
    ON CONFLICT (symbol) DO NOTHING
  `);

  const written = result.rowCount ?? 0;

  if (written > 0) log(`kr listings · ${written} new`);

  return written;
}

/**
 * 오늘 기준 상장 N일차인 종목들. 화면과 측정이 같은 정의를 쓰도록 여기 둡니다.
 *
 * `days`는 **거래일이 아니라 달력일**입니다. 상장 이틀차가 월요일이면 주말이
 * 끼어 달력으로는 나흘입니다. 거래일로 세려면 kr_daily_bars를 세야 하는데
 * 신규주는 그 표에 없어서 셀 수가 없습니다 -- 그 한계가 이 매매의 데이터 문제
 * 그 자체입니다.
 */
export async function loadRecentListings(config, { days = 30, sessionDate = null } = {}) {
  if (!config.databaseUrl) return [];

  const { rows } = await query(config, `
    SELECT l.symbol, l.name, l.listed_on::text AS listed_on, l.market,
           (coalesce($2::date, current_date) - l.listed_on) AS age_days,
           u.close_price, u.change_rate, u.turnover, u.market_cap
      FROM kr_listings l
      LEFT JOIN LATERAL (
        SELECT close_price, change_rate, turnover, market_cap
          FROM kr_daily_universe
         WHERE symbol = l.symbol
         ORDER BY session_date DESC LIMIT 1
      ) u ON true
     WHERE l.before_collection = false
       AND l.listed_on > coalesce($2::date, current_date) - $1::int
     ORDER BY l.listed_on DESC, l.symbol
  `, [days, sessionDate]);

  return rows.filter((row) => isTradableStock(row.symbol, row.name));
}
