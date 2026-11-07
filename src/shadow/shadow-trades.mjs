import { loadCloseBetPicks } from "../providers/close-bet-alert.mjs";
import { loadKrQuotes } from "../providers/kis.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "../providers/market-session.mjs";

/**
 * 그림자 매매 -- 주문은 내지 않고, 규칙대로 샀다면 어떻게 됐을지를 적습니다.
 *
 * 2026-11-08 사용자가 시스템 트레이딩(자동매매)을 검토했습니다. 자동화는 규칙을
 * 어기지 않게 해 주지만 엣지를 만들어 주지는 않으므로, 진짜 주문 전에 "기계가
 * 규칙대로 했다면"을 한 달쯤 적어 사람의 실제 매매와 나란히 봅니다.
 *
 * **이 파일에는 주문 코드가 없습니다.** 시세 조회만 합니다. 실주문은 그림자 성적을
 * 본 뒤에 별도 프로세스로 붙입니다.
 *
 * 종가배팅 하루의 흐름:
 *
 *   15:20~15:29  알림과 같은 목록(loadCloseBetPicks)을 장부에 적습니다. 상한가에
 *                잠겼는지·매수잔량도 같이 -- 그 줄 뒤에 서면 종가에 거의 안 채워집니다
 *   15:40~       KRX 종가로 진입가를 채우고 체결 여부를 판정합니다
 *   다음 장 09:07~09:30  현재가·시가·저가를 적습니다. 청산 규칙이 09:05~09:10이라
 *                그 가운데를 씁니다
 *
 * 수익률·손절·비용은 장부가 아니라 리포트(scripts/shadow-report.mjs)가 계산합니다.
 * 장부에는 관측값만 두어야 비용 가정이나 손절 폭을 바꿔도 다시 잴 수 있습니다.
 */

const strategy = "close_bet";
const pickStartMinute = 15 * 60 + 20;
const pickEndMinute = 15 * 60 + 30;
const settleMinute = 15 * 60 + 40;
const exitStartMinute = 9 * 60 + 7;
const exitEndMinute = 9 * 60 + 30;
/* 상한가로 보는 문턱. close-bet-alert.mjs·limit-up-queue.mjs와 같은 값입니다. */
const limitUpRate = 29.5;
/* 사용자 손절 규칙(2026-10-22): 종가배팅은 시총 1조 이상 −2%, 그 아래 −3%. */
const largeCapWon = 1_000_000_000_000;

let running = false;

export async function runShadowTrades(config, minute) {
  if (running || !config.databaseUrl) return;

  running = true;

  try {
    const day = sessionDate("KR");

    if (minute >= exitStartMinute && minute < exitEndMinute) await recordExits(config, day);
    if (minute >= pickStartMinute && minute < pickEndMinute) await recordPicks(config, day);
    if (minute >= settleMinute) await settleEntries(config, day);
  } catch (error) {
    console.warn("shadow trades failed", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

/*
 * 하루 한 번. 이미 적은 날은 건너뜁니다. 목록이 비었으면 적지 않고 다음 틱에 다시
 * 봅니다 -- 15:29까지는 종가 단일가에 넣을 수 있으니 늦게 들어온 것도 살 수 있었던
 * 종목입니다.
 */
async function recordPicks(config, day) {
  const { rows } = await query(config, `
    SELECT 1 FROM shadow_trades WHERE strategy = $1 AND session_date = $2::date LIMIT 1`, [strategy, day]);

  if (rows.length) return;

  const { picks } = await loadCloseBetPicks(config, day);

  for (const row of picks) {
    const locked = Boolean(row.lock && row.lock.locked !== false);
    const material = row.material ? `${row.material.kind} ${row.material.at} ${row.material.text}`.slice(0, 300) : null;

    await query(config, `
      INSERT INTO shadow_trades
        (strategy, session_date, symbol, name, tier, market_cap, material, pick_price, pick_rate, locked, bid_queue, stop_pct)
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING`, [
      strategy,
      day,
      row.symbol,
      row.name,
      row.tier,
      row.marketCapValue,
      material,
      row.closePrice,
      row.changeRateValue,
      locked,
      locked ? row.lock.queue ?? null : null,
      row.marketCapValue >= largeCapWon ? 2 : 3
    ]);
  }

  if (picks.length) console.log(`그림자: 종가배팅 ${picks.length}종목 기록 · ${picks.map((row) => row.name).join(", ")}`);
}

/*
 * 체결 판정. 15:30 뒤 KRX 시세는 종가에서 멈춥니다(kis.mjs loadKrQuotes 주석) --
 * 그래서 J로 물으면 종가가 옵니다.
 *
 * 고를 때 잠겨 있었고 **종가에도 상한가**면 못 산 것으로 둡니다. 2026-10-11 실측에서
 * 마감 체결량은 줄 선 매수잔량의 중앙 6%였습니다. 종가에 상한가가 풀렸으면 매도가
 * 나왔다는 뜻이라 산 것으로 둡니다 -- 그게 "체결되면 무너지는 날"(−0.68%p) 칸입니다.
 */
async function settleEntries(config, day) {
  const { rows } = await query(config, `
    SELECT symbol, locked FROM shadow_trades
     WHERE strategy = $1 AND session_date = $2::date AND entry_price IS NULL`, [strategy, day]);

  if (!rows.length) return;

  const quotes = new Map((await loadKrQuotes(config, rows.map((row) => row.symbol), "J")).map((quote) => [quote.symbol, quote]));

  for (const row of rows) {
    const quote = quotes.get(row.symbol);

    if (!quote) continue;

    await saveEntry(config, day, row, quote.priceValue, quote.changeRateValue);
  }
}

async function saveEntry(config, day, row, close, closeRate) {
  const stillLocked = row.locked && closeRate >= limitUpRate;
  const note = row.locked
    ? (stillLocked ? "상한가 잠김 유지 · 종가 체결 안 됨으로 봄" : "잠겼다가 풀림 · 종가 체결로 봄")
    : null;

  await query(config, `
    UPDATE shadow_trades SET entry_price = $4, entry_rate = $5, filled = $6, fill_note = $7
     WHERE strategy = $1 AND session_date = $2::date AND symbol = $3`,
  [strategy, day, row.symbol, close, closeRate, !stillLocked, note]);
}

/*
 * 청산. 어제(또는 그 전) 산 것 중 아직 안 판 것을 지금 값으로 적습니다.
 *
 * 저녁 틱을 놓쳐 진입가가 비어 있으면 일봉 종가로 채웁니다. 일봉은 06:20 KIS
 * 되받기 뒤라 정규장 종가입니다(네이버 일봉은 애프터 가격을 섞습니다).
 */
async function recordExits(config, day) {
  await settleFromDailyBars(config, day);

  const { rows } = await query(config, `
    SELECT session_date::text AS day, symbol FROM shadow_trades
     WHERE strategy = $1 AND session_date < $2::date AND filled AND exit_price IS NULL`, [strategy, day]);

  if (!rows.length) return;

  const quotes = new Map((await loadKrQuotes(config, rows.map((row) => row.symbol), "J")).map((quote) => [quote.symbol, quote]));

  for (const row of rows) {
    const quote = quotes.get(row.symbol);

    if (!quote) continue;

    await query(config, `
      UPDATE shadow_trades SET exit_date = $4::date, exit_at = now(), exit_price = $5, exit_open = $6, exit_low = $7
       WHERE strategy = $1 AND session_date = $2::date AND symbol = $3`,
    [strategy, row.day, row.symbol, day, quote.priceValue, quote.openValue, quote.lowValue]);
  }

  console.log(`그림자: 종가배팅 청산 ${rows.filter((row) => quotes.has(row.symbol)).length}/${rows.length}`);
}

async function settleFromDailyBars(config, day) {
  const { rows } = await query(config, `
    SELECT t.session_date::text AS day, t.symbol, t.locked, b.close::float8 AS close,
           (b.close / nullif(p.close, 0) - 1) * 100 AS close_rate
      FROM shadow_trades t
      JOIN kr_daily_bars b ON b.symbol = t.symbol AND b.session_date = t.session_date
      LEFT JOIN LATERAL (
        SELECT close FROM kr_daily_bars
         WHERE symbol = t.symbol AND session_date < t.session_date
         ORDER BY session_date DESC LIMIT 1) p ON true
     WHERE t.strategy = $1 AND t.session_date < $2::date AND t.entry_price IS NULL`, [strategy, day]);

  for (const row of rows) await saveEntry(config, row.day, row, row.close, Number(row.close_rate));
}
