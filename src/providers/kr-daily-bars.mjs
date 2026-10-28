import { fetchText } from "../http.mjs";
import { query } from "../db/client.mjs";
import { loadKrDailyBarsFromKis } from "./kis.mjs";

/**
 * 국내 일봉 — 시가가 있는 유일한 표.
 *
 * 종가배팅은 전일 종가와 당일 시가 둘로 판정됩니다. 분봉에는 등락률만 있고 그건
 * 전일 종가 기준이라 09:00 첫 표본이 갭의 근사치는 되지만, 순위권 밖 종목에는
 * 그 표본 자체가 없습니다. 일봉은 빠짐이 없고 과거로도 갑니다.
 *
 * 네이버 siseJson은 키가 없고 종목당 1.6년치를 한 번에 줍니다. 응답이 JSON이
 * 아니라 작은따옴표를 쓰는 JS 배열 리터럴이라 그대로 파싱되지 않습니다.
 */

const chartUrl = "https://api.finance.naver.com/siseJson.naver";

// 종목 사이의 간격. 600종목을 쉬지 않고 두드릴 이유가 없습니다.
const requestSpacingMs = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toNumber(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}

function yyyymmdd(value) {
  return String(value).replace(/-/g, "");
}

/**
 * 응답 본문에서 데이터 행만 꺼냅니다.
 *
 * 머리 행은 한글 컬럼명이라 날짜로 시작하지 않고, 그 조건 하나로 걸러집니다.
 * 정규식으로 읽는 이유는 본문이 JSON이 아니어서입니다 -- 작은따옴표와 후행 쉼표가
 * 섞여 있어 JSON.parse가 그대로는 실패합니다.
 */
function parseBars(symbol, text) {
  const bars = [];

  for (const match of String(text ?? "").matchAll(/\["(\d{8})",\s*([^\]]+)\]/g)) {
    const [open, high, low, close, volume, foreignRatio] = match[2].split(",").map((part) => toNumber(part.trim()));
    const day = match[1];

    if (!close) continue;

    bars.push({
      close,
      foreignRatio,
      high,
      low,
      open,
      sessionDate: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`,
      symbol,
      volume
    });
  }

  return bars;
}

/*
 * 종목별 52주 고가와 역대 고가.
 *
 * 2026-10-28 사용자 요청: 종가배팅 후보가 신고가까지 얼마 남았는지 같이 보고 싶다
 * (삼성E&A처럼 52주 고점 바로 아래에서 사는 경우). 후보 조건은 60일 고점 돌파라
 * 그보다 위의 천장이 어디인지는 알림에 없었습니다.
 *
 * 52주는 우리 일봉에서, 역대는 네이버 월봉(1990~)에서 읽습니다. 월봉은 **수정주가**라
 * 분할·병합 전 값도 지금 주가와 같은 자로 비교됩니다. 역대 고가는 하루에 바뀔 일이
 * 거의 없어 세션 날짜와 함께 기억해 둡니다.
 */
const allTimeCache = new Map();

export async function loadKrPriceCeilings(config, symbols, day) {
  if (!symbols.length) return new Map();

  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, high::float8 AS high, to_char(session_date, 'YYYY-MM-DD') AS at
      FROM kr_daily_bars
     WHERE symbol = ANY($1) AND high > 0 AND session_date > $2::date - interval '365 days'
     ORDER BY symbol, high DESC, session_date DESC`, [symbols, day]);
  const ceilings = new Map(rows.map((row) => [row.symbol, { weekHigh: row.high, weekHighAt: row.at }]));

  for (const symbol of symbols) {
    const cached = allTimeCache.get(symbol);
    let allTime = cached?.day === day ? cached.value : undefined;

    if (allTime === undefined) {
      const months = await fetchText(
        `${chartUrl}?symbol=${symbol}&requestType=1&startTime=19900101&endTime=${yyyymmdd(day)}&timeframe=month`,
        { timeoutMs: 8_000 }
      ).then((text) => parseBars(symbol, text)).catch(() => []);
      const top = months.reduce((best, bar) => (bar.high > (best?.high ?? 0) ? bar : best), null);

      allTime = top ? { high: top.high, month: top.sessionDate.slice(0, 7) } : null;
      allTimeCache.set(symbol, { day, value: allTime });
      await sleep(requestSpacingMs);
    }

    ceilings.set(symbol, { ...(ceilings.get(symbol) ?? {}), allTimeHigh: allTime?.high ?? null, allTimeHighMonth: allTime?.month ?? null });
  }

  return ceilings;
}

export async function loadKrDailyBars(symbol, { from, to }) {
  const url = `${chartUrl}?symbol=${symbol}&requestType=1&startTime=${yyyymmdd(from)}&endTime=${yyyymmdd(to)}&timeframe=day`;

  return parseBars(symbol, await fetchText(url, { timeoutMs: 12_000 }));
}

export async function saveKrDailyBars(config, bars) {
  if (!config.databaseUrl || bars.length === 0) return 0;

  const columns = 8;
  const values = bars.flatMap((bar) => [
    bar.symbol,
    bar.sessionDate,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.foreignRatio
  ]);
  const placeholders = bars
    .map((_, index) => `(${Array.from({ length: columns }, (__, offset) => `$${index * columns + offset + 1}`).join(", ")})`)
    .join(", ");
  const result = await query(config, `
    INSERT INTO kr_daily_bars (symbol, session_date, open, high, low, close, volume, foreign_ratio)
    VALUES ${placeholders}
    ON CONFLICT (symbol, session_date) DO UPDATE SET
      close = EXCLUDED.close,
      foreign_ratio = EXCLUDED.foreign_ratio,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      observed_at = now(),
      open = EXCLUDED.open,
      volume = EXCLUDED.volume
  `, values);

  return result.rowCount;
}

/**
 * 여러 종목을 차례로. 한 종목이 실패하면 그 종목만 빠집니다.
 *
 * 한 종목이 1.6년치를 25KB로 돌려주므로 600종목이 15MB 남짓이고, 한 번에 하나씩
 * 저장합니다 -- 전부 모았다가 한 번에 넣으면 24만 행짜리 INSERT가 됩니다.
 */
export async function collectKrDailyBars(config, symbols, { from, log = () => {}, to }) {
  let failed = 0;
  let saved = 0;

  for (const [index, symbol] of symbols.entries()) {
    try {
      saved += await saveKrDailyBars(config, await loadKrDailyBars(symbol, { from, to }));
    } catch (error) {
      failed += 1;
      log(`kr daily bars ${symbol} failed: ${error instanceof Error ? error.message : error}`);
    }

    if ((index + 1) % 100 === 0) log(`kr daily bars · ${index + 1}/${symbols.length} · ${saved} rows`);

    await sleep(requestSpacingMs);
  }

  return { failed, saved };
}

/**
 * 공식 일봉으로 되받기 -- 과거 날짜용.
 *
 * 네이버 일봉은 2026-09-14부터 애프터마켓 가격을 종가에 씁니다(kis.mjs의
 * loadKrDailyBarsFromKis 머리말). 15:50 수집은 애프터마켓이 열리기 전이라 네이버로도
 * 맞지만, 그 창을 놓친 날과 오염된 날을 고치는 것은 KIS로만 합니다. foreign_ratio는
 * KIS 일봉에 없어 있던 값을 그대로 둡니다.
 */
export async function collectKrDailyBarsFromKis(config, symbols, { from, log = () => {}, to, spacingMs = 120 }) {
  let failed = 0;
  let saved = 0;

  for (const [index, symbol] of symbols.entries()) {
    try {
      const bars = await loadKrDailyBarsFromKis(config, symbol, { from, to });

      saved += await saveKrDailyBarsKeepingForeign(config, bars);
    } catch (error) {
      failed += 1;
      log(`kis daily bars ${symbol} failed: ${error instanceof Error ? error.message : error}`);
    }

    if ((index + 1) % 200 === 0) log(`kis daily bars · ${index + 1}/${symbols.length} · ${saved} rows · ${failed} failed`);

    await sleep(spacingMs);
  }

  return { failed, saved };
}

async function saveKrDailyBarsKeepingForeign(config, bars) {
  if (!config.databaseUrl || bars.length === 0) return 0;

  const columns = 7;
  const values = bars.flatMap((bar) => [bar.symbol, bar.sessionDate, bar.open, bar.high, bar.low, bar.close, bar.volume]);
  const placeholders = bars
    .map((_, index) => `(${Array.from({ length: columns }, (__, offset) => `$${index * columns + offset + 1}`).join(", ")})`)
    .join(", ");
  const result = await query(config, `
    INSERT INTO kr_daily_bars (symbol, session_date, open, high, low, close, volume)
    VALUES ${placeholders}
    ON CONFLICT (symbol, session_date) DO UPDATE SET
      close = EXCLUDED.close,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      observed_at = now(),
      open = EXCLUDED.open,
      volume = EXCLUDED.volume
  `, values);

  return result.rowCount;
}
