import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { query } from "../db/client.mjs";
import { massiveRequest } from "../pipeline/massive.mjs";
import { usSessionStocks } from "./market-brief-alert.mjs";
import { isRegularSession } from "./market-session.mjs";
import { snapshotRepoPath } from "../snapshot.mjs";

/**
 * 미국 섹터 지도 -- 핀비즈 S&P500 지도 모양의 그림 한 장.
 *
 * 사용자 요청(2026-10-18): "S&P500 섹터별로 오르는 거 네모 모양으로, 섹터들 다 표기".
 * 07:30 클라우드 브리핑이 텔레그램에 붙여 보냅니다. 클라우드는 이 DB에 닿지 못하므로
 * 정규장이 끝난 뒤 여기서 한 번 그려 보드 스냅샷 저장소에 같이 올립니다.
 *
 * 종목은 시가총액 상위 500 -- S&P500 구성 목록은 없어서 그 근사입니다. 섹터 이름은
 * 08:20 섹터 순위·상승 종목 목록과 같은 것(usSessionStocks)이라 세 곳이 같은 말을 합니다.
 *
 * 한 세션에 한 번만 그립니다. 그린 세션은 저장소의 us-sector-map.json에 남습니다.
 */

const run = promisify(execFile);
const mapSize = 500;
const imageName = "us-sector-map.png";
const metaName = "us-sector-map.json";
// 마지막 표본 뒤 이만큼 조용해야 정규장이 끝난 것으로 봅니다. 휴장일에는 표본이
// 아예 새로 생기지 않으므로 지난 세션을 다시 그리지 않습니다.
const settleMs = 10 * 60_000;
// 시가총액이 비어 있는 종목을 한 번에 이만큼 Massive에 묻습니다(무료 1분 5회).
// 지도 상위에 들 만큼 거래가 있는 것만 -- META·GOOGL이 여기 걸렸습니다.
const capFillLimit = 10;
const capFillMinTurnover = 1e8;
const scriptPath = fileURLToPath(new URL("../../scripts/render-us-sector-map.py", import.meta.url));

let running = false;

async function readMeta(repoPath) {
  try {
    return JSON.parse(await readFile(path.join(repoPath, metaName), "utf8"));
  } catch {
    return null;
  }
}

/* 주식 종류가 여럿인 회사는 SEC 주식수가 비어 있습니다. 상장 종목 기준 값을 받아 둡니다. */
async function fillMissingCaps(config, stocks) {
  if (!config.massive.apiKey) return 0;

  const missing = stocks
    .filter((stock) => !(stock.cap > 0) && stock.turnover >= capFillMinTurnover)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, capFillLimit);
  const today = new Date().toISOString().slice(0, 10);
  let filled = 0;

  for (const { symbol } of missing) {
    try {
      const details = (await massiveRequest(config, `/v3/reference/tickers/${symbol}`)).results ?? {};

      if (!(details.market_cap > 0)) continue;

      await query(config, `
        INSERT INTO us_listed_shares (symbol, as_of, shares, market_cap)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (symbol, as_of) DO UPDATE SET shares = EXCLUDED.shares, market_cap = EXCLUDED.market_cap`,
      [symbol, today, details.weighted_shares_outstanding ?? details.share_class_shares_outstanding ?? null, details.market_cap]);
      filled += 1;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  return filled;
}

/*
 * 회사 하나에 한 칸. GOOGL과 GOOG는 같은 회사 시가총액을 각각 받아 오므로 그대로 두면
 * 알파벳이 두 번 들어갑니다. 거래대금이 큰 쪽만 남깁니다.
 */
function onePerCompany(stocks) {
  const byCompany = new Map();

  for (const stock of stocks) {
    const key = stock.cik ?? stock.symbol;
    const held = byCompany.get(key);

    if (!held || stock.turnover > held.turnover) byCompany.set(key, stock);
  }

  return [...byCompany.values()];
}

export async function refreshUsSectorMap(config, { now = new Date(), repoPath = snapshotRepoPath() } = {}) {
  if (running || isRegularSession("US", now)) return { rendered: false };

  running = true;

  try {
    let stocks = await usSessionStocks(config);
    const sessionDate = stocks[0]?.day;

    if (!sessionDate) return { rendered: false };

    const lastSample = Math.max(...stocks.map((stock) => new Date(stock.observed_at).getTime()));

    if (now.getTime() - lastSample < settleMs) return { rendered: false };
    if ((await readMeta(repoPath))?.sessionDate === sessionDate) return { rendered: false };
    if (await fillMissingCaps(config, stocks) > 0) stocks = await usSessionStocks(config);

    const ranked = onePerCompany(stocks.filter((stock) => stock.cap > 0))
      .sort((a, b) => b.cap - a.cap)
      .slice(0, mapSize);
    const dataPath = path.join(tmpdir(), "date-us-sector-map.json");

    await writeFile(dataPath, JSON.stringify({
      sessionDate,
      stocks: ranked.map(({ cap, name, rate, sector, symbol }) => ({ cap, name, rate, sector, symbol }))
    }), "utf8");
    await run(config.pythonBin, [scriptPath, dataPath, path.join(repoPath, imageName)], { timeout: 120_000, windowsHide: true });
    await writeFile(path.join(repoPath, metaName), `${JSON.stringify({
      renderedAt: now.toISOString(),
      sessionDate,
      stocks: ranked.length
    }, null, 2)}\n`, "utf8");

    return { rendered: true, sessionDate, stocks: ranked.length };
  } finally {
    running = false;
  }
}

/*
 * 보드에 싣는 주소. 텔레그램은 같은 URL을 캐시하므로 세션 날짜를 붙여 매일 새 주소로 만듭니다.
 * 그림이 아직 없으면 null -- 브리핑이 "확인 불가"로 넘어갑니다.
 */
export async function loadUsSectorMap({ repoPath = snapshotRepoPath() } = {}) {
  const meta = await readMeta(repoPath);

  if (!meta?.sessionDate) return null;

  return {
    sessionDate: meta.sessionDate,
    stocks: meta.stocks,
    url: `https://raw.githubusercontent.com/dblekw87/date-board-snapshot/main/${imageName}?v=${meta.sessionDate}`
  };
}
