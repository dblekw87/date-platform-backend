import { loadSectorFollowers } from "../src/providers/sector-follower.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 섹터 2등주 후보를 화면으로. 지난 날을 주면 그날 저장된 값으로 되짚습니다.
 *
 *   node scripts/sector-follower-check.mjs              지금 (KIS 시세로)
 *   node scripts/sector-follower-check.mjs 2026-09-08   그날 (저장된 종가로)
 *
 * 보내지도 남기지도 않습니다.
 */

const config = readConfig();
const asked = process.argv.slice(2).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const day = asked ?? today;
const picks = await loadSectorFollowers(config, day, { live: day === today });

console.log("");
console.log(`${day} · 섹터 2등주 후보 ${picks.length}종목 (${day === today ? "KIS 시세" : "저장된 값"})`);

for (const { leader, follower } of picks) {
  console.log(`  ${leader.name} ${leader.rate === null ? '시세 없음' : (leader.rate > 0 ? '+' : '') + leader.rate.toFixed(1) + '%'} [${leader.theme}] → ${follower.name} (${follower.symbol})`
    + ` ${follower.rate > 0 ? "+" : ""}${follower.rate.toFixed(1)}% · ${Math.round(follower.turnover / 1e8)}억 · ${follower.theme}`);
}

process.exit(0);
