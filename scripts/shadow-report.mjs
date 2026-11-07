import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 그림자 매매 성적표 -- 기계가 규칙대로 했다면 vs 사람이 실제로 한 것.
 *
 *   npm run shadow:report                전체
 *   npm run shadow:report -- --since 2026-11-09
 *
 * 장부(shadow_trades)에는 관측값만 있고 수익률은 여기서 냅니다. 그래야 비용 가정이나
 * 손절 폭을 바꿔도 과거 기록으로 다시 잴 수 있습니다.
 *
 * 청산 두 가지를 나란히 봅니다:
 *   규칙   09:05~09:10에 판다(close-bet-findings: 재료 없는 갭하락도 버티는 쪽이 나음)
 *   손절   시가가 손절선 아래면 시가에, 장중 저가가 닿으면 손절선에 판다(사용자 2026-10-22 규칙)
 *
 * 초과는 그날 아침 시장 평균 시가 갭을 뺀 값입니다. 청산이 09:07이라 시가 갭과
 * 정확히 같은 구간은 아닙니다 -- 밤 전체가 좋았는지 나빴는지를 걷어내는 용도입니다.
 */

/*
 * 왕복 비용(%). 매도 증권거래세 0.20%(2026년, 코스피는 농특세 포함) + 매수·매도
 * 수수료 약 0.015%씩. 증권사 수수료가 다르면 이 값만 고치세요.
 */
const roundTripCostPct = 0.23;

const config = readConfig();
const args = process.argv.slice(2);
const sinceIndex = args.indexOf("--since");
const since = sinceIndex >= 0 ? args[sinceIndex + 1] : "2000-01-01";

const { rows: trades } = await query(config, `
  WITH market AS (
    SELECT b.session_date, avg(b.open / p.close - 1) * 100 AS gap
      FROM kr_daily_bars b
      JOIN LATERAL (
        SELECT close FROM kr_daily_bars
         WHERE symbol = b.symbol AND session_date < b.session_date
         ORDER BY session_date DESC LIMIT 1) p ON true
     WHERE b.open > 0 AND p.close > 0
       AND b.session_date IN (SELECT exit_date FROM shadow_trades WHERE exit_date IS NOT NULL)
     GROUP BY b.session_date HAVING count(*) >= 50
  )
  SELECT t.session_date::text AS day, t.symbol, t.name, t.tier, t.locked, t.filled, t.fill_note,
         t.entry_price::float8 AS entry, t.exit_price::float8 AS exit, t.exit_open::float8 AS open,
         t.exit_low::float8 AS low, t.stop_pct::float8 AS stop, t.exit_date::text AS exit_day,
         to_char(t.exit_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS exit_time,
         m.gap::float8 AS market_gap
    FROM shadow_trades t
    LEFT JOIN market m ON m.session_date = t.exit_date
   WHERE t.strategy = 'close_bet' AND t.session_date >= $1::date
   ORDER BY t.session_date, t.symbol`, [since]);

const pct = (value) => (value === null || Number.isNaN(value) ? "   -  " : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);
const scored = [];

console.log("그림자 종가배팅 (주문 없음 · 비용 " + roundTripCostPct + "% 차감)\n");
console.log("날짜        종목              체결   규칙청산  손절적용  시장갭   청산");

for (const row of trades) {
  const label = `${row.day}  ${String(row.name ?? row.symbol).padEnd(14).slice(0, 14)}`;

  if (row.filled === null) {
    console.log(`${label}  대기`);
    continue;
  }

  if (!row.filled) {
    console.log(`${label}  못삼   ${row.fill_note ?? ""}`);
    continue;
  }

  if (row.exit === null) {
    console.log(`${label}  보유   진입 ${row.entry}`);
    continue;
  }

  const rule = (row.exit / row.entry - 1) * 100 - roundTripCostPct;
  const stopPrice = row.entry * (1 - row.stop / 100);
  const stopExit = row.open !== null && row.open <= stopPrice
    ? row.open
    : row.low !== null && row.low <= stopPrice ? stopPrice : row.exit;
  const stopped = (stopExit / row.entry - 1) * 100 - roundTripCostPct;
  // 다음 장 09:05~09:15가 아니면 수집기가 꺼져 있던 날입니다 -- 값은 남기되 표시합니다.
  const late = row.exit_time < "09:05" || row.exit_time > "09:15" ? " 시각밖" : "";

  scored.push({ marketGap: row.market_gap, rule, stopped });
  console.log(`${label}  산    ${pct(rule)}  ${pct(stopped)}  ${pct(row.market_gap)}  ${row.exit_day.slice(5)} ${row.exit_time}${late}`);
}

const summarize = (values) => {
  if (!values.length) return "표본 없음";

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const wins = values.filter((value) => value > 0).length;

  return `${values.length}건 · 승 ${wins}(${Math.round((wins / values.length) * 100)}%) · 평균 ${pct(mean)} · 중앙 ${pct(median)} · 합 ${pct(values.reduce((sum, value) => sum + value, 0))}`;
};

const picked = trades.length;
const missed = trades.filter((row) => row.filled === false).length;

console.log(`\n고른 것 ${picked} · 못 산 것 ${missed} · 청산 끝 ${scored.length}`);
console.log(`규칙 청산  ${summarize(scored.map((row) => row.rule))}`);
console.log(`손절 적용  ${summarize(scored.map((row) => row.stopped))}`);

const withMarket = scored.filter((row) => row.marketGap !== null);

if (withMarket.length) console.log(`시장 초과  ${summarize(withMarket.map((row) => row.rule - row.marketGap))}  (규칙 청산 − 시장 갭)`);

/*
 * 같은 기간 사람이 실제로 한 종가매매. 평단·청산가를 적었으면 그 값으로, 아니면
 * 종가→익일 시가로 잽니다(log-pick.mjs). 노션 일지의 수익률은 수수료가 이미
 * 들어 있지만 여기 값은 가격에서 낸 것이라 같은 비용을 뺍니다.
 */
const firstDay = trades[0]?.day ?? since;
const { rows: human } = await query(config, `
  SELECT session_date::text AS day, symbol,
         coalesce(entry_price, session_close)::float8 AS entry,
         coalesce(exit_price, next_open)::float8 AS exit
    FROM kr_signal_outcomes
   WHERE kind = 'user_close_bet' AND tier = '사람 · 종가매매' AND session_date >= $1::date`, [firstDay]);
const humanReturns = human
  .filter((row) => row.entry > 0 && row.exit > 0)
  .map((row) => (row.exit / row.entry - 1) * 100 - roundTripCostPct);
const overlap = human.filter((row) => trades.some((trade) => trade.day === row.day && trade.symbol === row.symbol)).length;

console.log(`\n사람 종가매매(${firstDay}~)  ${summarize(humanReturns)}`);
console.log(`같은 날 같은 종목 ${overlap}건 -- 나머지는 사람이 알림 밖에서 고른 것입니다`);

process.exit(0);
