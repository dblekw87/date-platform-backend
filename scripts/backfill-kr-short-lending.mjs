import { getAccessToken } from "../src/providers/kis.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";
import { readLending, readShortSale, saveLending, saveShortSale } from "../src/providers/short-lending.mjs";

/**
 * 국내 공매도·대차 일별을 종목마다 과거까지 채웁니다.
 *
 *   npm run kr:short-lending
 *   npm run kr:short-lending -- --from=2025-03-31 --symbols=028050,042510
 *
 * 창은 130일씩 자릅니다. KIS가 한 번에 100행만 주고 창이 길면 최근 것만 주므로,
 * 130 달력일(≈90거래일)이면 한 창이 한 응답에 들어갑니다. 종목당 10요청, 전 종목
 * 2.6만 요청쯤이라
 * 수집기와 KIS 한도를 나눠 쓰지 않는 주말·저녁에 돌립니다.
 *
 * 이미 받은 종목은 건너뜁니다(두 표 모두 --from과 --to 근처 행이 있으면). 다시 받으려면 --force.
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compact(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function windows(fromIso, toIso, days) {
  const result = [];
  const end = new Date(`${toIso}T00:00:00Z`);

  for (let start = new Date(`${fromIso}T00:00:00Z`); start <= end;) {
    const stop = new Date(Math.min(start.getTime() + (days - 1) * 86400000, end.getTime()));

    result.push({ from: compact(start), to: compact(stop) });
    start = new Date(stop.getTime() + 86400000);
  }

  return result;
}

async function withRetry(task, label) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      // KIS answers a burst with an error rather than a wait.
      if (attempt >= 3) {
        console.log(`  ${label} 실패: ${error.message}`);

        return [];
      }

      await sleep(1000 * attempt);
    }
  }
}

const config = readConfig();
const from = readOption("from", "2025-03-31");
const to = readOption("to", new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
const force = process.argv.includes("--force");
const pauseMs = Number(readOption("pause", "150"));
const lanes = Number(readOption("lanes", "4"));
const explicit = readOption("symbols", "");

let symbols = explicit
  ? explicit.split(",").map((symbol) => symbol.trim()).filter(Boolean)
  : (await query(config, `
      SELECT DISTINCT symbol FROM kr_daily_bars
       WHERE session_date >= $1::date AND symbol ~ '^[0-9]{6}$' ORDER BY symbol
    `, [from])).rows.map((row) => row.symbol);

if (!force && !explicit) {
  const done = new Set((await query(config, `
    SELECT s.symbol FROM
      (SELECT symbol FROM kr_short_sale GROUP BY symbol
         HAVING min(session_date) <= $1::date + 14 AND max(session_date) >= $2::date - 14) s
      JOIN (SELECT symbol FROM kr_stock_lending GROUP BY symbol
         HAVING min(session_date) <= $1::date + 14 AND max(session_date) >= $2::date - 14) l USING (symbol)
  `, [from, to])).rows.map((row) => row.symbol));

  symbols = symbols.filter((symbol) => !done.has(symbol));
}

const spans = windows(from, to, 130);

console.log(`${from}~${to} · ${symbols.length}종목 · 창 ${spans.length}개 · 종목당 ${spans.length * 2}요청`);

let token = await getAccessToken(config);
let shortRows = 0;
let lendingRows = 0;
const startedAt = Date.now();

let next = 0;
let finished = 0;

async function fillSymbol(symbol) {
  for (const span of spans) {
    const shorts = await withRetry(() => readShortSale(config, token, symbol, span), `${symbol} 공매도 ${span.from}`);

    shortRows += await saveShortSale(config, shorts);
    await sleep(pauseMs);

    const loans = await withRetry(() => readLending(config, token, symbol, span), `${symbol} 대차 ${span.from}`);

    lendingRows += await saveLending(config, loans);
    await sleep(pauseMs);
  }
}

// One KIS round trip is close to a second, so a single lane would take most of a
// day for every listed name. A few lanes stay well under KIS's per-second limit.
async function lane() {
  while (next < symbols.length) {
    const symbol = symbols[next];

    next += 1;
    await fillSymbol(symbol);
    finished += 1;

    if (finished % 50 === 0 || finished === symbols.length) {
      const minutes = (Date.now() - startedAt) / 60000;

      console.log(`${finished}/${symbols.length} · 공매도 ${shortRows} · 대차 ${lendingRows} · ${minutes.toFixed(1)}분`);
      // The cached token outlives this run, but refresh it in case a long run crosses expiry.
      token = await getAccessToken(config);
    }
  }
}

await Promise.all(Array.from({ length: lanes }, () => lane()));

console.log(`done · 공매도 ${shortRows} rows · 대차 ${lendingRows} rows`);
process.exit(0);
