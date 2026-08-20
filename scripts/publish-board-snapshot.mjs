import { getMarketBoard } from "../src/routes/market-board.mjs";
import { publishBoardSnapshot } from "../src/snapshot.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 보드 스냅샷을 한 번 올립니다. 수집기가 돌고 있으면 알아서 주기적으로 올리므로,
 * 이건 손으로 한 장 밀어넣거나 배포 직후 확인할 때 씁니다.
 *
 *   npm run snapshot:publish
 */

const config = readConfig();
const board = await getMarketBoard(config);
const result = await publishBoardSnapshot(board, { config });

if (!result.published) {
  console.error(`올리지 않음 · ${result.reason}`);
  process.exit(result.reason === "변경 없음" ? 0 : 1);
}

console.log(`올림 · ${result.generatedAt} · 국내 ${(board.krLeadingStocks ?? []).length}종목 · 미국 ${(board.usLeadingStocks ?? []).length}종목 · 뉴스 ${(board.headlineFlow ?? []).length}건`);
process.exit(0);
