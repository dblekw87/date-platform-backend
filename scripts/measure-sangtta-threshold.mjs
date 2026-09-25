import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 상따 감시 문턱을 규모별로 다시 잽니다.
 *
 *   node scripts/measure-sangtta-threshold.mjs
 *
 * 2026-09-22에 한 번 손으로 쟀고(sangtta-watch.mjs 주석에 결과가 있습니다) 그
 * 계산을 어디에도 남기지 않아 다시 물었을 때 처음부터 다시 짰습니다. 문턱은 표본이
 * 쌓이면 또 볼 것이므로 이번에는 스크립트로 둡니다.
 *
 * 세 가지를 문턱마다 같이 봅니다. 하나만 보면 반드시 틀립니다:
 *
 *   잠김률   그 문턱에서 알림이 뜬 종목-일 중 정규장 종가에 상한가로 닫힌 비율.
 *            문턱을 올리면 항상 오릅니다 -- 이미 많이 오른 것만 남기니까요.
 *   하루 건수 올릴수록 줄어듭니다. 줄어드는 게 목적일 수도 있습니다.
 *   사각지대 종가에 잠겼는데 [문턱, 29.5) 구간 표본이 **한 번도 없던** 종목-일.
 *            문턱을 올리면 이것도 같이 오릅니다. 25.5%에서 29.9%로 한 틱에 뛰는
 *            종목은 27% 문턱으로는 영원히 안 보입니다(2026-09-21 스카이랩스).
 *
 * 정규장(09:00~15:30)만 씁니다. 애프터마켓 표본을 넣으면 종가 판정이 틀립니다 --
 * KRX 애프터마켓이 열린 2026-09-14 이후로는 저녁 값이 섞입니다.
 */
const bands = [
  { label: "소형", max: 3000e8, min: 0 },
  { label: "중형", max: 1e12, min: 3000e8 },
  { label: "대형", max: Infinity, min: 1e12 }
];
const candidates = [24, 25, 26, 27, 28];
const lockedRate = 29.5;
const watchFloor = 20;

const filters = candidates
  .map((rate) => `bool_or(change_rate >= ${rate} AND change_rate < ${lockedRate}) AS t${rate}`)
  .join(",\n         ");

const config = readConfig();
const { rows } = await query(config, `
  SELECT session_date,
         symbol,
         max(market_cap)::float8 AS cap,
         max(change_rate)::float8 AS peak,
         (array_agg(change_rate ORDER BY observed_at DESC))[1]::float8 AS last_rate,
         ${filters}
    FROM market_price_samples
   WHERE market = 'KR'
     AND change_rate IS NOT NULL
     AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN time '09:00' AND time '15:30'
   GROUP BY session_date, symbol
  HAVING max(change_rate) >= ${watchFloor}
`);

const days = new Set(rows.map((row) => row.session_date.toISOString().slice(0, 10))).size;
const bandOf = (cap) => bands.find((band) => (cap ?? 0) >= band.min && (cap ?? 0) < band.max);
const pct = (part, whole) => whole === 0 ? "   -" : `${(100 * part / whole).toFixed(0).padStart(3)}%`;

console.log(`거래일 ${days}일 · 장중 ${watchFloor}% 위 종목-일 ${rows.length}건`);
console.log(`종가 상한가 = 정규장 마지막 표본 >= ${lockedRate}%\n`);

for (const band of bands) {
  const mine = rows.filter((row) => bandOf(row.cap) === band);
  const locked = mine.filter((row) => row.last_rate >= lockedRate);

  console.log(`${band.label}  (종목-일 ${mine.length}건 · 종가 잠김 ${locked.length}건)`);
  console.log("  문턱   하루건수   잠김률        사각지대");

  for (const rate of candidates) {
    const hit = mine.filter((row) => row[`t${rate}`]);
    const hitLocked = hit.filter((row) => row.last_rate >= lockedRate);
    const blind = locked.filter((row) => !row[`t${rate}`]);
    const perDay = (hit.length / days).toFixed(1).padStart(5);

    console.log(`  ${rate}%  ${perDay}건  ${pct(hitLocked.length, hit.length)} (${String(hitLocked.length).padStart(3)}/${String(hit.length).padEnd(3)})  ${pct(blind.length, locked.length)} (${blind.length}/${locked.length})`);
  }

  console.log("");
}

/* 규모를 모르는 것이 섞이면 위의 소형 줄이 오염됩니다. 몇 건인지 밝혀 둡니다. */
const noCap = rows.filter((row) => row.cap === null).length;

if (noCap > 0) console.log(`시총 없음 ${noCap}건 -- 위에서 소형으로 셌습니다`);
process.exit(0);
