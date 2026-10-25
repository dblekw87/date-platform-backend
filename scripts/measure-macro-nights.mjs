import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";
import { fetchText } from "../src/http.mjs";
import { macroEvents } from "../src/providers/macro-calendar.mjs";

/**
 * 금리 결정·물가 발표가 낀 밤에 국내장 아침이 달라지는가.
 *
 *   node scripts/measure-macro-nights.mjs
 *
 * 2026-10-25 사용자 질문(금리 인상 소식은 어떻게 하나)에서 나왔습니다. 일정 알림을
 * 붙이기 전에, 그 밤이 정말 다른 밤인지부터 잽니다 -- 근거 없이 "FOMC라 위험"이라고
 * 말하지 않으려고요.
 *
 * FOMC(한국 새벽 03~04시)와 CPI(21:30~22:30)는 국내장이 닫힌 밤에 나오므로 **다음 장
 * 시가 갭**으로 봅니다. 금통위는 장중(10:30경)이라 **그날 시가→종가**로 따로 봅니다.
 * 종가배팅 청산(09:05~09:10)은 금통위 발표 전이라, 금통위는 보유 위험이 아닙니다.
 *
 *   시장 갭   전 종목 단순 평균 (open > 0 필수 -- [[measurement-pitfalls]])
 *   지수 대용 최근 시총 상위 30종목 고정 가중 (measure-crash-day-rotation.mjs와 같은 정의)
 *   종가배팅  kr_signal_outcomes close_bet, 시장 갭 뺀 초과
 *
 * 국내 일봉은 2025-01-02부터라 표본이 작습니다(FOMC 14밤, CPI 20밤 남짓).
 */
const c = readConfig();

const { rows: days } = await query(c, `
WITH w AS (
  SELECT symbol, market_cap::float8 cap FROM (
    SELECT DISTINCT ON (symbol) symbol, market_cap FROM kr_daily_universe WHERE market_cap > 0 ORDER BY symbol, session_date DESC) t
  ORDER BY market_cap DESC LIMIT 30
), b AS (
  SELECT symbol, session_date, open, close, lag(close) OVER (PARTITION BY symbol ORDER BY session_date) prev
    FROM kr_daily_bars WHERE session_date >= '2025-01-01'
), r AS (
  SELECT *, (open / prev - 1) * 100 gap, (close / open - 1) * 100 intraday
    FROM b WHERE prev > 0 AND open > 0 AND close > 0 AND abs(open / prev - 1) < 0.31
)
SELECT r.session_date::text d,
       avg(r.gap) gap,
       sum(r.gap * w.cap) FILTER (WHERE w.cap IS NOT NULL) / nullif(sum(w.cap) FILTER (WHERE w.cap IS NOT NULL), 0) idx_gap,
       avg(r.intraday) intraday,
       sum(r.intraday * w.cap) FILTER (WHERE w.cap IS NOT NULL) / nullif(sum(w.cap) FILTER (WHERE w.cap IS NOT NULL), 0) idx_intraday
  FROM r LEFT JOIN w USING (symbol)
 GROUP BY 1 HAVING count(*) > 1000 ORDER BY 1`);

// 종가배팅: 신호 날의 종가 → 다음 장 시가, 그 밤의 시장 갭을 뺀 초과.
const { rows: bets } = await query(c, `
SELECT o.session_date::text d, (o.next_open / b.close - 1) * 100 - o.market_next_open excess
  FROM kr_signal_outcomes o
  JOIN kr_daily_bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
 WHERE o.kind = 'close_bet' AND o.next_open > 0 AND b.close > 0 AND o.market_next_open IS NOT NULL`);

const sessions = days.map((row) => row.d);
const openOf = (day) => new Date(`${day}T09:00:00+09:00`);
const nextSessionAfter = (instant) => sessions.find((day) => openOf(day) > instant);
const previousSession = (day) => sessions[sessions.indexOf(day) - 1];

// 밤 → 그 밤에 낀 이벤트. 밤은 "다음 장" 날짜로 부릅니다.
const nightEvents = new Map();
const bokDays = new Set();
const fomcByNight = new Map();

for (const event of macroEvents()) {
  if (event.kind === "bok") {
    const day = event.id.slice(4);

    if (sessions.includes(day)) bokDays.add(day);
    continue;
  }

  const night = nextSessionAfter(event.at);

  if (!night || !previousSession(night)) continue;

  nightEvents.set(night, [...(nightEvents.get(night) ?? []), event.kind]);
  if (event.kind === "fomc") fomcByNight.set(night, event.id.slice(5));
}

/*
 * FOMC 방향은 연준 성명 원문에서 읽습니다("decided to raise/lower/maintain the
 * target range"). 페이지 주소는 결정일로 정해집니다.
 */
const direction = new Map();

for (const [night, day] of fomcByNight) {
  try {
    const html = await fetchText(`https://www.federalreserve.gov/newsevents/pressreleases/monetary${day.replaceAll("-", "")}a.htm`, { headers: { "User-Agent": "Mozilla/5.0" }, timeoutMs: 10000 });
    const verb = html.match(/decided to (raise|lower|maintain)/i)?.[1]?.toLowerCase();

    direction.set(night, { lower: "인하", maintain: "동결", raise: "인상" }[verb] ?? "?");
  } catch {
    direction.set(night, "?");
  }
}

const byDay = new Map(days.map((row) => [row.d, row]));
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value) => value === null ? null : Math.round(value * 100) / 100;

function nightLabel(day) {
  const kinds = nightEvents.get(day) ?? [];

  if (kinds.includes("fomc")) return "1 FOMC 밤";
  if (kinds.includes("cpi")) return "2 CPI 밤";

  return "3 둘 다 없는 밤";
}

const nights = sessions.slice(1).map((day) => ({ day, label: nightLabel(day), row: byDay.get(day) }));

function gapTable(groups) {
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([label, list]) => {
    const gaps = list.map((night) => Number(night.row.gap));
    const index = list.map((night) => Number(night.row.idx_gap)).filter(Number.isFinite);

    return {
      밤: label,
      "밤 수": list.length,
      "시장 갭 평균": round(mean(gaps)),
      "시장 갭 중앙": round(median(gaps)),
      "|시장 갭| 평균": round(mean(gaps.map(Math.abs))),
      "|갭|>1% 비율": `${Math.round(100 * gaps.filter((gap) => Math.abs(gap) > 1).length / gaps.length)}%`,
      "지수 대용 갭 평균": round(mean(index)),
      "|지수 대용 갭| 평균": round(mean(index.map(Math.abs))),
      "|지수 대용 갭| 중앙": round(median(index.map(Math.abs)))
    };
  });
}

const byLabel = Map.groupBy(nights, (night) => night.label);

console.log(`국내 ${sessions[0]} ~ ${sessions.at(-1)} · ${sessions.length}장`);
console.log("\n1) 밤에 낀 이벤트별 다음 장 시가 갭 (%)");
console.table(gapTable(byLabel));

console.log("\n2) FOMC 밤 — 결정 방향별 (방향은 연준 성명 원문)");
console.table(gapTable(Map.groupBy(nights.filter((night) => fomcByNight.has(night.day)), (night) => `FOMC ${direction.get(night.day)}`)));
console.table(nights.filter((night) => fomcByNight.has(night.day)).map((night) => ({
  결정: fomcByNight.get(night.day), 방향: direction.get(night.day), "다음 장": night.day,
  "시장 갭": round(Number(night.row.gap)), "지수 대용 갭": round(Number(night.row.idx_gap))
})));

console.log("\n3) 종가배팅 초과 (종가 → 다음 장 시가, 시장 갭 뺌, %p)");
const betNight = (day) => {
  const next = sessions[sessions.indexOf(day) + 1];

  return next ? nightLabel(next) : null;
};
console.table([...Map.groupBy(bets.filter((bet) => betNight(bet.d)), (bet) => betNight(bet.d))]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([label, list]) => {
    const excess = list.map((bet) => Number(bet.excess));

    return {
      밤: label,
      건수: list.length,
      "날 수": new Set(list.map((bet) => bet.d)).size,
      "초과 중앙": round(median(excess)),
      "초과 평균": round(mean(excess)),
      상회율: `${Math.round(100 * excess.filter((value) => value > 0).length / excess.length)}%`
    };
  }));

console.log("\n4) 금통위 날 장중 (시가 → 종가, %)");
console.table([...Map.groupBy(sessions.map((day) => ({ day, row: byDay.get(day) })), (entry) => bokDays.has(entry.day) ? "금통위 날" : "다른 날")]
  .map(([label, list]) => {
    const intraday = list.map((entry) => Number(entry.row.intraday));
    const index = list.map((entry) => Number(entry.row.idx_intraday)).filter(Number.isFinite);

    return {
      날: label,
      "날 수": list.length,
      "시장 평균": round(mean(intraday)),
      "|시장| 평균": round(mean(intraday.map(Math.abs))),
      "지수 대용 평균": round(mean(index)),
      "|지수 대용| 평균": round(mean(index.map(Math.abs)))
    };
  }));

process.exit(0);
