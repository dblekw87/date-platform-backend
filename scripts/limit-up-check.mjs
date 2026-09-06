import { loadLimitUpEvidence } from "../src/providers/limit-up-evidence.mjs";
import { loadLockedLimitUps } from "../src/providers/limit-up-detect.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 오늘(또는 지정한 날) 상한가에 잠긴 것과 그 이유를 화면으로 봅니다.
 *
 *   node scripts/limit-up-check.mjs [YYYY-MM-DD]
 *
 * 알림은 수집기가 정규장 중 5분마다 보냅니다. 여기서는 보내지 않고 그리기만
 * 하므로 몇 번을 돌려도 알림이 중복되지 않습니다.
 */

const config = readConfig();
const day = process.argv.slice(2).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const locks = await loadLockedLimitUps(config, day);

console.log("");
console.log(`${day} · 상한가 잠김 ${locks.length}종목 (3분 이상)`);

for (const lock of locks) {
  const evidence = await loadLimitUpEvidence(config, lock, day);

  console.log("");
  console.log(`  ${lock.name} (${lock.symbol}) · ${lock.size} · ${lock.minutes}분 · ${lock.theme ?? "-"}`);

  for (const filing of evidence.filings) {
    console.log(`      공시 ${filing.at} ${(filing.report_name ?? "").slice(0, 56)}`);
  }

  for (const item of evidence.news) {
    const tag = evidence.kind === "theme"
      ? `추정 ${item.at} [${item.peer_name ?? item.peer} +${item.move.toFixed(0)}%]`
      : `뉴스 ${item.at}`;

    console.log(`      ${tag} ${item.headline.slice(0, 56)}`);
  }

  for (const caution of evidence.cautions ?? []) {
    console.log(`      주의 ${caution.at} ${(caution.report_name ?? "").slice(0, 56)}`);
  }

  if (evidence.kind === "none") console.log("      이유로 볼 만한 것이 없습니다.");
}

process.exit(0);
