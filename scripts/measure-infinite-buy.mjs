import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 라오어 무한매수법 실측 -- 2024-08 ~ 2026-08, 509 거래일.
 *
 *   node scripts/measure-infinite-buy.mjs
 *
 * 규칙은 공개된 것을 그대로 씁니다: 시드를 40분할, 매일 종가에 1/40씩 매수,
 * 평단의 +10%에 닿으면 전량 매도하고 처음부터 다시. 40회를 다 쓰고도 목표에
 * 못 닿으면 보유의 1/4을 팔아 시드를 되찾고 이어갑니다.
 *
 * **단순화한 것**: 원문은 매일 절반을 LOC 지정가로 나눠 넣어 평단 아래에서 더
 * 많이 사게 만듭니다. 여기서는 매일 같은 금액을 종가에 넣습니다. 일봉만으로는
 * LOC 체결을 재현할 수 없고, 흉내 내면 재현했다고 착각하게 됩니다. 그래서
 * 여기 숫자는 원문보다 평단이 조금 높게 나옵니다 -- 그만큼 할인해서 읽어야 합니다.
 *
 * 익절 판정은 그날 **고가**로 합니다. 지정가 매도라 장중에 닿으면 체결됩니다.
 *
 * 기준선이 핵심입니다. 같은 돈을 첫날 QQQ에 넣고 가만히 둔 것과 비교하지 않으면,
 * 상승장에서 무엇을 해도 나오는 수익을 전략의 공으로 착각합니다.
 */

const config = readConfig();
const splits = 40;
const target = 0.10;
const seed = 40_000;

async function bars(symbol) {
  const { rows } = await query(config, `
    SELECT session_date::text AS d, open, high, low, close
      FROM us_daily_bars WHERE symbol = $1 ORDER BY session_date`, [symbol]);

  return rows.map((r) => ({ d: r.d, high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
}

function run(series) {
  const daily = seed / splits;
  let cash = seed, shares = 0, spent = 0, used = 0;
  let cycles = 0, exhausted = 0, forcedSells = 0;
  let worst = 0, peakEquity = seed;
  const wins = [];

  for (const bar of series) {
    // 익절 먼저. 사기 전에 판정해야 그날 산 것이 그날 팔리는 일이 없습니다.
    if (shares > 0) {
      const avg = spent / shares;

      if (bar.high >= avg * (1 + target)) {
        const proceeds = shares * avg * (1 + target);

        cash += proceeds;
        wins.push(proceeds - spent);
        cycles += 1;
        shares = 0; spent = 0; used = 0;
      }
    }

    if (used < splits && cash >= daily) {
      const qty = daily / bar.close;

      shares += qty; spent += daily; cash -= daily; used += 1;
    } else if (used >= splits && shares > 0) {
      // 40회 소진. 보유의 1/4을 팔아 시드를 되찾고 이어갑니다.
      exhausted += 1;

      if (exhausted % splits === 1) {
        const sold = shares * 0.25;

        cash += sold * bar.close;
        spent -= (spent / shares) * sold;
        shares -= sold;
        used = Math.floor(splits * 0.75);
        forcedSells += 1;
      }
    }

    const equity = cash + shares * bar.close;

    peakEquity = Math.max(peakEquity, equity);
    worst = Math.min(worst, equity / peakEquity - 1);
  }

  const last = series[series.length - 1];

  return {
    cycles, forcedSells, wins,
    final: cash + shares * last.close,
    held: shares > 0 ? (shares * last.close) / (cash + shares * last.close) : 0,
    worst
  };
}

console.log(`\n시드 $${seed.toLocaleString("en-US")} · ${splits}분할 · 목표 +${target * 100}% · 2024-08-14 ~ 2026-08-25\n`);
console.log("  종목    최종자산     수익률   완주 사이클  강제매도  최대낙폭   미청산");

for (const symbol of ["TQQQ", "SOXL", "UPRO", "TNA", "QQQ"]) {
  const series = await bars(symbol);

  if (series.length < 100) { console.log(`  ${symbol.padEnd(6)} 데이터 부족`); continue; }

  const r = run(series);
  const ret = (r.final / seed - 1) * 100;

  console.log(`  ${symbol.padEnd(6)} $${Math.round(r.final).toLocaleString("en-US").padStart(8)}  ${(ret >= 0 ? "+" : "") + ret.toFixed(1).padStart(6)}%   ${String(r.cycles).padStart(6)}회   ${String(r.forcedSells).padStart(5)}회  ${(r.worst * 100).toFixed(1).padStart(7)}%  ${(r.held * 100).toFixed(0).padStart(4)}%`);
}

console.log("\n기준선 — 같은 돈을 첫날 넣고 가만히 둔 경우\n");
for (const symbol of ["QQQ", "TQQQ", "SOXX", "SOXL"]) {
  const series = await bars(symbol);
  const ret = (series[series.length - 1].close / series[0].close - 1) * 100;

  console.log(`  ${symbol.padEnd(6)} $${Math.round(seed * (1 + ret / 100)).toLocaleString("en-US").padStart(8)}  ${(ret >= 0 ? "+" : "") + ret.toFixed(1).padStart(6)}%`);
}

process.exit(0);
