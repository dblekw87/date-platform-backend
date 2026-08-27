import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 프리마켓에서 크게 오른 종목이 정규장에서 더 가는가.
 *
 *   node scripts/measure-premarket-followthrough.mjs
 *
 * 사용자 관찰: "프리장에서 150% 넘게 오른 것들이 정규장에 더 오르는 경우가 있더라."
 * 실제로 그런지, 그리고 얼마나 자주인지 재봅니다.
 *
 * 재는 방식:
 *   프리마켓 상승률 = 프리마켓 마지막 가격 / 전일 종가 - 1
 *   정규장 추가분   = 정규장 고가 / 프리마켓 마지막 가격 - 1
 *
 * **프리마켓 마지막 가격을 기준으로 삼는 것이 핵심입니다.** 전일 종가에서 재면
 * 프리마켓에서 이미 난 상승이 정규장 성과로 잡히고, 그러면 "많이 오른 게 많이
 * 올랐다"를 발견하고 끝납니다. 살 수 있는 시점은 개장이므로 그 가격이 기준입니다.
 *
 * 고가와 종가를 같이 냅니다. 고가만 보면 하루에 두 배 갔다 반납한 것도 성공으로
 * 세고, 종가만 보면 장중에 팔고 나온 경우를 못 봅니다. 둘의 차이가 곧 되돌림입니다.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH pre AS (
    SELECT symbol, session_date,
           (array_agg(close ORDER BY observed_at DESC))[1] AS pre_last,
           max(high) AS pre_high,
           sum(volume) AS pre_volume
      FROM us_intraday_bars WHERE phase='pre'
     GROUP BY symbol, session_date
  ),
  reg AS (
    SELECT symbol, session_date,
           (array_agg(open ORDER BY observed_at ASC))[1] AS reg_open,
           max(high) AS reg_high,
           (array_agg(close ORDER BY observed_at DESC))[1] AS reg_close,
           sum(volume) AS reg_volume
      FROM us_intraday_bars WHERE phase='regular'
     GROUP BY symbol, session_date
  ),
  prev AS (
    SELECT symbol, session_date, close,
           lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_close
      FROM us_daily_bars
  )
  SELECT p.symbol, p.session_date::text AS d,
         (p.pre_last / v.prev_close - 1) * 100 AS pre_gain,
         (r.reg_open / p.pre_last - 1) * 100 AS open_gap,
         (r.reg_high / p.pre_last - 1) * 100 AS to_high,
         (r.reg_close / p.pre_last - 1) * 100 AS to_close,
         (r.reg_close / r.reg_high - 1) * 100 AS giveback,
         v.prev_close, p.pre_last, r.reg_open, r.reg_high, r.reg_close,
         r.reg_volume
    FROM pre p
    JOIN reg r ON r.symbol = p.symbol AND r.session_date = p.session_date
    JOIN prev v ON v.symbol = p.symbol AND v.session_date = p.session_date
   WHERE v.prev_close > 0 AND p.pre_last > 0 AND r.reg_high > 0
     -- 호가만 있고 거래는 없는 종목을 걸러냅니다.
     AND r.reg_volume >= 50000
`);

const num = (v) => Number(v);
const stat = (list, key) => {
  const xs = list.map((r) => num(r[key])).filter(Number.isFinite);

  if (xs.length === 0) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = [...xs].sort((a, b) => a - b);

  return { mean, median: sorted[Math.floor(sorted.length / 2)], n: xs.length };
};

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-날 · 2024-08 ~ 2026-08 · 정규장 거래량 5만주↑`);
console.log(`기준은 **프리마켓 마지막 가격**입니다 -- 개장에 살 수 있는 값이라서요.\n`);

const bands = [[0, 20], [20, 50], [50, 100], [100, 150], [150, 300], [300, 1e9]];

console.log("  프리마켓 상승   표본     개장갭    고가까지   종가까지   고가대비 반납   +30%↑ 비율");
for (const [lo, hi] of bands) {
  const g = rows.filter((r) => num(r.pre_gain) > lo && num(r.pre_gain) <= hi);

  if (g.length < 10) { console.log(`  ${(lo + "~" + (hi > 1e8 ? "" : hi) + "%").padEnd(14)} ${String(g.length).padStart(5)}건 — 표본 부족`); continue; }

  const gap = stat(g, "open_gap"), high = stat(g, "to_high"), close = stat(g, "to_close"), back = stat(g, "giveback");
  const hit30 = g.filter((r) => num(r.to_high) >= 30).length;

  console.log(`  ${(lo + "~" + (hi > 1e8 ? "" : hi) + "%").padEnd(14)} ${String(g.length).padStart(5)}  ${((gap.median >= 0 ? "+" : "") + gap.median.toFixed(1)).padStart(7)}%  ${((high.median >= 0 ? "+" : "") + high.median.toFixed(1)).padStart(8)}%  ${((close.median >= 0 ? "+" : "") + close.median.toFixed(1)).padStart(8)}%  ${back.median.toFixed(1).padStart(9)}%  ${(hit30 / g.length * 100).toFixed(0).padStart(8)}%`);
}

console.log("\n  ※ 전부 중앙값입니다. 이 구간은 평균이 몇 건의 극단값에 끌려갑니다.");

const big = rows.filter((r) => num(r.pre_gain) >= 150);

if (big.length >= 10) {
  console.log(`\n프리마켓 150%↑ ${big.length}건을 자세히\n`);
  const hit = big.filter((r) => num(r.to_high) >= 30);

  console.log(`  개장가가 프리마켓보다 높았던 경우   ${big.filter((r) => num(r.open_gap) > 0).length}건 (${(big.filter((r) => num(r.open_gap) > 0).length / big.length * 100).toFixed(0)}%)`);
  console.log(`  정규장 고가가 +30% 이상            ${hit.length}건 (${(hit.length / big.length * 100).toFixed(0)}%)`);
  console.log(`  정규장 종가가 프리마켓보다 높음      ${big.filter((r) => num(r.to_close) > 0).length}건 (${(big.filter((r) => num(r.to_close) > 0).length / big.length * 100).toFixed(0)}%)`);
  console.log(`\n  최근 사례\n`);
  big.sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 10).forEach((r) =>
    console.log(`  ${r.d}  ${String(r.symbol).padEnd(6)} 전일 $${num(r.prev_close).toFixed(2)} → 프리 $${num(r.pre_last).toFixed(2)} (+${num(r.pre_gain).toFixed(0)}%) → 개장 $${num(r.reg_open).toFixed(2)} · 고가 $${num(r.reg_high).toFixed(2)} (${num(r.to_high) >= 0 ? "+" : ""}${num(r.to_high).toFixed(0)}%) · 종가 $${num(r.reg_close).toFixed(2)}`));
}

process.exit(0);
