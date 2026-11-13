import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadDelistRisk, riskLine } from "./us-delist-risk.mjs";
import { loadUsReasons, reasonKind, reasonLines } from "./us-reasons.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { fetchJson } from "../http.mjs";
import { usMarketPhase } from "./premarket.mjs";

/**
 * 미국 프리마켓(한국 18:00~23:30, 서머타임 17:00~22:30) 급등 + 이유.
 *
 * 2026-11-12 사용자가 토스증권 해외 프리마켓 급등 화면을 보여주며 "프리마켓용으로도
 * 따로" 요청. 우리 감시 목록(premarket.mjs)은 이미 알던 종목만 보므로 처음 뛰는 나노캡을
 * 못 봅니다 -- 그날 1·2위였던 PLCE(+439%)·POAS(+149%)가 그랬습니다.
 *
 * 시장 전체는 트레이딩뷰 공개 스캐너(scanner.tradingview.com, 키 없음·비공식)에서 받습니다.
 * 같은 시각 토스 화면과 순위가 맞았습니다(PLCE·POAS·PARA·ADXN·ICMB·CENN·DBGI).
 * 비공식이라 막히면 조용히 0통입니다.
 *
 * 문턱은 그날 밤 한 번을 보고 정한 출발점입니다: +30% · 프리 거래대금 $1M · ETF 제외.
 * 밤 하나에 7종목이 걸렸습니다. **사라는 신호가 아닙니다** -- 美 나노캡 첫날은 고점 대비
 * −23~−61%였고(us-nanocap-blindspot), 급등을 미리 맞힌 건 회전율뿐이었습니다.
 * 이 알림의 값은 "무엇이 왜 뛰었나"를 한국어로 읽는 것입니다.
 */

const kind = "us_premarket_surge";
const minChange = 30;
const minDollarVolume = 1_000_000;
const maxPerSession = 8;

let running = false;

export async function loadPremarketGainers() {
  const data = await fetchJson("https://scanner.tradingview.com/america/scan", {
    body: JSON.stringify({
      columns: ["name", "description", "premarket_change", "premarket_volume", "premarket_close", "close", "market_cap_basic", "type", "float_shares_outstanding"],
      filter: [{ left: "premarket_change", operation: "greater", right: minChange }],
      range: [0, 40],
      sort: { sortBy: "premarket_change", sortOrder: "desc" }
    }),
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    method: "POST",
    timeoutMs: 8000
  });

  return (data?.data ?? []).map((row) => {
    const [symbol, name, change, volume, price, previousClose, marketCap, type, float] = row.d;

    return { change, dollarVolume: (volume ?? 0) * (price ?? 0), float, marketCap, name, previousClose, price, symbol, type, volume };
  });
}

/*
 * 스캐너가 지난 세션의 프리마켓 값을 주는지 가립니다. 11/13 18:06(프리 개장 직후) 스캐너는
 * premarket_change·premarket_close를 전날 것 그대로, close만 전날 종가로 갱신해 돌려줬고,
 * 그 결과 어제 8종목(PLCE "+424% @1.04 prev 0.444")이 오늘 급등으로 나갔습니다 -- 1.04/0.444는
 * +134%이지 +424%가 아닙니다. 그 8통이 세션 한도를 채워 그날 진짜 급등(ZBAO·FCUV·MOD)은
 * 막혔습니다. 오늘 값이면 등락률이 가격/전일 종가와 맞습니다.
 */
function isCurrent(row) {
  if (!(row.price > 0) || !(row.previousClose > 0) || !Number.isFinite(row.change)) return false;

  return Math.abs((row.price / row.previousClose - 1) * 100 - row.change) <= Math.max(1, Math.abs(row.change) * 0.02);
}

function isFund(row) {
  return row.type === "fund" || /\b(ETF|ETN|Daily Target|2X|3X|Inverse)\b/i.test(row.name ?? "");
}

function money(value) {
  if (!Number.isFinite(value) || value <= 0) return "미상";

  return value >= 1e9 ? `$${(value / 1e9).toFixed(1)}B` : `$${(value / 1e6).toFixed(1)}M`;
}

/*
 * 유통주식 대비 회전. 11/12 POAS는 유통 77만 주에 프리마켓만 3,400만 주(44배) -- 뉴스 없이
 * +522%까지 간 이유가 이것이었습니다. 미국 급등에서 살아남은 신호도 회전율뿐이었습니다.
 */
function floatLine(row) {
  if (!Number.isFinite(row.float) || row.float <= 0 || !row.volume) return null;

  const turns = row.volume / row.float;
  const shares = row.float >= 1e6 ? `${(row.float / 1e6).toFixed(1)}M주` : `${Math.round(row.float / 1e3)}K주`;

  return `유통주식 ${shares} · 프리 거래량 ${turns >= 1 ? turns.toFixed(1) + "배 회전" : (turns * 100).toFixed(0) + "%"}${turns >= 5 ? " ⚡" : ""}`;
}

function message(row, reasons, risk) {
  return [
    `[미국 프리마켓 급등] ${row.symbol}`,
    row.name,
    `+${row.change.toFixed(1)}% · $${row.price < 1 ? row.price.toFixed(4) : row.price.toFixed(2)} (전일 $${row.previousClose < 1 ? row.previousClose.toFixed(4) : row.previousClose.toFixed(2)})`,
    `프리 거래대금 ${money(row.dollarVolume)} · 시총 ${money(row.marketCap)}`,
    floatLine(row),
    riskLine(risk) || null,
    `유형: ${reasonKind(reasons)}`,
    ...reasonLines(reasons)
  ].filter(Boolean).join("\n");
}

/** 절대 던지지 않습니다 -- 수집 틱을 멈추면 분봉을 잃습니다. */
export async function notifyUsPremarketSurges(config, { day, url } = {}) {
  if (running || !notifyConfigured(config) || usMarketPhase() !== "pre") return 0;

  running = true;

  try {
    const sent = new Set((await loadAlertSent(config, kind, day)).keys());
    const rows = (await loadPremarketGainers())
      .filter((row) => !isFund(row) && isCurrent(row) && row.dollarVolume >= minDollarVolume);
    const risks = await loadDelistRisk(config, rows.map((row) => row.symbol)).catch(() => new Map());
    let posted = 0;

    for (const row of rows) {
      if (sent.size >= maxPerSession) break;
      if (sent.has(row.symbol)) continue;

      const reasons = await loadUsReasons(config, { name: row.name, symbol: row.symbol }).catch(() => ({ filings: [], news: [] }));

      if (!await notify(config, { text: message(row, reasons, risks.get(row.symbol)), url })) continue;

      // note는 채점용입니다(scripts/measure-us-premarket.mjs가 읽음): 알림가·전일 종가·유형·회전.
      // "@가격 prev 가격" 꼴을 바꾸면 그 스크립트의 정규식도 고칠 것.
      const turns = Number.isFinite(row.float) && row.float > 0 ? ` · 회전 ${(row.volume / row.float).toFixed(1)}` : "";

      await markAlertSent(config, kind, day, row.symbol, { note: `+${row.change.toFixed(0)}% @${row.price} prev ${row.previousClose} · ${reasonKind(reasons)}${turns}` });
      sent.add(row.symbol);
      posted += 1;
      console.log(`알림: 미국 프리마켓 급등 · ${row.symbol} +${row.change.toFixed(0)}%`);
    }

    return posted;
  } catch (error) {
    console.warn("us premarket alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
