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
 *
 * **근거(공시·지목 기사·지분)가 있을 때만 보냅니다** (2026-09-21, 사용자 결정: "뉴스나
 * 공시가 같이 왔으면, 없으면 안 보내도 된다"). 문턱에 닿았는데 근거가 없으면 기록만 하고
 * 기다렸다가, 잠기기 전에 근거가 붙는 순간 그 종목의 첫 통을 보냅니다. 감시 목록에
 * 호가창을 띄울 이유가 같이 오지 않으면 노이즈였습니다. 채점(kr_signal_outcomes)은
 * 예전대로 문턱 도달 시점에 남깁니다 -- 안 보낸 종목도 잠김률에는 들어가야 문턱 실측이
 * 이어집니다.
 *
 * **2026-09-22 재측정 (25거래일, 장중 20% 위 종목-일 666건).** 문턱을 규모별로 다시
 * 갈라 봤습니다. 사각지대 = 종가에 잠겼는데 [문턱, 29.5) 구간 표본이 한 번도 없던 것:
 *
 *   소형 24%  하루 14.8건  잠김 30%  사각지대 15%
 *   중형 27%  하루  0.6건  잠김 50%  사각지대 53%  ← 절반 넘게 놓치고 있었습니다
 *   중형 25%  하루  1.3건  잠김 44%  사각지대 18%
 *
 * 그래서 **중형만 27 → 25로 내렸습니다.** 2026-09-21 스카이랩스가 10:50에 25.5%,
 * 10:51에 29.9%로 잠겨 27% 구간을 통째로 건너뛴 것이 이 경우입니다. 소형은 그대로
 * 둡니다 -- 24→25로 올리면 확률은 30→34%로 오르지만 그만큼 비싸게 사는 자리이고,
 * 실측 진입가(24.5%)가 [[sangtta-verdict]]의 +0.71%p를 낸 자리입니다. 대형은 잠김
 * 표본이 넷뿐이고 어느 문턱에서도 사각지대가 0이라 건드릴 근거가 없습니다.
 *
 * 이것은 **매수 신호가 아니라 감시 목록**입니다. 24% 시점 변수로 갈라 봐도 잠김 확률은
 * 40%대에서 멈췄고, 빠진 변수(호가 잔량)는 이제 찍기 시작했습니다. 알림은 진입 결정을
 * 대신하지 않고, 그 종목을 호가창에 띄울 이유와 재 본 확률을 줍니다.
 */

const thresholds = [
  { label: "소형", minCap: 0, rate: 24 },
  { label: "중형", minCap: 3000e8, rate: 25 },
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
      const weak = weakReason(path, size);

      await record(config, day, stock, size, path, weak);

      const evidence = await loadLimitUpEvidence(config, { name: stock.name, symbol: stock.symbol, theme: stock.theme }, day);

      if (!hasSpecificEvidence(evidence)) {
        // 기다림. 근거가 붙으면 followUpEvidence가 첫 통을 보냅니다.
        await markAlertSent(config, "sangtta_watch", day, stock.symbol, { note: `${size.label} ${stock.change_rate.toFixed(1)}% · 근거없음` });
        console.log(`상한가 직전 대기 · ${stock.name} +${stock.change_rate.toFixed(1)}% · 근거 없음`);
        continue;
      }

      evidence.context = await loadThemeContext(config, stock.symbol, day).catch(() => []);

      if (!await notify(config, { text: message(stock, size, path, evidence, weak), url })) continue;

      await markAlertSent(config, "sangtta_watch", day, stock.symbol, { note: `${size.label} ${stock.change_rate.toFixed(1)}%` });
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
 * 문턱에 닿았을 때 근거가 없어 기다리던 종목에, 잠기기 전에 근거가 붙으면 그때 첫 통.
 *
 * 예전엔 근거 없이 한 통 보내고 여기서 "근거 추가"를 한 통 더 보냈는데, 2026-09-21부터
 * 첫 통을 여기로 미뤘습니다. 24%에서 근거 없던 소형주가 27%에서 공시가 뜨면 그게 사용자가
 * 보는 첫 문장이므로 본문은 처음 보내는 것과 같은 모양이고, 문턱 도달 시각은 경로 줄에
 * 그대로 남습니다(path.at). note에 '근거없음'이 남아 있을 때만 보고, 보내면 note를 갈아
 * 두 번은 안 갑니다. 2026-09-22 전에는 약한 조건에 걸린 종목이 'skip:'으로 기록돼 여기서도
 * 건너뛰었는데, 이제 그런 행을 쓰지 않습니다 -- 약한 조건은 막는 것이 아니라 적는 것입니다.
 */
async function followUpEvidence(config, day, stock, size, sentRecord, url) {
  const note = String(sentRecord?.note ?? "");

  if (!note.includes("근거없음")) return 0;

  const evidence = await loadLimitUpEvidence(config, { name: stock.name, symbol: stock.symbol, theme: stock.theme }, day);

  if (!hasSpecificEvidence(evidence)) return 0;

  evidence.context = await loadThemeContext(config, stock.symbol, day).catch(() => []);

  const path = await loadPath(config, day, stock, size);

  if (!await notify(config, { text: message(stock, size, path, evidence, weakReason(path, size)), url })) return 0;

  await markAlertSent(config, "sangtta_watch", day, stock.symbol, { note: `${size.label} ${stock.change_rate.toFixed(1)}% · 근거 뒤늦게` });
  console.log(`알림: 상한가 직전 · ${stock.name} +${stock.change_rate.toFixed(1)}% · ${size.label} · 근거 뒤늦게`);

  return 1;
}

/** 종목별 마지막 정규장 표본. 지금 값을 봅니다 -- 아침에 24%였다가 10%인 종목은 후보가 아닙니다. */
async function loadLatest(config, day) {
  /*
   * 시총은 마지막 표본이 아니라 그날 표본 중 있는 것에서, 없으면 어제 유니버스에서.
   * 순위 표본(kis:krx)에는 시총이 비어 오는 종목이 있어(2026-09-15 경남제약: 순위 18행
   * 전부 null, :seen 4행만 524억) 마지막 표본만 보면 "소형 0억"으로 나가고 규모 판정도
   * 소형으로 떨어집니다. 규모가 문턱(24/27)을 정하므로 여기가 틀리면 알림 시각이 틀립니다.
   */
  const { rows } = await query(config, `
    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol, name, change_rate::float8, turnover::float8, theme, observed_at
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:krx%' AND source NOT LIKE '%:pair'
         AND change_rate IS NOT NULL AND observed_at >= now() - interval '6 minutes'
       ORDER BY symbol, observed_at DESC
    )
    SELECT l.*,
           coalesce(
             (SELECT max(p.market_cap)::float8 FROM market_price_samples p
               WHERE p.market = 'KR' AND p.session_date = $1::date AND p.symbol = l.symbol),
             (SELECT u.market_cap::float8 FROM kr_daily_universe u
               WHERE u.symbol = l.symbol AND u.session_date < $1::date ORDER BY u.session_date DESC LIMIT 1)
           ) AS market_cap
      FROM latest l`, [day]);

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
           -- 문턱에 처음 닿은 뒤의 고점. 되돌림을 재는 기준입니다.
           max(change_rate) FILTER (WHERE observed_at >= (SELECT min(observed_at) FROM market_price_samples i
                                                           WHERE i.market = 'KR' AND i.session_date = $1::date AND i.symbol = $2 AND i.change_rate >= $3))::float8 AS peak_after,
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

  const peak = row.peak_after;

  return {
    at,
    dip: peak === null || peak === undefined ? null : Math.max(0, peak - stock.change_rate),
    lowBefore: row.low_before,
    minute: seoulMinute,
    multiple: row.prev_turnover ? stock.turnover / row.prev_turnover : null,
    peak,
    prevTurnover: row.prev_turnover,
    riseMinutes: minutes
  };
}

/*
 * 되돌림 -- 지금까지 잰 것 중 **잠김을 실제로 가르는 유일한 진입 시점 변수**입니다.
 *
 * 2026-09-23 측정(8/19~, 문턱에 닿은 447 종목-일, 상장일·이상치 제외, 기본 잠김 34%).
 * 사후값이 아니라 그 순간의 판단 자리로 셌습니다 -- "지금 고점 대비 N%p 밀렸고 아직
 * 안 잠겼다"에서 그날 끝내 잠긴 비율입니다. 단조이고 폭이 큽니다(전체 31%→4%).
 * 진입 시점 변수로 재 본 다른 것들(시각·거래대금 배수·출발 위치)은 전부 40%대에서
 * 멈췄는데 이것만 갈립니다.
 *
 * **여기 적는 숫자는 근거가 있는 쪽입니다.** 같은 날 근거 종류를 448건에 다시 계산해
 * 교차해 보니 두 변수가 거의 독립이었습니다:
 *
 *            근거 있음   근거 없음
 *   0~2%p      39%        23%
 *   2~4%p      27%        17%
 *   4~6%p      19%        13%
 *   6~10%p     15%        11%
 *   10%p+      11%         8%
 *
 * 이 알림은 근거가 있을 때만 나가므로 통합 숫자를 적으면 실제보다 낮게 말하게 됩니다.
 * 그리고 **재료의 값은 밀리기 전에만 있습니다** -- 차이가 16%p에서 3%p로 좁혀집니다.
 * 깊이 밀린 자리에서는 재료가 있어도 안 지켜 준다는 뜻이고, 2026-09-22 동국생명과학이
 * 그 경우였습니다(재료 있음 · -10%p · 잠김 11% · 사용자 손절 · 45분 뒤 상한가).
 *
 * 계기는 2026-09-22 동국생명과학입니다. 14:03 +25.7% → 14:35 +16.7%(-10%p)에서
 * 사용자가 잘랐고 45분 뒤 상한가에 잠겼습니다. 이 표로 보면 그 자리의 잠김 확률은
 * 11%였으니 **자른 판단이 확률적으로는 옳았고 그날이 그 11%였던 것**입니다.
 * 알림에 이 숫자를 적어 두면 같은 자리에서 감이 아니라 확률로 정할 수 있습니다.
 */
const dipBands = [
  { lockRate: 39, upTo: 2 },
  { lockRate: 27, upTo: 4 },
  { lockRate: 19, upTo: 6 },
  { lockRate: 15, upTo: 10 },
  { lockRate: 11, upTo: Infinity }
];

function dipLockRate(dip) {
  return dipBands.find((band) => dip < band.upTo)?.lockRate ?? null;
}

/*
 * 약한 조건. **2026-09-22부터 알림을 막지 않고 문장에 적기만 합니다.**
 *
 * 원래는 여기 걸리면 안 보냈습니다. 근거는 소형 24% 340건에서 잰 "기본 34% → 이 조건들은
 * 16~22%"였는데, 알림이 실제로 돌기 시작한 뒤의 기록(9/15~9/22, 96건)으로 다시 재니
 * 갈라지지 않았습니다:
 *
 *   보냄/대기 73건 33%  ·  13:30 이후 16건 25%  ·  22→24 10분 초과 5건 40%  ·  하락 출발 2건 50%
 *
 * 표본이 작아 옛 측정을 뒤집지는 못하지만, 이 규칙이 이틀 연속으로 사용자가 실제로
 * 산 종목을 걸렀습니다 -- 2026-09-22 토마토시스템(09:23 26.5%에서 "22→24 10분 초과"로
 * 제외, 09:24 잠김, 종가까지 +30%). 걸러서 얻는 것이 확인되지 않는데 잃는 것은 확인됐으므로
 * 문을 열고, 대신 어느 조건에 걸렸는지를 문장과 기록에 남겨 표본이 쌓이면 다시 판단합니다.
 */
function weakReason(path, size) {
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

function message(stock, size, path, evidence, weak = null) {
  const eok = (value) => `${(Number(value ?? 0) / 1e8).toFixed(0)}억`;
  const base = size.label === "소형" ? "소형 24% 기본 잠김 34% · 24.5% 매수→익일 시가 +0.7%p"
    : size.label === "중형" ? "중형 25% 실측 잠김 44% (27%였을 때 50%, 대신 절반을 놓쳤습니다)"
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

  /*
   * 알림은 대개 문턱에 닿은 그 순간, 즉 되돌림이 0일 때 나갑니다. 그래서 지금 값
   * 하나만 적으면 늘 같은 숫자가 되어 쓸모가 없습니다. **기준표를 같이 붙여** 이 뒤에
   * 호가창을 보다가 밀릴 때 확률로 정할 수 있게 합니다 -- 손절을 감으로 정하던 자리입니다.
   */
  if (path.dip !== null && path.peak !== null) {
    lines.push(path.dip < 0.5
      ? `  되돌림: 없음 (고점 +${path.peak.toFixed(1)}%)`
      : `  되돌림: 고점 +${path.peak.toFixed(1)}% 대비 -${path.dip.toFixed(1)}%p · 이 깊이의 실측 잠김 ${dipLockRate(path.dip)}%`);
    lines.push("  밀릴 때 잠김 확률: -2%p 39% · -4 27% · -6 19% · -10 15% · 그 아래 11% (기본 34%)");
  }

  for (const flag of flags(stock, size, path)) lines.push(`  · ${flag}`);

  if (weak) lines.push(`  ⚠ ${weak} · 예전엔 이 조건이면 안 보냈습니다(재측정 중)`);

  for (const filing of evidence.filings.slice(0, 1)) {
    lines.push(`  공시 ${filing.at} ${(filing.report_name ?? filing.title ?? "").slice(0, 50)}`);
  }

  if (evidence.kind === "direct" || evidence.kind === "family") {
    for (const item of evidence.news.slice(0, 1)) {
      lines.push(`  ${evidence.kind === "family" ? "지분" : "뉴스"} ${item.at} ${item.headline.slice(0, 60)}`);
    }
  }

  lines.push(...contextLines(evidence.context ?? []));

  lines.push("");
  lines.push(`감시 목록입니다, 매수 신호가 아닙니다. ${base}`);
  lines.push("들어가면 익일 09:00~09:05 시가 매도 · 잠기지 못하고 25% 아래로 밀리면 이탈.");

  return lines.join("\n");
}

/*
 * tier에 규모와 약한 조건을 같이 적습니다. 2026-09-22 전 행은 `제외(...)`, 그 뒤는
 * `약함(...)`입니다 -- 같은 조건이지만 앞엣것은 안 보낸 것이고 뒤엣것은 보낸 것이라,
 * 나중에 둘을 한 통에 넣고 세면 안 됩니다.
 */
async function record(config, day, stock, size, path, weak) {
  await query(config, `
    INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
    VALUES ('sangtta_watch', $1::date, $2, now(), $3, $4, $5)
    ON CONFLICT (kind, session_date, symbol) DO NOTHING`,
    [day, stock.symbol, `${size.label}${weak ? ` · 약함(${weak})` : ""}`, stock.theme ?? null, stock.change_rate]);
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
