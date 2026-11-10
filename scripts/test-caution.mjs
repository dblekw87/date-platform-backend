import { cautionReason } from "../src/providers/caution-watch.mjs";

/**
 * The thresholds behind the 15:10 market-warning heads-up (caution-watch.mjs).
 * 덕성우 on 2026-11-09 is the case that started it: limit-up, 5 days +59%,
 * designated 투자주의 that evening.
 */

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;

  if (!ok) failures += 1;

  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);

  if (!ok) console.log(`          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("caution-watch");
check("덕성우 11/09: limit-up, 5d +59%", cautionReason({ fiveDay: 0.592, prevRate: 4.9, rate: 29.93 })?.odds, 79);
check("two limit-ups", cautionReason({ fiveDay: 0.7, prevRate: 29.9, rate: 29.9 })?.odds, 79);
check("two limit-ups, 5d outside band", cautionReason({ fiveDay: 0.9, prevRate: 29.9, rate: 29.9 })?.odds, 71);
check("no limit-up, 5d +65%", cautionReason({ fiveDay: 0.65, prevRate: 3, rate: 2 })?.next, "투자주의");
check("5d +85% without designation is left out", cautionReason({ fiveDay: 0.85, prevRate: 3, rate: 2 }), null);
check("quiet stock", cautionReason({ fiveDay: 0.1, prevRate: 1, rate: 5 }), null);
check("already 투자주의 → next is 투자경고", cautionReason({ fiveDay: 0.85, prevRate: 3, rate: 2, warn: "01" })?.next, "투자경고");
check("already 투자경고 carries no odds", cautionReason({ fiveDay: 1.6, prevRate: 29.9, rate: 29.9, warn: "02" })?.odds, null);
check("already 투자경고 but quiet is left out", cautionReason({ fiveDay: 0.2, prevRate: 1, rate: 1, warn: "02" }), null);

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
