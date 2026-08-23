import { delayMsFrom } from "../src/collector.mjs";
import { isKrOpeningWindow } from "../src/pipeline/scheduler.mjs";
import { krTradingVenue, isRegularSession, sessionDate } from "../src/providers/market-session.mjs";

/**
 * The clock that decides which venue a sample is tagged with.
 *
 * One line of code, and the whole pre-market series depends on it: below 09:00
 * the collector asks NXT and writes kis:nxt, at 09:00 it switches to KRX and
 * writes kis:krx. Get it wrong and an hour of the morning is either missing or
 * silently filed as the wrong book — and the two books have separate turnover,
 * so a series that switched venue without saying so shows a break that was
 * never a trade.
 *
 * Nothing else exercises this. It reads the wall clock, so it behaves
 * differently depending on when the suite runs, which is exactly why the times
 * are injected here.
 */

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;

  if (!ok) failures += 1;

  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);

  if (!ok) console.log(`          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A moment in Seoul, written the way the trading day is read. */
function seoul(date, hour, minute) {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
}

// 2026-08-18 is a Tuesday and the first session the collector runs for real.
const day = "2026-08-18";

console.log("venue by the clock");
check("07:59 is still NXT's book", krTradingVenue(seoul(day, 7, 59)), "NX");
check("08:00 — the NXT pre-market opens", krTradingVenue(seoul(day, 8, 0)), "NX");
check("08:59 is the last NXT minute", krTradingVenue(seoul(day, 8, 59)), "NX");
// The boundary the whole pre-market series turns on.
check("09:00 — the KRX bell", krTradingVenue(seoul(day, 9, 0)), "J");
check("15:29 is still KRX", krTradingVenue(seoul(day, 15, 29)), "J");
// 15:40 hands the book back to NXT, which is the only one still trading:
// measured 2026-08-18, KRX repeated its close while NXT moved 109 billion won.
check("15:39 is still KRX", krTradingVenue(seoul(day, 15, 39)), "J");
check("15:40 hands over to NXT", krTradingVenue(seoul(day, 15, 40)), "NX");
check("19:00 is NXT", krTradingVenue(seoul(day, 19, 0)), "NX");
// The bell rings at 20:00 and the book stays readable for two minutes past it,
// so the closing print gets recorded. Without them the five-minute evening
// cadence put the last sample of the day at 19:56 and the close was never
// written down at all.
check("20:00 is still NXT, for the closing print", krTradingVenue(seoul(day, 20, 0)), "NX");
check("20:01 is the last minute of it", krTradingVenue(seoul(day, 20, 1)), "NX");
// Past the settle window both books are shut and the KRX close is canonical.
check("20:02 goes back to KRX", krTradingVenue(seoul(day, 20, 2)), "J");
check("23:30 stays on KRX", krTradingVenue(seoul(day, 23, 30)), "J");

console.log("\nregular session");
check("08:30 is before the bell", isRegularSession("KR", seoul(day, 8, 30)), false);
check("09:00 is in session", isRegularSession("KR", seoul(day, 9, 0)), true);
check("15:29 is in session", isRegularSession("KR", seoul(day, 15, 29)), true);
check("15:30 is the close", isRegularSession("KR", seoul(day, 15, 30)), false);
// The weekday test runs off the Seoul calendar, not the machine's.
check("Saturday is never in session", isRegularSession("KR", seoul("2026-08-22", 11, 0)), false);
check("Sunday is never in session", isRegularSession("KR", seoul("2026-08-23", 11, 0)), false);

console.log("\nsession date is the Seoul day");
check("08:30 KST belongs to that day", sessionDate("KR", seoul(day, 8, 30)), day);
// 23:30 in Seoul is still the same trading day, though it is the previous day
// in UTC — the label is what keeps samples from bleeding across sessions.
check("23:30 KST is still that day", sessionDate("KR", seoul(day, 23, 30)), day);
check("00:30 KST is the new day", sessionDate("KR", seoul(day, 0, 30)), day);

// The US pipeline yields this half hour to the collector. The tick that asks is
// phased to whenever the server started, which a scheduled task now decides, so
// the boundaries are the only thing keeping a twenty-minute batch out of the
// one window that cannot be re-collected.
console.log("\nUS pipeline yields the opening half hour");
check("08:59 is clear", isKrOpeningWindow(seoul(day, 8, 59)), false);
check("09:00 is the window", isKrOpeningWindow(seoul(day, 9, 0)), true);
check("09:29 is still the window", isKrOpeningWindow(seoul(day, 9, 29)), true);
check("09:30 is clear again", isKrOpeningWindow(seoul(day, 9, 30)), false);
check("14:00 is clear", isKrOpeningWindow(seoul(day, 14, 0)), false);
// Nothing is collected at the weekend, so there is nothing to yield to.
check("Saturday 09:10 is clear", isKrOpeningWindow(seoul("2026-08-22", 9, 10)), false);
check("Sunday 09:10 is clear", isKrOpeningWindow(seoul("2026-08-23", 9, 10)), false);

// The gap this closes was real: on 2026-08-18 the collector sampled at 08:59:42
// and then not again until 09:04:49, losing the first five minutes of the
// regular session - the exact window the per-minute cadence exists for.
console.log("\nsampling never sleeps past a cadence change");
check("08:59:42 wakes at 09:00, not 09:04", delayMsFrom(8 * 60 + 59, 42), 18_000);
// The pre-market ends at 08:50 and nothing trades until the bell, so a tick at
// 08:47 must stop at 08:50 rather than sleep into the dead ten minutes.
check("08:47 stops at 08:50", delayMsFrom(8 * 60 + 47, 0), 3 * 60_000);
// 애프터마켓 종가배팅이 나오는 자리. 여기가 5분으로 돌아가면 그 매매는 측정할 수
// 없습니다 -- 청산이 08:00~08:02인데 틱이 08:01 다음 08:06이 됩니다.
check("08:00:00 samples the exit window every minute", delayMsFrom(8 * 60, 0), 60_000);
check("08:14:00 is the last fine tick", delayMsFrom(8 * 60 + 14, 0), 60_000);
check("08:15:00 drops back to five minutes", delayMsFrom(8 * 60 + 15, 0), 5 * 60_000);
check("07:58:00 stops at 08:00 rather than sleeping through it", delayMsFrom(7 * 60 + 58, 0), 2 * 60_000);
check("08:30:00 keeps the 5 minute pre-market tick", delayMsFrom(8 * 60 + 30, 0), 5 * 60_000);
check("09:00:00 is a plain one minute tick", delayMsFrom(9 * 60, 0), 60_000);
check("09:29:10 stops short at 09:30", delayMsFrom(9 * 60 + 29, 10), 50_000);
check("09:45:00 keeps the 2 minute tick", delayMsFrom(9 * 60 + 45, 0), 2 * 60_000);
check("11:00:00 has no boundary left to guard", delayMsFrom(11 * 60, 0), 5 * 60_000);
// A tick landing a second before a boundary must not spin.
check("09:29:59 never schedules below a second", delayMsFrom(9 * 60 + 29, 59), 1_000);
// The handover to NXT is a cadence change like the bell, so a tick must not
// sleep past it either.
check("15:36 wakes at 15:40", delayMsFrom(15 * 60 + 36, 0), 4 * 60_000);
check("15:40 samples the evening every 5 minutes", delayMsFrom(15 * 60 + 40, 0), 5 * 60_000);
check("19:00 is still every 5 minutes", delayMsFrom(19 * 60, 0), 5 * 60_000);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
