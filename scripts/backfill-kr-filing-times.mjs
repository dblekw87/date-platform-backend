import { loadFilingTimes } from "../src/providers/kr-disclosures.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 과거 공시의 접수 시각을 되받습니다.
 *
 * backfill-kr-disclosures.mjs가 2026-08-23에 과거 418일 치를 넣을 때 시각을 받지
 * 않아(timePages: 0) 325,314건이 전부 `filed_at_source='first-seen'`, 즉 **넣은
 * 시각(08-23 새벽)**으로 찍혔습니다. session_date는 맞지만 filed_at은 날짜부터
 * 틀립니다. 2026-10-07에 무상증자 공시를 쟀더니 73건이 전부 08-24로 뭉쳐 상회
 * 97%가 나온 것이 이 때문이었습니다([[measurement-pitfalls]]).
 *
 * 그 스크립트는 "당일공시 화면은 과거 날짜에 열리지 않는다"고 적었지만 열립니다
 * -- 2026-10-11에 2025-01-02·2025-06-10·2026-08-14를 물어 각각 438·386·463건의
 * 시각을 받았습니다. 그래서 날짜만이 아니라 시각까지 되받습니다.
 *
 * first-seen인 줄만 고칩니다. 몇 번을 다시 돌려도 이미 고친 줄은 건드리지 않으므로
 * 중간에 끊겨도 그대로 다시 돌리면 됩니다. 최근 날짜부터 훑습니다.
 *
 *   node scripts/backfill-kr-filing-times.mjs [--from 2025-01-01] [--to 2026-10-10] [--pages 15]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const from = flag("from", "2025-01-01");
const to = flag("to", "9999-12-31");
// mainAll은 하루 최대 1,200건(12장)까지 봤습니다. 모자라면 남은 줄이 first-seen으로 남습니다.
const pages = Number(flag("pages", "15"));

const { rows: days } = await query(config, `
  SELECT session_date::text AS day, count(*)::int AS pending
    FROM market_disclosures
   WHERE market = 'KR' AND filed_at_source = 'first-seen'
     AND session_date BETWEEN $1::date AND $2::date
     AND session_date < (now() AT TIME ZONE 'Asia/Seoul')::date
   GROUP BY 1
   ORDER BY 1 DESC
`, [from, to]);

console.log(`공시 접수 시각 되받기 · ${days.length}일 · ${days.reduce((sum, row) => sum + row.pending, 0)}건`);

const started = Date.now();
let fixed = 0;
let missed = 0;
let empty = 0;

for (const [index, { day, pending }] of days.entries()) {
  const times = await loadFilingTimes(day, pages);

  if (!times.size) {
    empty += 1;
    missed += pending;
    console.warn(`  ${day} 화면에서 한 건도 못 읽음 (${pending}건 남김)`);
    continue;
  }

  /*
   * 시각은 **화면을 물은 날짜**에 붙입니다. 접수번호 앞 여덟 자리가 아닙니다 --
   * 2025-01-02 화면에 20241217로 시작하는 번호가 섞여 나옵니다(정정·첨부).
   * session_date가 그 날인 줄만 고치므로 다른 날에 넣은 줄을 옮기지 않습니다.
   */
  const { rowCount } = await query(config, `
    UPDATE market_disclosures d
       SET filed_at = ($1::date + t.hhmm::time) AT TIME ZONE 'Asia/Seoul',
           filed_at_source = 'dart',
           updated_at = now()
      FROM unnest($2::text[], $3::text[]) AS t(accession, hhmm)
     WHERE d.market = 'KR' AND d.session_date = $1::date
       AND d.filed_at_source = 'first-seen'
       AND d.accession_number = t.accession
  `, [day, [...times.keys()], [...times.values()]]);

  fixed += rowCount;
  missed += pending - rowCount;

  if ((index + 1) % 20 === 0 || index === days.length - 1) {
    console.log(`  ${index + 1}/${days.length}일 · ${day} · 고침 ${fixed} · 남음 ${missed} · ${Math.round((Date.now() - started) / 1000)}초`);
  }
}

const { rows: [summary] } = await query(config, `
  SELECT count(*) FILTER (WHERE filed_at_source = 'dart')::int AS dart,
         count(*) FILTER (WHERE filed_at_source = 'first-seen')::int AS first_seen
    FROM market_disclosures WHERE market = 'KR'
`);

console.log(`\n고침 ${fixed}건 · 못 맞춘 것 ${missed}건 · 빈 화면 ${empty}일 · ${Math.round((Date.now() - started) / 1000)}초`);
console.log(`  표 전체: dart ${summary.dart}건 · first-seen ${summary.first_seen}건`);
process.exit(0);
