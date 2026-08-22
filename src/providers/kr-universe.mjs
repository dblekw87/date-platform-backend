import { fetchJson } from "../http.mjs";
import { query } from "../db/client.mjs";

/**
 * 국내 전 종목의 하루 — 순위 밖에서 벌어진 일까지.
 *
 * 1분 표본은 KIS 랭킹 상위 30개와 짝꿍 후보만 봅니다. 그 바깥에서 상한가를 간
 * 종목은 우리 기록에 존재하지 않고, 순위에 들었다 빠진 종목은 종가가 없습니다.
 * 하루 한 번 4,300종목을 통째로 받아 두면 최소한 사후 복원은 됩니다.
 *
 * 네이버 모바일 증권의 시가총액 목록입니다. 키가 필요 없고 100종목씩 끊어 주며,
 * 종목마다 거래정지 여부를 같이 줍니다 — 그건 다른 무료 소스에 없습니다.
 */

const listUrl = "https://m.stock.naver.com/api/stocks/marketValue";
const pageSize = 100;

// 두 시장을 각각 물어봐야 합니다. 합쳐 주는 파라미터가 없습니다.
const markets = ["KOSPI", "KOSDAQ"];

// 페이지 사이의 간격. 44번을 쉬지 않고 두드릴 이유가 없습니다.
const pageDelayMs = 200;

// 폭주 방지. 한 시장이 이보다 많을 리 없고, 응답이 이상해졌을 때 무한히 돌지
// 않게 하는 상한입니다.
const maxPages = 60;

function toNumber(value) {
  if (value === null || value === undefined) return null;

  const numeric = Number(String(value).replace(/,/g, ""));

  return Number.isFinite(numeric) ? numeric : null;
}

function scaled(value, factor) {
  const numeric = toNumber(value);

  return numeric === null ? null : numeric * factor;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toRow(stock, market) {
  return {
    // 네이버는 거래대금을 백만원, 시가총액을 억원으로 줍니다. 다른 표가 전부
    // 원이므로 여기서 맞춥니다.
    changeRate: stock.compareToPreviousPrice?.code === "5" || stock.compareToPreviousPrice?.code === "4"
      ? -Math.abs(toNumber(stock.fluctuationsRatio) ?? 0)
      : toNumber(stock.fluctuationsRatio),
    closePrice: toNumber(stock.closePrice),
    market,
    marketCap: scaled(stock.marketValue, 100_000_000),
    name: stock.stockName,
    symbol: stock.itemCode,
    tradeHalted: stock.tradableStatus !== "tradable" || stock.tradeStopType?.name === "HALTED",
    turnover: scaled(stock.accumulatedTradingValue, 1_000_000),
    volume: toNumber(stock.accumulatedTradingVolume)
  };
}

/**
 * 두 시장의 모든 종목. 한 페이지가 실패하면 그 페이지만 빠집니다.
 */
export async function loadKrUniverse() {
  const rows = [];

  for (const market of markets) {
    const first = await fetchJson(`${listUrl}/${market}?page=1&pageSize=${pageSize}`, { timeoutMs: 10_000 });
    const total = Number(first?.totalCount ?? 0);

    if (!Array.isArray(first?.stocks)) continue;

    rows.push(...first.stocks.map((stock) => toRow(stock, market)));

    const pages = Math.min(maxPages, Math.ceil(total / pageSize));

    for (let page = 2; page <= pages; page += 1) {
      await sleep(pageDelayMs);

      try {
        const next = await fetchJson(`${listUrl}/${market}?page=${page}&pageSize=${pageSize}`, { timeoutMs: 10_000 });

        if (Array.isArray(next?.stocks)) rows.push(...next.stocks.map((stock) => toRow(stock, market)));
      } catch (error) {
        console.warn(`kr universe ${market} page ${page} failed`, error instanceof Error ? error.message : error);
      }
    }
  }

  return rows;
}

/**
 * 같은 날을 다시 받으면 덮어씁니다.
 *
 * 장중에 한 번 받고 마감 뒤에 다시 받는 것이 정상 경로입니다. 뒤에 받은 것이
 * 종가에 가까우므로 먼저 것을 남겨둘 이유가 없습니다.
 */
export async function saveKrUniverse(config, { rows, sessionDate }) {
  if (!config.databaseUrl || rows.length === 0) return 0;

  const columns = 9;
  const values = rows.flatMap((row) => [
    sessionDate,
    row.symbol,
    row.name,
    row.market,
    row.closePrice,
    row.changeRate,
    row.volume,
    row.turnover,
    row.marketCap
  ]);
  const placeholders = rows
    .map((row, index) => `(${Array.from({ length: columns }, (_, offset) => `$${index * columns + offset + 1}`).join(", ")}, $${rows.length * columns + (row.tradeHalted ? 1 : 2)})`)
    .join(", ");
  const result = await query(config, `
    INSERT INTO kr_daily_universe (
      session_date, symbol, name, market, close_price,
      change_rate, volume, turnover, market_cap, trade_halted
    )
    VALUES ${placeholders}
    ON CONFLICT (session_date, symbol) DO UPDATE SET
      close_price = EXCLUDED.close_price,
      change_rate = EXCLUDED.change_rate,
      market_cap = EXCLUDED.market_cap,
      name = EXCLUDED.name,
      observed_at = now(),
      trade_halted = EXCLUDED.trade_halted,
      turnover = EXCLUDED.turnover,
      volume = EXCLUDED.volume
  `, [...values, true, false]);

  return result.rowCount;
}

// 거래정지는 시총과 같이 봐야 뜻이 생깁니다. 한화 5.9조가 멈춘 것과 삼부토건
// 797억이 멈춘 것은 같은 사건이 아닙니다.
const largeCapFloor = 1_000_000_000_000;
const midCapFloor = 300_000_000_000;

function sizeOf(marketCap) {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "unknown";

  if (marketCap >= largeCapFloor) return "large-cap";

  return marketCap >= midCapFloor ? "mid-cap" : "small-cap";
}

/**
 * 정지 사유를 공시 제목에서 꺼냅니다.
 *
 * 거래소 안내 공시는 사유를 괄호에 답니다 -- "주권매매거래정지 (주식의 병합, 분할
 * 등 전자등록 변경, 말소)", "주권매매거래정지해제 (상장폐지에 따른 정리매매 개시)".
 * 괄호가 없으면 보고서 이름 자체가 답입니다.
 */
function haltReasonFrom(title) {
  const reportName = String(title ?? "").split("·").pop()?.trim() ?? "";
  const inBrackets = reportName.match(/\(([^)]{4,})\)\s*$/);

  return (inBrackets?.[1] ?? reportName.replace(/\s+/g, " ")).trim() || null;
}

/**
 * 오늘 멈춰 있는 종목들, 큰 것부터 -- 사유를 알면 사유와 함께.
 *
 * 해제일은 어디에도 없습니다. 확인한 것: 네이버 전종목 API는 정지 여부만 주고,
 * 종목 상세에는 정지·해제 문자열이 아예 없으며, 거래소 KIND의 매매거래정지 목록은
 * 실제 브라우저로 열어야 하는 데다 열어 봐도 컬럼이 시장·종목·사유뿐이라 날짜가
 * 없고, DART 원문 API는 이 시장안내 공시에 CSS만 든 1.5KB 껍데기를 돌려줍니다.
 *
 * 애초에 대부분의 정지에는 해제일이 존재하지 않습니다 -- 조회공시요구는 회사가
 * 답하면 풀리고 상장적격성 실질심사는 결과가 나와야 풀립니다. 날짜가 정해진 것은
 * 주식병합·액면분할처럼 일정이 잡힌 정지뿐입니다.
 *
 * 대신 사유는 공시에 있습니다. 지금은 정지 138종목 중 1종목만 걸립니다 -- 공시를
 * 하루치만 모았고 나머지는 그 전에 멈췄기 때문입니다. 수집은 이미 돌고 있으므로
 * 앞으로 걸리는 정지는 이 조인으로 저절로 채워집니다. 조인을 지금 만들어 두는
 * 이유가 그것입니다: 기다리는 것이 나중에 또 작업이 되지 않도록.
 *
 * 가장 최근에 받아둔 날을 기준으로 답합니다. 주말이나 개장 전에 "정지 종목 없음"이
 * 아니라 직전 거래일의 상태를 보여주는 편이 맞습니다 -- 정지는 하루 만에 풀리는
 * 일이 드뭅니다.
 */
export async function loadHaltedStocks(config, { limit = 60 } = {}) {
  const result = await query(config, `
    SELECT u.session_date::text AS session_date, u.symbol, u.name, u.market,
           u.close_price, u.change_rate, u.market_cap, u.turnover,
           d.title AS halt_title, d.filed_at AS halted_at
      FROM kr_daily_universe u
      LEFT JOIN LATERAL (
        SELECT title, filed_at
          FROM market_disclosures
         WHERE market = 'KR' AND symbol = u.symbol
           AND title ~ '(매매거래정지|정리매매|상장폐지)'
         ORDER BY filed_at DESC
         LIMIT 1
      ) d ON true
     WHERE u.trade_halted
       AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe)
     ORDER BY u.market_cap DESC NULLS LAST
     LIMIT $1
  `, [limit]);

  return result.rows.map((row) => ({
    changeRateValue: row.change_rate === null ? null : Number(row.change_rate),
    closePrice: row.close_price === null ? null : Number(row.close_price),
    haltReason: row.halt_title ? haltReasonFrom(row.halt_title) : null,
    haltedAt: row.halted_at ? new Date(row.halted_at).toISOString() : null,
    id: `halt-${row.symbol}`,
    issuerType: sizeOf(Number(row.market_cap)),
    market: row.market,
    marketCapValue: row.market_cap === null ? null : Number(row.market_cap),
    name: row.name,
    sessionDate: row.session_date,
    symbol: row.symbol,
    turnoverValue: row.turnover === null ? null : Number(row.turnover)
  }));
}
