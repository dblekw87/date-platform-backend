import { readConfig } from "../src/config.mjs";
import { isKrMarketOpen } from "../src/providers/kis.mjs";
import { krCollectionWindows, krTradingVenue, seoulMinuteNow, sessionDate } from "../src/providers/market-session.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Is the collector actually collecting.
 *
 * The failure this exists for is a silent one: the loop runs, nothing throws,
 * and no rows arrive. A morning spent believing otherwise is a day of the
 * series gone, and the series is what every model in this project is waiting
 * on. So the check is a command rather than a query somebody has to remember.
 *
 * Run it around 09:30 on the first few sessions, and any morning the board
 * looks wrong.
 *
 *   npm run collector:check
 *   npm run collector:check -- --date=2026-08-18
 */

function readOption(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : undefined;
}

function line(label, value, note = "") {
  console.log(`  ${label.padEnd(22)} ${String(value).padEnd(28)} ${note}`);
}

const config = readConfig();
const day = readOption("date") ?? sessionDate("KR");
const now = new Date();

console.log(`\ncollector check · ${day}\n`);

const minute = seoulMinuteNow(now);
const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const openWindow = krCollectionWindows.find((window) => minute >= window.openMinute && minute < window.closeMinute);
const nextWindow = krCollectionWindows.find((window) => window.openMinute > minute);

console.log("장 상태");
line("오늘 개장", (await isKrMarketOpen(config, now)) ? "예" : "아니오 (휴장)");
line("현재 시각", clock(minute), "KST");

if (openWindow) {
  line("현재 구간", openWindow.label, `${clock(openWindow.openMinute)}–${clock(openWindow.closeMinute)}`);
} else if (nextWindow) {
  line("현재 구간", "수집 대기", `다음 ${nextWindow.label} ${clock(nextWindow.openMinute)} · ${nextWindow.openMinute - minute}분 뒤`);
} else {
  line("현재 구간", "종료", "오늘 국내 수집은 끝났습니다");
}

line("venue", krTradingVenue(), "NX = NXT, J = KRX");

if (!config.databaseUrl) {
  console.log("\nDATABASE_URL이 없어 적재 상태는 확인할 수 없습니다.");
  process.exit(1);
}

const prices = await query(
  config,
  `SELECT source, count(*)::int AS rows, min(observed_at)::time AS first, max(observed_at)::time AS last,
          count(DISTINCT symbol)::int AS symbols
     FROM market_price_samples
    WHERE session_date = $1
    GROUP BY source
    ORDER BY source`,
  [day]
);

console.log("\n국내 시세");

/**
 * A window is only worth complaining about once it should have produced
 * something.
 *
 * This printed "조용히 실패한 것입니다 — 며칠 날리기 전에 원인부터 잡으세요" at
 * any hour, so running it before the bell - which is exactly when someone checks
 * - raised an alarm every time. A check that cries wolf before the open teaches
 * you to skip reading it, and then it is ignored on the one morning it is right.
 */
const graceMinutes = 12;

for (const window of krCollectionWindows) {
  const rows = prices.rows.filter((row) => row.source.startsWith(window.source));
  const due = minute >= window.openMinute + graceMinutes;

  if (rows.length > 0) {
    rows.forEach((row) => line(row.source, `${row.rows}행 · ${row.symbols}종목`, `${row.first}–${row.last}`));
  } else if (!due) {
    line(window.source, "대기 중", `${clock(window.openMinute)} 시작`);
  } else if (minute >= window.closeMinute) {
    line(window.source, "없음", `${clock(window.openMinute)}–${clock(window.closeMinute)}이 통째로 비었습니다`);
  } else {
    line(window.source, "없음", `${clock(window.openMinute)}에 시작했어야 합니다 — 원인부터 잡으세요`);
  }
}

// Without these the record can only ever show lead-lag between leaders, which
// is the one thing 짝꿍 does not need.
if (minute >= krCollectionWindows[1].openMinute + graceMinutes
  && !prices.rows.some((row) => row.source.endsWith(":pair"))) {
  console.log("  :pair 없음 — 짝꿍 후보가 기록되지 않고 있습니다. 따라가는 쪽의 시계열이 비면 나중에 학습할 게 없습니다.");
}

// The US side is half the collection now and was invisible here: its rows carry
// an Eastern session date, so a query keyed on the Korean day never saw them.
const us = await query(
  config,
  `SELECT source, count(*)::int AS rows, count(DISTINCT symbol)::int AS symbols,
          round(extract(epoch FROM (now() - max(observed_at))) / 60)::int AS age
     FROM market_price_samples
    WHERE market = 'US' AND observed_at > now() - interval '24 hours'
    GROUP BY source
    ORDER BY source`
);

console.log("\n미국 시세 (최근 24시간)");

if (us.rows.length === 0) {
  console.log("  없음 — 미국은 18:00–09:00 KST에만 수집합니다.");
} else {
  us.rows.forEach((row) => line(row.source, `${row.rows}행 · ${row.symbols}종목`, `${row.age}분 전`));
}

const news = await query(
  config,
  `SELECT count(*)::int AS rows, max(observed_at) AS last,
          count(*) FILTER (WHERE observed_at > now() - interval '2 hours')::int AS recent
     FROM market_news_items`
);
const newsRow = news.rows[0];

console.log("\n뉴스 적재 (상시)");
line("전체", `${newsRow.rows}건`, `최근 2시간 ${newsRow.recent}건`);
line("마지막", newsRow.last ? new Date(newsRow.last).toISOString() : "없음");

if (newsRow.recent === 0) console.log("  최근 2시간 적재가 없습니다 — 백엔드가 떠 있는지 확인하세요.");

console.log("");
process.exit(0);
