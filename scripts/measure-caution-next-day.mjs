import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 시장경보가 붙으면 다음 날 더 빠지는가 -- 같은 가격 자리에서 지정된 것과 안 된 것.
 *
 *   node scripts/measure-caution-next-day.mjs
 *
 * 2026-11-10 사용자: 덕성우를 11/09 종가에 샀고 그날 밤 투자주의가 붙었고 다음 날
 * 손절 뒤 −10% 더 빠졌습니다. 지정 때문인지, 그날 반도체가 올라 돈이 우선주에서
 * 빠져서인지 물었습니다. 그래서 둘을 나눠 봅니다:
 *   1. 같은 자리(상한가 또는 5일 +55%↑)에서 다음 날 지정된 것 vs 안 된 것
 *   2. 다음 날 시장이 오른 날 / 보통 / 내린 날로 다시 가름
 * 시장은 그날 전 종목 동일가중(시가 0인 불량행 제외 -- measurement-pitfalls).
 * 지정 여부는 kr_symbol_flags(08/19~, 수집기가 본 종목만)라 표본이 작습니다.
 */
const config = readConfig();

const { rows } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date d, open::float8 o, close::float8 c,
           lag(close::float8) OVER w pc, lag(close::float8, 5) OVER w c5,
           lead(session_date) OVER w nd, lead(open::float8) OVER w no, lead(close::float8) OVER w nc
      FROM kr_daily_bars WHERE session_date >= '2026-08-01'
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  mkt AS (
    SELECT d, avg(o / pc - 1) gap, percentile_cont(0.5) WITHIN GROUP (ORDER BY c / pc - 1) ret
      FROM b WHERE o > 0 AND pc > 0 GROUP BY d
  )
  SELECT b.symbol, b.d::text, (b.c / b.pc - 1) r1, (b.c / b.c5 - 1) r5,
         (b.no / b.c - 1) * 100 gap, (b.nc / b.c - 1) * 100 nclose,
         (b.no / b.c - 1 - m.gap) * 100 ex_gap,
         m.ret * 100 mret,
         n.market_warn nw
    FROM b
    JOIN kr_symbol_flags p ON p.symbol = b.symbol AND p.session_date = b.d AND p.market_warn = '00'
    JOIN kr_symbol_flags n ON n.symbol = b.symbol AND n.session_date = b.nd
    JOIN mkt m ON m.d = b.nd
   WHERE b.pc > 0 AND b.c5 > 0 AND b.no > 0 AND b.nc > 0
     AND (b.c / b.pc - 1 >= 0.295 OR b.c / b.c5 - 1 >= 0.55)`);

const med = (list) => {
  const sorted = [...list].sort((a, b) => a - b);

  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const f = (value) => (Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}` : "-");

function line(label, set) {
  if (!set.length) return console.log(`${label} | 0`);
  const gaps = set.map((row) => Number(row.gap));
  const closes = set.map((row) => Number(row.nclose));

  console.log([
    label,
    set.length,
    f(med(gaps)),
    f(med(set.map((row) => Number(row.ex_gap)))),
    `${Math.round((100 * gaps.filter((g) => g <= -3).length) / set.length)}%`,
    f(med(closes)),
    `${Math.round((100 * closes.filter((c) => c <= -10).length) / set.length)}%`
  ].join(" | "));
}

const designated = (row) => ["01", "02", "03"].includes(row.nw);
const regimes = [
  ["다음날 시장 상승(중앙 ≥ +1%)", (row) => Number(row.mret) >= 1],
  ["다음날 시장 보통", (row) => Number(row.mret) > -1 && Number(row.mret) < 1],
  ["다음날 시장 하락(중앙 ≤ −1%)", (row) => Number(row.mret) <= -1]
];

for (const [title, scope] of [["상한가 또는 5일 +55%↑ 전체", () => true], ["그중 당일 상한가만", (row) => Number(row.r1) >= 0.295]]) {
  const set = rows.filter(scope);

  console.log(`\n== ${title}`);
  console.log("구분 | 건수 | 다음 시가 갭 중앙 | 시장 대비 초과 중앙 | 갭 −3%↓ | 다음 종가 중앙 | 종가 −10%↓");
  line("지정됨", set.filter(designated));
  line("지정 안 됨", set.filter((row) => !designated(row)));

  for (const [name, fn] of regimes) {
    line(`${name} · 지정됨`, set.filter((row) => fn(row) && designated(row)));
    line(`${name} · 지정 안 됨`, set.filter((row) => fn(row) && !designated(row)));
  }
}

process.exit(0);
