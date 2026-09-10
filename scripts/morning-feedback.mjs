import { readConfig } from "../src/config.mjs";
import { buildMorningFeedback } from "../src/providers/morning-feedback.mjs";
import { notify } from "../src/providers/notify.mjs";

/**
 * 아침 피드백을 지금 만들어 봅니다.
 *
 *   node scripts/morning-feedback.mjs          화면에만
 *   node scripts/morning-feedback.mjs --send   텔레그램으로도
 *
 * 수집기가 07:00에 보내는 것과 같은 글입니다. 채점이 끝났는지, 어제 기록이
 * 들어갔는지 아침에 보기 전에 확인할 때 씁니다.
 */

const config = readConfig();
const text = await buildMorningFeedback(config);

console.log("");
console.log(text);
console.log("");

if (process.argv.includes("--send")) {
  console.log(await notify(config, { text, url: config.publicSiteUrl }) ? "보냈습니다." : "보내지 못했습니다.");
}

process.exit(0);
