import { loadLimitUpEvidence } from "../src/providers/limit-up-evidence.mjs";
import { loadLockedLimitUps, loadNearLimitUps } from "../src/providers/limit-up-detect.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 오늘(또는 지정한 날) 상한가에 잠긴 것·근접한 것과 그 이유를 화면으로 봅니다.
 *
 * 화면에는 근거 없는 것도 같이 그립니다(`보류`). 알림은 근거가 있을 때만 나가므로,
 * 무엇이 걸러졌는지 보려면 여기서 봐야 합니다.
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
  console.log(`  ${evidence.kind === "none" ? "보류" : "발송"} ${lock.name} (${lock.symbol})`
    + ` · ${lock.size} · ${lock.minutes}분 · ${lock.theme ?? "-"}`);

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

  if (evidence.kind === "none") console.log("      근거 없음 — 붙을 때까지 보내지 않습니다.");
}

/* 근접은 근거가 있는 것만 알림이 나갑니다. 화면에서는 근거 없는 것도 같이 보여
 * 무엇이 걸러졌는지 알 수 있게 합니다. */
const near = await loadNearLimitUps(config, day);

console.log("");
console.log(`상한가 근접(27% 이상, 아직 미잠김) ${near.length}종목`);

for (const stock of near) {
  const evidence = await loadLimitUpEvidence(config, stock, day);
  const sends = evidence.kind === "filing" || evidence.kind === "direct";

  console.log("");
  console.log(`  ${sends ? "발송" : "  · "} ${stock.name} (${stock.symbol}) · ${stock.size}`
    + ` · +${stock.top_rate.toFixed(1)}% (상한가까지 ${stock.gap}%p) · ${stock.theme ?? "-"}`);

  for (const filing of evidence.filings) {
    console.log(`         공시 ${filing.at} ${(filing.report_name ?? "").slice(0, 52)}`);
  }

  for (const item of evidence.news) {
    const tag = evidence.kind === "theme" ? `추정(제외) ${item.at}` : `뉴스 ${item.at}`;

    console.log(`         ${tag} ${item.headline.slice(0, 52)}`);
  }

  if (evidence.kind === "none") console.log("         근거 없음 — 보내지 않습니다.");
}

process.exit(0);
