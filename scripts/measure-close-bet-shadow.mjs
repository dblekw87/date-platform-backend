import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { closeBetCandidateSql } from "../src/providers/close-bet.mjs";

/**
 * 윗꼬리 문턱을 어디에 둘 것인가 -- **운영 조건 위에서** 다시.
 *
 *   node scripts/measure-close-bet-shadow.mjs
 *
 * measure-close-bet-chart.mjs가 전체 후보에서 잰 결과는, 종가가 당일 레인지의
 * 85% 위에서 끝난 것만 값이 있고 60~85%는 중간과 다르지 않다는 것이었습니다.
 * 기울기가 아니라 절벽입니다.
 *
 * 그런데 그 측정의 모집단은 운영 조건이 아니었습니다. 화면에 쓰는 규칙은 이미
 * 윗꼬리 30% 미만(= 레인지 70% 위)을 걸고 있고, 양봉과 규모별 상승률 문턱도
 * 함께 겁니다. **조건을 바꾸려면 그 조건 위에서 재야 합니다** -- 다른 모집단에서
 * 얻은 경계를 그대로 옮기면, 이미 걸러진 것을 또 거르거나 엉뚱한 데를 자릅니다.
 *
 * 여기서는 closeBetCandidateSql에 **넓은 윗꼬리 문턱을 넘겨** 후보를 만듭니다.
 * 운영 상수를 그대로 쓰면 좁힌 뒤에는 바깥쪽이 후보에서 사라져, 좁힌 근거였던
 * 비교표를 다시 만들 수 없습니다 -- 근거를 확인할 수 없는 상수가 됩니다.
 * 나머지 조건(양봉·전고점 돌파·회전율·규모별 상승률)은 운영과 같습니다.
 *
 * 재는 값은 종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분입니다.
 */

const config = readConfig();

// 예전 문턱. 이보다 넓히면 비교 대상이 늘 뿐 결론은 같습니다.
const widestShadow = 0.3;

const { rows } = await query(config, `
  WITH candidates AS (${closeBetCandidateSql({ upperShadow: widestShadow })}),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap
      FROM (SELECT session_date,
                   (lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1) * 100 AS gap
              FROM kr_daily_bars WHERE close > 0) g
     WHERE gap IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT c.symbol, c.session_date::text AS d, c.day_move, c.upper_shadow, c.size_label,
         (c.next_open / c.close - 1) * 100 - n.market_gap AS excess
    FROM candidates c
    JOIN nights n ON n.session_date = c.session_date
   WHERE c.next_open IS NOT NULL
`);

const stat = (list) => {
  const xs = list.map((row) => Number(row.excess)).filter(Number.isFinite);

  if (xs.length === 0) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));

  return { beat: xs.filter((x) => x > 0).length / xs.length, mean, n: xs.length, t: mean / (sd / Math.sqrt(xs.length)) };
};

const report = (label, list, floor = 30) => {
  const s = stat(list);

  if (!s || s.n < floor) {
    console.log(`  ${label.padEnd(28)} ${String(list.length).padStart(5)}건 — 표본 부족`);

    return;
  }

  console.log(`  ${label.padEnd(28)} ${String(s.n).padStart(5)}건 · 초과 ${((s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)).padStart(7)}%p · 상회 ${String(Math.round(s.beat * 100)).padStart(2)}% · t ${s.t.toFixed(1)}`);
};

const shadow = (row) => Number(row.upper_shadow);
const days = new Set(rows.map((row) => row.d)).size;

console.log("");
console.log(`운영 조건 그대로의 후보 ${rows.length.toLocaleString("ko-KR")}건 · ${days}개 장`);
console.log("종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분");
console.log("");

report(`윗꼬리 ${widestShadow * 100}% 미만 (예전 문턱)`, rows);

console.log("");
console.log("윗꼬리 구간별 — 어디서 값이 생기는가");
console.log("");

const bands = [[0, 0.05], [0.05, 0.10], [0.10, 0.15], [0.15, 0.20], [0.20, 0.30]];

for (const [lo, hi] of bands) {
  report(`윗꼬리 ${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%`, rows.filter((row) => shadow(row) >= lo && shadow(row) < hi));
}

console.log("");
console.log("문턱을 옮기면 — 남는 것과 버리는 것");
console.log("");

for (const cut of [0.30, 0.20, 0.15, 0.10]) {
  const kept = rows.filter((row) => shadow(row) < cut);
  const dropped = rows.filter((row) => shadow(row) >= cut);
  const s = stat(kept);

  console.log(`  ${String(cut * 100).padStart(3)}% 미만  남는 것 ${String(kept.length).padStart(5)}건 (하루 ${(kept.length / days).toFixed(1)}건) · 초과 ${((s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)).padStart(7)}%p · 상회 ${Math.round(s.beat * 100)}%`);

  if (dropped.length >= 30) {
    const d = stat(dropped);

    console.log(`             버리는 것 ${String(dropped.length).padStart(5)}건 · 초과 ${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(3)).padStart(7)}%p · 상회 ${Math.round(d.beat * 100)}%`);
  }
}

/*
 * 규모별로도 봅니다.
 *
 * 문턱은 세 규모에 한꺼번에 걸리는데, 소형주는 원래 변동이 커서 윗꼬리가 길기
 * 쉽습니다. 한 규모에서만 좋아지고 다른 데서 나빠지면 전체 평균에 묻힙니다.
 */
console.log("");
console.log("규모별 — 문턱 30% vs 15%");
console.log("");

for (const size of [...new Set(rows.map((row) => row.size_label))].filter(Boolean)) {
  const inSize = rows.filter((row) => row.size_label === size);

  report(`${size} · 30% 미만`, inSize, 20);
  report(`${size} · 15% 미만`, inSize.filter((row) => shadow(row) < 0.15), 20);
}

/*
 * 통제. 윗꼬리가 짧은 날은 많이 오른 날이기도 합니다 -- 상한가는 윗꼬리가 0입니다.
 * 상승률을 고정하고도 남는지 봐야 조건 자체의 값입니다.
 */
console.log("");
console.log("[통제] 당일 상승률을 고정하고 — 윗꼬리 15% 미만 vs 15~30%");
console.log("");

for (const [lo, hi] of [[5, 10], [10, 15], [15, 22], [22, 100]]) {
  const band = rows.filter((row) => Number(row.day_move) >= lo && Number(row.day_move) < hi);

  console.log(`  당일 ${lo}~${hi === 100 ? "" : hi}% — ${band.length.toLocaleString("ko-KR")}건`);
  report("    윗꼬리 15% 미만", band.filter((row) => shadow(row) < 0.15), 20);
  report("    윗꼬리 15~30%", band.filter((row) => shadow(row) >= 0.15), 20);
  console.log("");
}

process.exit(0);
