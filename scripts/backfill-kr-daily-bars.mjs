import { readConfig } from "../src/config.mjs";
import { collectKrDailyBars } from "../src/providers/kr-daily-bars.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅을 재기 위한 일봉 backfill.
 *
 * 대상은 상장 전 종목입니다. 종가배팅은 대형주만의 것이 아니고 -- 오히려 갭이
 * 크게 벌어지는 쪽은 소형주입니다 -- 어느 크기에서 통하는지가 재려는 것 중
 * 하나이므로, 크기로 미리 잘라내면 그 질문 자체가 사라집니다.
 *
 * 종목당 요청 하나에 1.6년치, 120ms 간격이라 4,300종목이 10분 안쪽입니다.
 *
 *   node scripts/backfill-kr-daily-bars.mjs [--from 2025-01-01] [--limit 5000]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const from = flag("from", "2025-01-01");
const to = flag("to", new Date().toISOString().slice(0, 10));
const limit = Number(flag("limit", "5000"));

const { rows } = await query(config, `
  SELECT symbol FROM (
    SELECT symbol, max(turnover) AS turnover
      FROM market_price_samples
     WHERE market = 'KR' AND turnover IS NOT NULL
     GROUP BY symbol
    UNION ALL
    SELECT symbol, max(turnover) AS turnover
      FROM kr_daily_universe
     WHERE turnover > 0
     GROUP BY symbol
  ) seen
  GROUP BY symbol
  ORDER BY max(turnover) DESC NULLS LAST
  LIMIT $1
`, [limit]);
const symbols = rows.map((row) => row.symbol);

console.log(`국내 일봉 backfill · ${symbols.length}종목 · ${from} ~ ${to}`);

const started = Date.now();
const { failed, saved } = await collectKrDailyBars(config, symbols, {
  from,
  log: (message) => console.log(`  ${message}`),
  to
});

console.log(`\n${saved}행 저장 · 실패 ${failed}종목 · ${Math.round((Date.now() - started) / 1000)}초`);

const summary = await query(config, `
  SELECT count(*) AS bars, count(DISTINCT symbol) AS symbols,
         min(session_date)::text AS first_day, max(session_date)::text AS last_day
    FROM kr_daily_bars
`);

console.log(`  표 전체: ${summary.rows[0].bars}행 · ${summary.rows[0].symbols}종목 · ${summary.rows[0].first_day} ~ ${summary.rows[0].last_day}`);
process.exit(0);
