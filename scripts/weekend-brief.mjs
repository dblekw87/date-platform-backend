import { buildWeekendBrief } from "../src/providers/weekend-brief.mjs";
import { notify } from "../src/providers/notify.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 주말 브리핑을 손으로 보는 자리.
 *
 *   node scripts/weekend-brief.mjs          화면에만
 *   node scripts/weekend-brief.mjs --send   텔레그램으로도
 *
 * 실제 발송은 수집기가 월요일 07:10에 합니다. 여기서는 같은 buildWeekendBrief를
 * 불러 글만 만들므로, 화면에서 본 것과 아침에 간 것이 갈리지 않습니다.
 *
 * **--send는 진짜 나갑니다.** 텔레그램이 설정된 기계에서 "테스트 삼아" 부르지
 * 마세요 -- 2026-09-12에 그렇게 미국 급등 알림이 세 번째로 발송됐습니다
 * ([[alert-dedup-state]]). 여기의 --send는 alert_sent를 건드리지 않으므로
 * 아침 통을 막지도 않습니다. 즉 쓰면 그냥 한 통이 더 갑니다.
 */

const config = readConfig();
const text = await buildWeekendBrief(config);

console.log("");
console.log(text);
console.log("");

if (process.argv.slice(2).includes("--send")) {
  const sent = await notify(config, { text, url: config.publicSiteUrl });

  console.log(sent ? "텔레그램으로 보냈습니다." : "보내지 못했습니다.");
}

process.exit(0);
