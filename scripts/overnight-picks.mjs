import { collectCandidates, tradableUniverse } from "../src/providers/overnight-collect.mjs";
import { notifyNewMaterial } from "../src/providers/material-alert.mjs";
import { printPicks } from "./overnight-picks-report.mjs";
import { rankPicks } from "../src/providers/overnight-rank.mjs";
import { readConfig } from "../src/config.mjs";
import { tradingSessions, upcomingWindow } from "../src/providers/overnight-window.mjs";

/**
 * 지금 무엇이 잡히는지 손으로 보는 자리.
 *
 *   node scripts/overnight-picks.mjs           화면에만
 *   node scripts/overnight-picks.mjs --send    새로 잡힌 것을 텔레그램으로도
 *
 * 실제 알림은 이 스크립트가 아니라 수집기가 보냅니다 -- 5분마다
 * material-alert.mjs가 돌면서 **새로 잡힌 것만** 내보냅니다. 여기서는 그 결과를
 * 사람이 보기 좋게 다시 그릴 뿐이라, 몇 번을 돌려도 알림이 중복되지 않습니다
 * (--send를 줘도 이미 보낸 종목은 저장 단계에서 걸립니다).
 *
 * 고르는 근거는 scripts/measure-overnight-news.mjs가 잰 값입니다. 규칙을 바꾸려면
 * 거기서 다시 재고 오세요 -- 여기 숫자를 손으로 고치면 잰 것과 고르는 것이
 * 갈라집니다.
 */

const config = readConfig();
const args = process.argv.slice(2);
const minTurnover = 1_000_000_000;

const sessions = await tradingSessions(config);
const window = upcomingWindow(sessions);
const candidates = await collectCandidates(config, window);
const universe = await tradableUniverse(config, window.previous, minTurnover);
const picks = rankPicks(candidates, universe);

printPicks(picks, window, "다음 장");

console.log(`후보 ${picks.length}종목 · 창 안 종목 ${candidates.size}개 · 거래 가능 모집단 ${universe.size}개`);

if (args.includes("--send")) {
  const sent = await notifyNewMaterial(config, { url: config.publicSiteUrl });

  console.log(sent ? `텔레그램으로 새 후보 ${sent}종목 보냈습니다.` : "새로 보낼 후보가 없습니다.");
}

process.exit(0);
