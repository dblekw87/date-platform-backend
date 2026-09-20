import { collectCandidates, tradableUniverse } from "./overnight-collect.mjs";
import { classifyDisclosure } from "./overnight-classify.mjs";
import { isKrMarketOpen } from "./kis.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { rankPicks, tierOf } from "./overnight-rank.mjs";
import { sessionDate } from "./market-session.mjs";
import { tradingSessions, upcomingWindow } from "./overnight-window.mjs";

/**
 * 주말 브리핑 -- 금요일 15:40부터 월요일 아침까지 쌓인 것을 한 통으로.
 *
 * 사용자가 원래 요청한 것은 "일요일 10시"였는데 그 시각엔 이 기계가 꺼져 있습니다
 * ([[user-daily-routine]] -- 토요일 09시에 끄고 일요일 밤에 켭니다). 클라우드 루틴은
 * DART가 망 차단이라 공시를 직접 못 보고([[cloud-routines]]) 토요일 스냅샷에 기대야
 * 해서, **월요일 07:10 로컬**로 정했습니다(사용자 선택). 덕분에 월요일 아침
 * 07:00~07:10 공시까지 들어온 뒤에 나갑니다 -- 주말 창의 공시는 금요일 저녁치가
 * 전부이고 나머지는 월요일 아침에 들어오므로, 이 10분이 목록을 채웁니다.
 *
 * 07:00은 아침 피드백, 07:30은 미국 상폐위험이 이미 씁니다. 그 사이에 둡니다.
 *
 * **주말 창에만 보냅니다.** 같은 "새 재료"가 주말 창에서는 장중 초과 +1.01%p(58%)
 * 인데 평일 창에서는 +0.23%p(46%)로 대조군과 구별되지 않습니다(2026-09-20, 20세션).
 * 평일 아침에 같은 통을 보내면 값이 없는 목록으로 아침을 채우는 일이 됩니다.
 */

const alertMinute = 7 * 60 + 10;
const stopMinute = 7 * 60 + 25;
const minTurnover = 1_000_000_000;

/* 사슬별 미국 바스켓. 등락은 균등평균입니다. AI전력만 문턱이 측정돼 있고
 * (+3%, [[us-ai-infra-to-kr]]) 나머지는 재본 적이 없어 값만 적습니다. */
const chains = [
  { label: "메모리·낸드", symbols: ["MU", "SNDK", "STX", "WDC"] },
  { label: "반도체장비", symbols: ["LRCX", "AMAT", "KLAC", "ASML", "TER"] },
  { label: "광통신", symbols: ["AAOI", "COHR", "LITE", "CRDO", "FN"] },
  { label: "크립토", symbols: ["MSTR", "COIN", "MARA", "HOOD"] },
  { label: "AI전력", symbols: ["VST", "CEG", "TLN", "NRG", "GEV", "PWR", "ETN"], threshold: 3 },
  { label: "원전·SMR", symbols: ["SMR", "OKLO", "NNE", "LEU", "CCJ", "BWXT"] },
  { label: "우주", symbols: ["RKLB", "LUNR", "ASTS", "RDW", "PL"] },
  { label: "양자", symbols: ["IONQ", "RGTI", "QBTS"] },
  { label: "방산", symbols: ["LMT", "RTX", "NOC", "AVAV", "KTOS"] }
];

const macroLabels = ["반도체 ETF", "NASDAQ 100 선물", "BTC", "WTI 선물", "원/달러 환율"];

let running = false;

export async function notifyWeekendBrief(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  running = true;

  try {
    if ((await loadAlertSent(config, "weekend_brief", day)).has("done")) return 0;

    const sessions = await tradingSessions(config);
    const window = upcomingWindow(sessions);

    // 주말 창이 아니면 조용히 넘어갑니다. 하루 잠금은 남겨 다음 틱에 또 세지 않습니다.
    if (!window.weekend) {
      await markAlertSent(config, "weekend_brief", day, "done", { note: "평일 창" });

      return 0;
    }

    if (!await isKrMarketOpen(config)) {
      await markAlertSent(config, "weekend_brief", day, "done", { note: "휴장" });

      return 0;
    }

    const text = await buildWeekendBrief(config, { sessions, window });

    if (!await notify(config, { text, url })) return 0;

    await markAlertSent(config, "weekend_brief", day, "done");
    console.log(`알림: 주말 브리핑 · ${day}`);

    return 1;
  } catch (error) {
    console.warn("weekend brief failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 통 하나를 글로 만듭니다. 미리 보는 쪽(scripts/weekend-brief.mjs)이 같은 함수를
 * 부르므로, 화면에서 본 것과 텔레그램으로 간 것이 갈리지 않습니다.
 */
export async function buildWeekendBrief(config, { sessions, window } = {}) {
  const list = sessions ?? await tradingSessions(config);
  const win = window ?? upcomingWindow(list);
  const previous = win.previous;

  const [picks, filings, chainRows, macro] = await Promise.all([
    loadPicks(config, win),
    loadFilings(config, win, previous),
    loadChains(config),
    loadMacro(config)
  ]);

  const lines = [`[주말 브리핑] ${previous} 15:40 ~ 지금`, ""];

  lines.push(...pickLines(picks));
  lines.push(...filingLines(filings));
  lines.push(...chainLines(chainRows, macro));

  return lines.join("\n");
}

async function loadPicks(config, window) {
  const candidates = await collectCandidates(config, window);
  const universe = await tradableUniverse(config, window.previous, minTurnover);

  return rankPicks(candidates, universe);
}

/*
 * 공시는 후보 목록과 따로 셉니다.
 *
 * rankPicks는 거래대금 10억 모집단 안에서만 도는데, 2026-09-20 주말의 호재 공시
 * 10건 중 8건이 그 아래라 화면에서 통째로 빠졌습니다. 사용자가 "호재 공시는 다
 * 보여달라"고 해서 여기서는 모집단을 걸지 않고 전부 싣되, 10억 미만은 표시를
 * 답니다 -- 호재공시 측정값(+0.52%p·58%)은 10억 이상에서 잰 것이라 같은 근거가
 * 아닙니다.
 */
async function loadFilings(config, window, previous) {
  const { rows } = await query(config, `
    SELECT d.company_name, d.report_name, d.symbol, d.title,
           to_char(d.filed_at AT TIME ZONE 'Asia/Seoul', 'DD HH24:MI') AS at,
           u.change_rate::float8 AS rate, u.turnover::float8 AS turnover
      FROM market_disclosures d
      LEFT JOIN kr_daily_universe u ON u.symbol = d.symbol AND u.session_date = $3
     WHERE d.market = 'KR' AND d.symbol IS NOT NULL
       AND d.filed_at >= $1 AND d.filed_at < $2
     ORDER BY d.filed_at`,
    [window.from.toISOString(), window.to.toISOString(), previous]);

  const good = [];
  const bad = [];

  for (const row of rows) {
    const kind = classifyDisclosure(row.report_name, row.title);

    if (kind === "good") good.push(row);
    if (kind === "bad") bad.push(row);
  }

  return { bad, good };
}

async function loadChains(config) {
  const symbols = chains.flatMap((chain) => chain.symbols);
  const { rows } = await query(config, `
    WITH recent AS (
      SELECT symbol, session_date, close::float8 AS close,
             lag(close::float8) OVER (PARTITION BY symbol ORDER BY session_date) AS prev,
             row_number() OVER (PARTITION BY symbol ORDER BY session_date DESC) AS rn
        FROM us_daily_bars
       WHERE symbol = ANY($1) AND session_date >= current_date - 12)
    SELECT symbol, (close / prev - 1) * 100 AS change_rate
      FROM recent WHERE rn = 1 AND prev > 0`, [symbols]);

  const moves = new Map(rows.map((row) => [row.symbol, Number(row.change_rate)]));

  return chains.map((chain) => {
    const values = chain.symbols.map((symbol) => moves.get(symbol)).filter((value) => Number.isFinite(value));

    return {
      label: chain.label,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      threshold: chain.threshold ?? null
    };
  });
}

async function loadMacro(config) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (label) label, value::float8 AS value, change_rate::float8 AS change_rate
      FROM macro_samples
     WHERE label = ANY($1) AND observed_at > now() - interval '18 hours'
     ORDER BY label, observed_at DESC`, [macroLabels]);

  return rows;
}

const pct = (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
/* DART의 report_name은 사유를 괄호로 달면서 그 앞을 공백으로 채워 옵니다
 * ("주권매매거래정지해제              (액면병합…"). 그대로 자르면 공백만 남습니다. */
const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function pickLines(picks) {
  const lines = ["■ 주말 새 재료 (직전장 조용한 것만)"];

  if (!picks.length) {
    lines.push("  없습니다.", "");

    return lines;
  }

  for (const pick of picks.slice(0, 8)) {
    const listing = pick.listing;
    const head = tidy(pick.good[0]?.title?.split("·").pop() ?? pick.material[0]?.headline ?? "");

    lines.push(`  [${tierOf(pick)}] ${listing.name} ${pct(listing.change_rate)} · ${(listing.turnover / 1e8).toFixed(0)}억`);
    lines.push(`      ${head.slice(0, 44)}`);
  }

  if (picks.length > 8) lines.push(`  … 외 ${picks.length - 8}종목`);
  lines.push("");

  return lines;
}

function filingLines({ bad, good }) {
  const lines = ["■ 호재 공시"];

  if (!good.length) lines.push("  없습니다.");

  for (const row of good.slice(0, 10)) {
    const thin = row.turnover >= minTurnover ? "" : " (유동성 미달)";
    const rate = Number.isFinite(row.rate) ? ` ${pct(row.rate)}` : "";

    lines.push(`  ${row.at} ${row.company_name}${rate}${thin}`);
    lines.push(`      ${tidy(row.report_name).slice(0, 40)}`);
  }

  if (good.length > 10) lines.push(`  … 외 ${good.length - 10}건`);
  lines.push("");
  lines.push("■ 악재 공시");

  if (!bad.length) lines.push("  없습니다.");

  for (const row of bad.slice(0, 6)) lines.push(`  ${row.at} ${row.company_name} · ${tidy(row.report_name).slice(0, 38)}`);

  if (bad.length > 6) lines.push(`  … 외 ${bad.length - 6}건`);
  lines.push("");

  return lines;
}

function chainLines(chainRows, macro) {
  const lines = ["■ 미국 사슬 (금요일 마감)"];

  for (const chain of chainRows) {
    if (chain.mean === null) continue;

    /* AI전력만 문턱이 측정돼 있습니다. 넘으면 다음날 국내 전력기기 +0.49%p(65%),
     * 0~1% 구간은 오히려 중앙값 -0.31%(38%)라 넘었는지를 같이 적습니다. */
    const note = chain.threshold === null
      ? ""
      : chain.mean >= chain.threshold ? "  ← 문턱 넘음" : `  (문턱 +${chain.threshold}% 미달)`;

    lines.push(`  ${chain.label} ${pct(chain.mean)}${note}`);
  }

  if (macro.length) {
    lines.push("");
    lines.push("■ 매크로");

    for (const row of macro) lines.push(`  ${row.label} ${Number(row.value).toLocaleString("ko-KR")} ${pct(Number(row.change_rate))}`);
  }

  return lines;
}
