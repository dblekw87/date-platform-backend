import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

import { getMarketBoard } from "../src/routes/market-board.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 보드 한 장을 공개 저장소에 밀어올립니다.
 *
 * 배포된 프론트는 이 데스크톱의 백엔드에 닿을 수 없습니다. 그렇다고 DB와 수집기를
 * 클라우드로 올리면 무료 한도를 넘고 API 키가 남의 서버에 올라갑니다. 그래서 데이터가
 * 아니라 **그려진 화면 한 장**만 내보냅니다 — provider 원본 payload는 빠지고, 키도
 * 나가지 않으며, 저장소는 JSON 두 개뿐입니다.
 *
 * 실패는 조용히 넘기지 않습니다. 밀어올리지 못하면 공개 사이트는 낡은 보드를 계속
 * 보여주는데, 그건 화면상으로 정상과 구분되지 않습니다.
 *
 *   npm run snapshot:publish
 */

const run = promisify(execFile);
// Forward slashes on purpose. Written with backslashes this string collapsed to
// "C:UsersPangwoodate-board-snapshot" through the JS escapes, node created that
// directory inside the backend checkout, and `git -C` walked up to the backend
// repo and committed the board into it. Node accepts either separator here.
const repoPath = process.env.BOARD_SNAPSHOT_REPO ?? "C:/Users/Pangwoo/date-board-snapshot";

async function git(args) {
  return run("git", ["-C", repoPath, ...args], { windowsHide: true });
}

const config = readConfig();
const board = await getMarketBoard(config);

if (!board || (board.krLeadingStocks ?? []).length === 0) {
  console.error("보드가 비어 있어 올리지 않습니다. 수집기와 DB를 먼저 확인하세요.");
  process.exit(1);
}

const generatedAt = new Date().toISOString();

await mkdir(repoPath, { recursive: true });
await writeFile(path.join(repoPath, "board.json"), JSON.stringify(board), "utf8");
await writeFile(path.join(repoPath, "meta.json"), JSON.stringify({
  generatedAt,
  krEtfLeaders: (board.krEtfLeaders ?? []).length,
  krLeadingStocks: (board.krLeadingStocks ?? []).length,
  krPairTrades: (board.krPairTrades ?? []).length,
  headlines: (board.headlineFlow ?? []).length,
  usLeadingStocks: (board.usLeadingStocks ?? []).length
}, null, 2) + "\n", "utf8");

const { stdout: status } = await git(["status", "--porcelain"]);

if (status.trim() === "") {
  console.log(`변경 없음 · ${generatedAt}`);
  process.exit(0);
}

await git(["add", "-A"]);
await git(["commit", "-m", `Board snapshot ${generatedAt}`]);
await git(["push", "-q", "origin", "main"]);

console.log(`올림 · ${generatedAt} · 국내 ${(board.krLeadingStocks ?? []).length}종목 · 미국 ${(board.usLeadingStocks ?? []).length}종목 · 뉴스 ${(board.headlineFlow ?? []).length}건`);
process.exit(0);
