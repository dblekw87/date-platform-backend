import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 내일 투자주의(시장경보)가 붙을 것 같은 종목을 종가배팅 전에 알립니다.
 *
 * 2026-11-10 사용자: 덕성우를 11/09 종가에 샀는데 그날 밤 투자주의가 붙었습니다.
 * "그걸 알아야 참고하고 안 들어갈 수도 있잖아." 거래소는 지정을 장 마감 뒤에
 * 공표하니 종가배팅(15:20~15:30)보다 늘 늦습니다 -- 확정은 못 보고 가격으로 미리
 * 짐작만 할 수 있습니다.
 *
 * 문턱은 kr_symbol_flags(08/19~, 수집기가 본 종목만)로 쟀습니다. 전날 경보 없음 →
 * 다음날 경보(주의·경고·위험) 15,247쌍 중:
 *   2연상                          22/31 = 71%
 *   상한가 + 5일 +55~80%            23/29 = 79%
 *   상한가 아님 + 5일 +60~80%       18/25 = 72%
 *   그 외                           약 1%
 * 5일 +80% 위는 오히려 33%·7%로 떨어집니다 -- 권리락·병합으로 일봉이 끊긴 종목과
 * 이미 지정됐다 풀린 종목이 섞인 것으로 보이고 확인하지 않았습니다. 그래서 칸에서 뺍니다.
 * 지정의 절반은 가격 조건이 없는 유형(소수 계좌 집중 등)이라 여기서는 못 봅니다.
 *
 * 지정의 값(measure-caution-all.mjs, 같은 날·같은 등락 칸·같은 5일 칸 대조, 220건):
 * 다음날 시가 −1.41%p, 상한가 −3.31%p(28)·+15~29% −3.35%p(19). 종가에선 상한가가 오히려
 * +3.34%p로 회복해 "판단을 바꿀 값"은 시가에만 있습니다 -- 종가배팅은 09:05에 팝니다.
 * 그래서 "사지 마라"가 아니라 시가 갭 경고입니다. 15:10 한 통, 시장 전체 -- 종가배팅 알림은 중·대형 재료
 * 종목만 고르므로 사용자가 직접 고르는 소형·우선주가 거기엔 없습니다.
 */

const kind = "caution_watch";
const startMinute = 15 * 60 + 10;
/* 15:10 통을 놓친 재기동이 15:25까지 따라잡습니다. 종가배팅 알림과 같은 창입니다. */
const stopMinute = 15 * 60 + 25;
const limitUpRate = 29.5;

let running = false;

export function cautionWatchDue(minute) {
  return minute >= startMinute && minute < stopMinute;
}

/**
 * 한 종목의 경보 가능성. 없으면 null. rate와 prevRate는 %, fiveDay는 비율(0.59)입니다.
 * warn은 오늘의 시장경보 코드(00 없음 · 01 주의 · 02 경고 · 03 위험)입니다.
 * 여러 칸에 걸리면 가장 높은 칸 하나만 돌려줍니다.
 *
 * 이미 투자주의인 종목은 다음 단계(투자경고)를 봅니다. 같은 표에서 전날 01 → 다음날
 * 02·03: 5일 +60%↑ 22/32 = 69%, 2연상 9/12 = 75%, 그 외 2%. 위의 5일 +80% 칸이
 * 낮았던 것은 대부분 이미 지정된 종목이 빠져서였습니다(01에서 상한가·5일 +80%↑는
 * 10/11이 경고로 올라감). 이미 경고·위험이면 확률 없이 상태만 적습니다.
 */
export function cautionReason({ fiveDay, prevRate, rate, warn = "00" }) {
  const limitUp = rate >= limitUpRate;
  const twoLimitUps = limitUp && prevRate >= limitUpRate;
  const fivePct = `5일 +${Math.round(fiveDay * 100)}%`;
  const reasons = [];

  if (warn === "02" || warn === "03") {
    if (limitUp || fiveDay >= 0.6) reasons.push({ label: `이미 ${warn === "02" ? "투자경고" : "투자위험"} 중 · ${fivePct}`, odds: null, sample: null });
  } else if (warn === "01") {
    if (twoLimitUps) reasons.push({ label: "투자주의 중 · 2연상", next: "투자경고", odds: 75, sample: "9/12" });
    if (fiveDay >= 0.6) reasons.push({ label: `투자주의 중 · ${fivePct}`, next: "투자경고", odds: 69, sample: "22/32" });
  } else {
    if (twoLimitUps) reasons.push({ label: "2연상", next: "투자주의", odds: 71, sample: "22/31" });
    if (limitUp && fiveDay >= 0.55 && fiveDay < 0.8) reasons.push({ label: `상한가 · ${fivePct}`, next: "투자주의", odds: 79, sample: "23/29" });
    if (!limitUp && fiveDay >= 0.6 && fiveDay < 0.8) reasons.push({ label: fivePct, next: "투자주의", odds: 72, sample: "18/25" });
  }

  return reasons.sort((a, b) => (b.odds ?? 0) - (a.odds ?? 0))[0] ?? null;
}

/*
 * 오늘 지금까지 본 종목의 마지막 등락률과 직전 다섯 거래일 종가. 오늘 값은 일봉이
 * 아니라 장중 표본에서 읽습니다 -- 15:10에는 오늘 일봉이 아직 확정되지 않았습니다.
 * NXT·애프터 표본은 뺍니다. 정규장 KRX 값이 상한가 판정의 기준입니다.
 */
export async function loadCautionCandidates(config, day) {
  const { rows } = await query(config, `
    WITH live AS (
      SELECT DISTINCT ON (symbol) symbol, name, change_rate::float8 AS rate
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $1::date
         AND source LIKE 'kis%:krx%' AND source NOT LIKE '%after%'
       ORDER BY symbol, observed_at DESC
    ),
    bars AS (
      SELECT symbol, close::float8 AS c,
             row_number() OVER (PARTITION BY symbol ORDER BY session_date DESC) AS k
        FROM kr_daily_bars
       WHERE session_date < $1::date AND session_date >= $1::date - 21
         AND symbol IN (SELECT symbol FROM live)
    ),
    closes AS (
      SELECT symbol,
             max(c) FILTER (WHERE k = 1) AS c1,
             max(c) FILTER (WHERE k = 2) AS c2,
             max(c) FILTER (WHERE k = 5) AS c5
        FROM bars GROUP BY symbol
    )
    SELECT l.symbol, l.name, l.rate, c.c1, c.c2, c.c5, f.market_warn
      FROM live l JOIN closes c USING (symbol)
      -- 오늘 행은 seen 표본마다 덮어써서 장중에도 오늘 지정 상태입니다(전날 저녁 공표분).
      LEFT JOIN kr_symbol_flags f ON f.symbol = l.symbol AND f.session_date = $1::date
     WHERE c.c1 > 0 AND c.c2 > 0 AND c.c5 > 0`, [day]);

  return rows
    .map((row) => {
      const price = Number(row.c1) * (1 + Number(row.rate) / 100);
      const fiveDay = price / Number(row.c5) - 1;
      const prevRate = (Number(row.c1) / Number(row.c2) - 1) * 100;
      const rate = Number(row.rate);

      return { fiveDay, name: row.name, prevRate, price, rate, reason: cautionReason({ fiveDay, prevRate, rate, warn: row.market_warn ?? "00" }), symbol: row.symbol };
    })
    .filter((row) => row.reason)
    .sort((a, b) => (b.reason.odds ?? 0) - (a.reason.odds ?? 0) || b.fiveDay - a.fiveDay);
}

export function cautionMessage(rows, day) {
  const lines = [`[내일 시장경보 가능성] ${day} 15:10 기준 · ${rows.length}종목`, ""];

  for (const row of rows.slice(0, 15)) {
    lines.push(`  ${row.name} ${row.symbol} ${row.rate > 0 ? "+" : ""}${row.rate.toFixed(1)}% · ${row.reason.label}${row.reason.odds ? ` → 내일 ${row.reason.next} ${row.reason.odds}% (${row.reason.sample})` : ""}`);
  }

  if (rows.length > 15) lines.push(`  외 ${rows.length - 15}종목`);

  lines.push("");
  lines.push("지정은 장 마감 뒤 공표라 종가배팅 전엔 확정을 못 봅니다. 가격 조건으로 짐작한 것이고, 지정의 절반(계좌 집중 등)은 여기 안 잡힙니다. 실측(같은 날·같은 상승폭 대조): 지정되면 다음날 시가가 평균 −1.4%p, 상한가·+15% 이상 종목은 −3.3%p 더 낮게 시작 — 09:05 청산에 그대로 걸립니다.");

  return lines.join("\n");
}

export async function notifyCautionWatch(config, { minute } = {}) {
  if (running || !notifyConfigured(config) || !cautionWatchDue(minute)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    const sent = await loadAlertSent(config, kind, day);

    if (sent.has("slot:1510")) return 0;

    const rows = await loadCautionCandidates(config, day);

    // 없는 날은 보내지 않습니다. 칸도 잠그지 않아 창 안에서 생기면 그때 갑니다.
    if (!rows.length) return 0;

    const ok = await notify(config, { text: cautionMessage(rows, day) });

    if (!ok) return 0;

    await markAlertSent(config, kind, day, "slot:1510", { note: rows.map((row) => row.name).join(", ").slice(0, 200) });
    console.log(`알림: 시장경보 가능성 · ${rows.map((row) => row.name).join(", ")}`);

    return rows.length;
  } catch (error) {
    console.warn("caution watch alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
