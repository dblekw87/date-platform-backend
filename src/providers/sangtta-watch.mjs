import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadLimitUpEvidence } from "./limit-up-evidence.mjs";
import { contextLines, loadThemeContext } from "./theme-context.mjs";
import { loadKrOrderBooks } from "./kis.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 상따 감시 -- 잠기기 전에, 규모에 맞는 거리에서.
 *
 * 2026-09-14 실측(일봉 20개월 5,070건 + 1분 표본 한 달 192건)이 이 파일의 근거입니다.
 *
 *   종가에 잠긴 상한가 → 익일 시가     +7.99%p  상회 80%   21개월 매달 흔들림 없음
 *   상한가 첫 터치에 샀다면(전체)       +2.36%p  상회 49%   41%가 풀리고 풀린 날 종가는 상한가 −11%
 *   잠김 30분 유지 뒤 살 기회가 있던 것  −5.39%p  상회 52%   **체결이 되는 것 자체가 나쁜 신호**
 *
 * 그래서 값은 잠기기 **전**에만 있고, 얼마나 전인가는 규모가 정합니다 -- 소형주는 27%에
 * 닿은 그 분에 잠기고(중앙 0분), 24%에서 3분, 22%에서 5분이 남습니다. 중·대형은 27%에서
 * 1~5분이 남습니다. 일찍 알릴수록 틀리는 비율이 오릅니다: 소형 24%는 열에 셋만 잠깁니다.
 *
 *   소형(<3천억) 24%     하루 17건   잠김 34%   24.5%에 사서 익일 시가 +0.71%p 상회 42%
 *   중형(3천억~1조) 27%  하루 1건    잠김 59%   +6.04%p 상회 59%
 *   대형(1조+) 27%       표본 6건    판단 불가
 *
 * 2026-09-14부터 **잠기기 전 알림은 이 파일 하나**입니다. limit-up-alert.mjs의 근접 알림
 * (27~29%, 근거 있을 때만)과 겹쳐 같은 종목이 두 통 오게 되어 사용자가 합치자고 했습니다.
 * 그래서 근거는 여기 붙이고, 처음 보낼 때 없던 근거(공시·지목 기사·지분)가 잠기기 전에
 * 붙으면 **한 번만** 더 보냅니다 -- 그게 예전 근접 알림이 하던 일입니다.
 *
 * 이것은 **매수 신호가 아니라 감시 목록**입니다. 24% 시점 변수로 갈라 봐도 잠김 확률은
 * 40%대에서 멈췄고, 빠진 변수(호가 잔량)는 이제 찍기 시작했습니다. 알림은 진입 결정을
 * 대신하지 않고, 그 종목을 호가창에 띄울 이유와 재 본 확률을 줍니다.
 */

const thresholds = [
  { label: "소형", minCap: 0, rate: 24 },
  { label: "중형", minCap: 3000e8, rate: 27 },
  { label: "대형", minCap: 1e12, rate: 27 }
];
const lockedRate = 29.5;
const alertIntervalMs = 60_000;
// 호가는 24% 위 전부, 한 틱에 이만큼까지. 한 종목 한 요청입니다.
const orderBookRate = 24;
const orderBookCap = 30;

let lastRunAt = 0;
let running = false;

function sizeOf(cap) {
  let size = thresholds[0];

  for (const candidate of thresholds) if ((cap ?? 0) >= candidate.minCap) size = candidate;

  return size;
}

export function sangttaWatchDue(now = Date.now()) {
  return now - lastRunAt >= alertIntervalMs;
}

export async function notifySangttaWatch(config, { url } = {}) {
  if (running || !notifyConfigured(config) || !sangttaWatchDue()) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const day = sessionDate("KR");
    const latest = await loadLatest(config, day);

    await sampleOrderBooks(config, day, latest);

    const sent = await loadAlertSent(config, "sangtta_watch", day);
    let posted = 0;

    for (const stock of latest) {
      const size = sizeOf(stock.market_cap);

      if (stock.change_rate < size.rate || stock.change_rate >= lockedRate) continue;

      if (sent.has(stock.symbol)) {
        posted += await followUpEvidence(config, day, stock, size, sent.get(stock.symbol), url);
        continue;
      }

      const path = await loadPath(config, day, stock, size);
      const drop = dropReason(path, size);

      /*
       * 안 보내는 조건은 재 본 것만 씁니다(소형 24% 340건). 하락 출발 18%, 24% 시점
       * 거래대금 50~200억 16%, 13:30 이후 22%, 22→24에 10분 넘게 걸린 것 21% --
       * 기본 34%의 절반이라 빼면 나머지가 40%대로 올라갑니다. 종목당 하루 한 통이므로
       * 걸린 종목은 그날 다시 오지 않습니다. 기록은 남겨 채점에는 들어갑니다.
       */
      await record(config, day, stock, size, path, drop);

      if (drop) {
        await markAlertSent(config, "sangtta_watch", day, stock.symbol, { note: `skip:${drop}` });
        continue;
      }

      const evidence = await loadLimitUpEvidence(config, { name: stock.name, symbol: stock.symbol, theme: stock.theme }, day);

      evidence.context = await loadThemeContext(config, stock.symbol, day).catch(() => []);

      if (!await notify(config, { text: message(stock, size, path, evidence), url })) continue;

      await markAlertSent(config, "sangtta_watch", day, stock.symbol, {
        note: `${size.label} ${stock.change_rate.toFixed(1)}%${hasSpecificEvidence(evidence) ? "" : " · 근거없음"}`
      });
      posted += 1;
      console.log(`알림: 상한가 직전 · ${stock.name} +${stock.change_rate.toFixed(1)}% · ${size.label}`);
    }

    return posted;
  } catch (error) {
    console.warn("sangtta watch failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

function hasSpecificEvidence(evidence) {
  return evidence.filings.length > 0 || evidence.kind === "direct" || evidence.kind === "family";
}

/*
 * 첫 통에 근거가 없었던 종목에, 잠기기 전에 근거가 붙으면 한 번 더.
 *
 * 예전 근접 알림(27~29%, 근거 있을 때만)이 하던 일을 여기로 옮긴 것입니다. 24%에서 "근거
 * 없음"으로 나간 소형주가 27%에서 공시가 뜨면 그건 새 사실이고, 그 한 통이 예전 알림의 값
 * 전부였습니다. note에 '근거없음'이 남아 있을 때만 다시 보고, 보내면 note를 갈아 두 번은
 * 안 갑니다. 이미 '건너뜀(skip:)'으로 기록된 종목은 그대로 둡니다 -- 나쁜 조건은 근거가
 * 생겨도 나쁜 조건입니다.
 */
async function followUpEvidence(config, day, stock, size, sentRecord, url) {
  const note = String(sentRecord?.note ?? "");

  if (!note.includes("근거없음")) return 0;

  const evidence = await loadLimitUpEvidence(config, { name: stock.name, symbol: stock.symbol, theme: stock.theme }, day);

  if (!hasSpecificEvidence(evidence)) return 0;

  evidence.context = await loadThemeContext(config, stock.symbol, day).catch(() => []);

  const lines = [
    `[상한가 직전 · 근거 추가] ${stock.name} ${stock.symbol} · 지금 +${stock.change_rate.toFixed(1)}%`,
    "앞서 근거 없이 보낸 종목에 공시·기사가 붙었습니다."
  ];

  for (const filing of evidence.filings.slice(0, 1)) lines.push(`  공시 ${filing.at} ${(filing.report_name ?? filing.title ?? "").slice(0, 50)}`);
  for (const item of evidence.news.slice(0, 1)) lines.push(`  ${evidence.kind === "family" ? "지분" : "뉴스"} ${item.at} ${item.headline.slice(0, 60)}`);
  lines.push(...contextLines(evidence.context));

  if (!await notify(config, { text: lines.join("\n"), url })) return 0;

  await markAlertSent(config, "sangtta_watch", day, stock.symbol, { note: `${size.label} ${stock.change_rate.toFixed(1)}% · 근거 추가` });
  console.log(`알림: 상한가 직전 근거 추가 · ${stock.name} +${stock.change_rate.toFixed(1)}%`);

  return 1;
}

/** 종목별 마지막 정규장 표본. 지금 값을 봅니다 -- 아침에 24%였다가 10%인 종목은 후보가 아닙니다. */
async function loadLatest(config, day) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name, change_rate::float8, turnover::float8, market_cap::float8, theme,
           observed_at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:krx%' AND source NOT LIKE '%:pair'
       AND change_rate IS NOT NULL AND observed_at >= now() - interval '6 minutes'
     ORDER BY symbol, observed_at DESC`, [day]);

  return rows;
}

/*
 * 그날의 경로. 22%·문턱에 처음 닿은 시각, 문턱 전 최저, 전일 거래대금.
 * 전부 알림 문장에 그대로 적히고, 안 보낼 조건도 여기서 나옵니다.
 */
async function loadPath(config, day, stock, size) {
  const { rows } = await query(config, `
    SELECT min(observed_at) FILTER (WHERE change_rate >= 22) AS t22,
           min(observed_at) FILTER (WHERE change_rate >= $3) AS t_rate,
           min(change_rate) FILTER (WHERE observed_at < (SELECT min(observed_at) FROM market_price_samples i
                                                          WHERE i.market = 'KR' AND i.session_date = $1::date AND i.symbol = $2 AND i.change_rate >= $3))::float8 AS low_before,
           (SELECT turnover::float8 FROM kr_daily_universe u WHERE u.symbol = $2 AND u.session_date < $1::date ORDER BY u.session_date DESC LIMIT 1) AS prev_turnover
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND symbol = $2 AND source LIKE 'kis:krx%'`,
    [day, stock.symbol, size.rate]);
  const row = rows[0] ?? {};
  const seoul = (value) => value ? new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul" }) : null;
  const minutes = row.t22 && row.t_rate ? Math.round((new Date(row.t_rate) - new Date(row.t22)) / 60_000) : null;
  const at = seoul(row.t_rate);
  const seoulMinute = at ? Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5)) : null;

  return {
    at,
    lowBefore: row.low_before,
    minute: seoulMinute,
    multiple: row.prev_turnover ? stock.turnover / row.prev_turnover : null,
    prevTurnover: row.prev_turnover,
    riseMinutes: minutes
  };
}

function dropReason(path, size) {
  // 소형에서 잰 조건입니다. 중·대형은 표본이 없어 시각 하나만 겁니다.
  if (path.minute !== null && path.minute >= 13 * 60 + 30) return "13:30 이후";
  if (size.label !== "소형") return null;
  if (path.lowBefore !== null && path.lowBefore < 0) return "하락 출발";
  if (path.riseMinutes !== null && path.riseMinutes > 10) return "22→24 10분 초과";

  return null;
}

/*
 * 참고치. 조합 확률은 재지 않았으므로 **해당하는 조건과 그 조건 하나의 실측 잠김률**만
 * 적습니다. 두 조건을 곱해 읽으면 틀립니다 -- 서로 독립이 아닙니다.
 */
function flags(stock, size, path) {
  const out = [];

  if (size.label !== "소형") return out;
  if (path.lowBefore === null) out.push("시가부터 24% 위 · 실측 잠김 48%");
  if (path.riseMinutes !== null && path.riseMinutes <= 1) out.push("22→24 수직 · 39%");
  if (path.multiple !== null && path.multiple < 3) out.push("전일 거래대금 3배 미만 · 39%");
  if (path.minute !== null && path.minute < 9 * 60 + 30) out.push("09:30 전 · 41%");
  if (stock.turnover >= 50e8 && stock.turnover < 200e8) out.push("거래대금 50~200억 · 16% (나쁨)");

  return out;
}

function message(stock, size, path, evidence) {
  const eok = (value) => `${(Number(value ?? 0) / 1e8).toFixed(0)}억`;
  const base = size.label === "소형" ? "소형 24% 기본 잠김 34% · 24.5% 매수→익일 시가 +0.7%p"
    : size.label === "중형" ? "중형 27% 기본 잠김 59% · +6.0%p 상회 59%"
      : "대형 27% · 표본 6건, 참고치 없음";
  const theme = stock.theme && stock.theme !== "미분류" ? ` · ${stock.theme}` : "";
  const multiple = path.multiple !== null ? ` (전일의 ${path.multiple.toFixed(1)}배)` : "";
  const low = path.lowBefore === null ? "시가부터 문턱 위" : `그날 최저 ${path.lowBefore >= 0 ? "+" : ""}${path.lowBefore.toFixed(1)}%`;
  const rise = path.riseMinutes !== null ? ` · 22→${size.rate}% ${path.riseMinutes}분` : "";
  const lines = [
    `[상한가 직전] ${stock.name} ${stock.symbol} · ${size.label} ${eok(stock.market_cap)}${theme}`,
    `${path.at ?? ""} +${stock.change_rate.toFixed(1)}% · 거래대금 ${eok(stock.turnover)}${multiple}`,
    `  경로: ${low}${rise}`
  ];

  for (const flag of flags(stock, size, path)) lines.push(`  · ${flag}`);

  for (const filing of evidence.filings.slice(0, 1)) {
    lines.push(`  공시 ${filing.at} ${(filing.report_name ?? filing.title ?? "").slice(0, 50)}`);
  }

  if (evidence.kind === "direct" || evidence.kind === "family") {
    for (const item of evidence.news.slice(0, 1)) {
      lines.push(`  ${evidence.kind === "family" ? "지분" : "뉴스"} ${item.at} ${item.headline.slice(0, 60)}`);
    }
  }

  if (!evidence.filings.length && evidence.kind !== "direct" && evidence.kind !== "family") lines.push("  공시·지목 기사 없음");

  lines.push(...contextLines(evidence.context ?? []));

  lines.push("");
  lines.push(`감시 목록입니다, 매수 신호가 아닙니다. ${base}`);
  lines.push("들어가면 익일 09:00~09:05 시가 매도 · 잠기지 못하고 25% 아래로 밀리면 이탈.");

  return lines.join("\n");
}

async function record(config, day, stock, size, path, drop) {
  await query(config, `
    INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
    VALUES ('sangtta_watch', $1::date, $2, now(), $3, $4, $5)
    ON CONFLICT (kind, session_date, symbol) DO NOTHING`,
    [day, stock.symbol, `${size.label}${drop ? ` · 제외(${drop})` : ""}`, stock.theme ?? null, stock.change_rate]);
}

/*
 * 호가 잔량 기록. 24% 위 전부, 알림과 무관하게, 잠긴 것도 포함합니다 -- "잠긴 뒤 잔량이
 * 어떻게 변하나"가 풀림을 미리 말해 줄 수 있는 자리입니다.
 */
async function sampleOrderBooks(config, day, latest) {
  const targets = latest
    .filter((stock) => stock.change_rate >= orderBookRate)
    .sort((a, b) => b.change_rate - a.change_rate)
    .slice(0, orderBookCap);

  if (!targets.length) return;

  const books = await loadKrOrderBooks(config, targets.map((stock) => stock.symbol)).catch((error) => {
    console.warn("order book sample failed", error instanceof Error ? error.message : error);

    return [];
  });
  const rate = new Map(targets.map((stock) => [stock.symbol, stock.change_rate]));

  for (const book of books) {
    await query(config, `
      INSERT INTO kr_order_book_samples (symbol, session_date, change_rate, price, best_ask, best_bid, ask_qty1, bid_qty1, ask_qty_top3, bid_qty_top3, total_ask_qty, total_bid_qty)
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING`,
      [book.symbol, day, rate.get(book.symbol) ?? null, book.priceValue, book.bestAsk, book.bestBid,
        book.askQty1, book.bidQty1, book.askQtyTop3, book.bidQtyTop3, book.totalAskQty, book.totalBidQty]);
  }
}
