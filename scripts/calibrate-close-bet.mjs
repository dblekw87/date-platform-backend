import { calibrateCloseBet } from "../src/providers/calibration.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 종가배팅 등급별 실측 성적을 다시 계산합니다.
 *
 * 실제 계산은 providers/calibration.mjs에 있고 수집기도 같은 함수를 부릅니다 --
 * 스크립트에만 두면 손으로 돌리지 않는 한 표본이 늘지 않습니다.
 *
 *   npm run kr:close-bet
 */

const started = Date.now();
const result = await calibrateCloseBet(readConfig(), { log: (message) => console.log(`  ${message}`) });

console.log(`\n${result.tiers}개 등급 · 후보 ${result.total}건 · ${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
