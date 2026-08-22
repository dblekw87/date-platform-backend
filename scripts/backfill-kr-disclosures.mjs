import { collectKrDisclosures } from "../src/providers/kr-disclosures.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 공시 이력 backfill — 호재를 잴 수 있게.
 *
 * 종가배팅에서 먼저인 것은 호재이고, 거래량·윗꼬리·신고점 돌파는 그 뒤에 따라오는
 * 흔적입니다. 지금 화면은 흔적만 보고 있습니다 — 원인을 조건에 넣으려면 "그날 그
 * 종목에 재료가 있었는가"를 과거에 대해서도 물을 수 있어야 하는데, market_disclosures가
 * 2026-08-21부터라 밤이 하나뿐입니다.
 *
 * DART list.json은 날짜를 받으므로 과거도 그대로 열립니다. 하루 한 번 훑고 100건씩
 * 페이지를 넘기면 400거래일이 3천 요청 남짓이고, 무료 쿼터가 하루 20,000이라
 * 한 번에 끝납니다.
 *
 * 접수 시각은 받지 않습니다(timePages: 0). 그건 DART 당일공시 화면에서 긁는 값이라
 * 과거 날짜에는 열리지 않고, 어차피 여기서 필요한 것은 "그날 재료가 있었는가"이지
 * 몇 시였는가가 아닙니다. 시각이 필요한 것은 오늘의 화면이고 그쪽은 이미 받고 있습니다.
 *
 *   node scripts/backfill-kr-disclosures.mjs [--from 2025-01-01] [--to 2026-08-21]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const from = flag("from", "2025-01-01");
const to = flag("to", new Date().toISOString().slice(0, 10));

// 일봉이 있는 날만 훑습니다. 휴장일에 물어봐야 013(공시 없음)이 돌아올 뿐입니다.
const { rows } = await query(config, `
  SELECT DISTINCT session_date::text AS day
    FROM kr_daily_bars
   WHERE session_date BETWEEN $1::date AND $2::date
   ORDER BY 1
`, [from, to]);

console.log(`국내 공시 backfill · ${rows.length}거래일 · ${from} ~ ${to}`);

const started = Date.now();
let fetched = 0;
let saved = 0;
let failed = 0;

for (const [index, { day }] of rows.entries()) {
  try {
    const result = await collectKrDisclosures(config, {
      maxPages: 12,
      sessionDate: day,
      // 이미 저장된 날을 다시 훑지 않습니다. 중간에 끊겨도 이어서 돌릴 수 있습니다.
      stopWhenKnown: true,
      timePages: 0
    });

    fetched += result.fetched;
    saved += result.saved;
  } catch (error) {
    failed += 1;
    console.warn(`  ${day} 실패: ${error instanceof Error ? error.message : error}`);
  }

  if ((index + 1) % 25 === 0) {
    console.log(`  ${index + 1}/${rows.length}일 · ${saved}건 저장 · ${Math.round((Date.now() - started) / 1000)}초`);
  }
}

const summary = await query(config, `
  SELECT count(*) AS total, count(DISTINCT session_date) AS days,
         min(session_date)::text AS first_day, max(session_date)::text AS last_day
    FROM market_disclosures WHERE market = 'KR'
`);

console.log(`\n${saved}건 신규 · ${fetched}건 조회 · 실패 ${failed}일 · ${Math.round((Date.now() - started) / 1000)}초`);
console.log(`  표 전체: ${summary.rows[0].total}건 · ${summary.rows[0].days}일 · ${summary.rows[0].first_day} ~ ${summary.rows[0].last_day}`);
process.exit(0);
