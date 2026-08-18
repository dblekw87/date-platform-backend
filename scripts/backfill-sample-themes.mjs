import { classifyTheme } from "../src/providers/themes.mjs";
import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Re-apply the theme map to samples already recorded.
 *
 * theme is stored on every row, but it is derived from the symbol, so a stock
 * added to the curated map today leaves every earlier row of itself labelled
 * 미분류. On 2026-08-18 that was the whole point of the day: six 남북경협 names
 * ran to the top of the board and were recorded as unclassified, and the
 * classification arrived only after they had dropped out of the leader list.
 *
 * Rewriting a record is not something to do casually, so it is a dry run unless
 * asked. What makes it defensible here is that nothing observed is touched -
 * price, turnover, volume and the timestamps stay exactly as they were, and the
 * column being rewritten is a lookup that could equally be recomputed at read
 * time. If a rewrite ever looks wrong, running this again restores whatever the
 * map currently says.
 *
 *   npm run theme:backfill
 *   npm run theme:backfill -- --apply
 *   npm run theme:backfill -- --apply --date=2026-08-18
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

const config = readConfig();
const apply = process.argv.includes("--apply");
const date = readOption("date", null);

const rows = await query(config, `
  SELECT symbol, name, theme, count(*)::int AS rows, min(session_date)::text AS first_day, max(session_date)::text AS last_day
  FROM market_price_samples
  WHERE market = 'KR'${date ? " AND session_date = $1" : ""}
  GROUP BY symbol, name, theme
`, date ? [date] : []);

const changes = rows.rows
  .map((row) => ({ ...row, next: classifyTheme(row.symbol, row.name ?? "") }))
  .filter((row) => row.next && row.next !== row.theme)
  .sort((left, right) => right.rows - left.rows);

console.log(`\n테마 소급 적용${date ? ` · ${date}` : ""}${apply ? "" : " · 미리보기(쓰기 없음)"}`);
console.log(`  검사 ${rows.rows.length}건 · 바뀔 것 ${changes.length}건\n`);

if (changes.length === 0) {
  console.log("  저장된 라벨이 현재 사전과 일치합니다.\n");
  process.exit(0);
}

for (const row of changes.slice(0, 25)) {
  console.log(`  ${(row.name ?? row.symbol).padEnd(16)} ${row.symbol}  ${String(row.theme).padEnd(12)} → ${row.next.padEnd(12)} ${String(row.rows).padStart(5)}행  ${row.first_day}~${row.last_day}`);
}

if (changes.length > 25) console.log(`  … 외 ${changes.length - 25}건`);

if (!apply) {
  console.log("\n  적용하려면 --apply 를 붙이세요.\n");
  process.exit(0);
}

let updated = 0;

for (const row of changes) {
  const result = await query(config, `
    UPDATE market_price_samples
    SET theme = $1
    WHERE market = 'KR' AND symbol = $2${date ? " AND session_date = $3" : ""}
  `, date ? [row.next, row.symbol, date] : [row.next, row.symbol]);

  updated += result.rowCount;
}

console.log(`\n  ${updated}행 갱신했습니다.\n`);

process.exit(0);
