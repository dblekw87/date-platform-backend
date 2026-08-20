import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

/**
 * 보드 한 장을 공개 저장소로 내보냅니다.
 *
 * 배포된 프론트는 이 데스크톱의 백엔드에 닿을 수 없습니다. DB와 수집기를 클라우드로
 * 올리면 무료 한도를 넘고 API 키가 남의 서버에 올라가므로, 나가는 것은 데이터가
 * 아니라 **그려진 화면 한 장**입니다 — provider 원본 payload는 이미 빠져 있고, 키도
 * 나가지 않으며, 저장소에는 JSON 두 개뿐입니다.
 *
 * 커밋은 하나를 계속 고쳐 씁니다. 10분마다 한 장이면 하루 144커밋에 40MB에 가까운
 * 히스토리가 쌓이는데, 읽히는 것은 언제나 마지막 한 장뿐입니다.
 *
 * 빈 보드는 올리지 않습니다. 낡은 보드와 정상 보드는 화면에서 구분되지 않으므로,
 * 수집기가 죽었을 때 사이트가 조용히 옛날 데이터를 계속 보여주면 안 됩니다.
 */

const run = promisify(execFile);

export function snapshotRepoPath() {
  // Forward slashes on purpose: with backslashes this collapses through the JS
  // escapes into a relative path, node creates it inside the backend checkout,
  // and `git -C` then walks up and commits the board into the backend repo.
  return process.env.BOARD_SNAPSHOT_REPO ?? "C:/Users/Pangwoo/date-board-snapshot";
}

export async function publishBoardSnapshot(board, { repoPath = snapshotRepoPath() } = {}) {
  if (!board || (board.krLeadingStocks ?? []).length === 0) {
    return { published: false, reason: "보드가 비어 있습니다" };
  }

  const git = (args) => run("git", ["-C", repoPath, ...args], { windowsHide: true });
  const generatedAt = new Date().toISOString();

  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "board.json"), JSON.stringify(board), "utf8");
  await writeFile(path.join(repoPath, "meta.json"), `${JSON.stringify({
    generatedAt,
    headlines: (board.headlineFlow ?? []).length,
    krEtfLeaders: (board.krEtfLeaders ?? []).length,
    krLeadingStocks: (board.krLeadingStocks ?? []).length,
    krPairTrades: (board.krPairTrades ?? []).length,
    usLeadingStocks: (board.usLeadingStocks ?? []).length
  }, null, 2)}\n`, "utf8");

  const { stdout: status } = await git(["status", "--porcelain"]);

  if (status.trim() === "") return { generatedAt, published: false, reason: "변경 없음" };

  await git(["add", "-A"]);

  const { stdout: head } = await git(["log", "-1", "--pretty=%s"]);
  const amend = head.startsWith("Board snapshot") ? ["--amend"] : [];

  await git(["commit", ...amend, "-m", `Board snapshot ${generatedAt}`]);
  await git(["push", "-q", "--force-with-lease", "origin", "main"]);

  return { generatedAt, published: true };
}
