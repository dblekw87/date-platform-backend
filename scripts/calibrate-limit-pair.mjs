import { calibrateLimitPair } from "../src/providers/calibration.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 짝꿍매매 등급별 실측 성적을 다시 계산합니다.
 *
 * 실제 계산은 providers/calibration.mjs에 있고 수집기도 같은 함수를 부릅니다.
 *
 *   npm run kr:limit-pair
 */

const started = Date.now();
const result = await calibrateLimitPair(readConfig(), { log: (message) => console.log(`  ${message}`) });

console.log(`\n${result.tiers}개 등급 · 후보 ${result.total}건 · ${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
