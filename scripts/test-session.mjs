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
// After the close it stays on KRX rather than following NXT into the
// after-market, because leadership is judged on the regular session.
check("16:00 stays on KRX", krTradingVenue(seoul(day, 16, 0)), "J");
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
check("08:30:00 keeps the 5 minute pre-market tick", delayMsFrom(8 * 60 + 30, 0), 5 * 60_000);
check("09:00:00 is a plain one minute tick", delayMsFrom(9 * 60, 0), 60_000);
check("09:29:10 stops short at 09:30", delayMsFrom(9 * 60 + 29, 10), 50_000);
check("09:45:00 keeps the 2 minute tick", delayMsFrom(9 * 60 + 45, 0), 2 * 60_000);
check("11:00:00 has no boundary left to guard", delayMsFrom(11 * 60, 0), 5 * 60_000);
// A tick landing a second before a boundary must not spin.
check("09:29:59 never schedules below a second", delayMsFrom(9 * 60 + 29, 59), 1_000);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
