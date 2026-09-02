/*
 * 짝꿍매매에 "나머지 테마도 올랐는가"를 걸면 성적이 좋아지는가.
 *
 * 2026-09-01에 조건을 넣었는데 성적표는 조건 없이 잰 값 그대로였습니다. 걸러진
 * 목록에 안 거른 숫자를 붙이고 있는 상태라, 조건이 값어치가 있는지부터 재야
 * 합니다. 표본이 줄어드는 것은 확실하고, 줄어든 표본에서 초과가 커지는지가 답입니다.
 *
 * 테마 나머지는 일봉으로 냅니다 -- kr_daily_universe가 최근 며칠치뿐이라 과거를
 * 못 덮습니다. 그날 그 테마 회원(짝 두 종목 제외) 등락 평균에서 그날 시장 평균을
 * 뺀 값입니다. 화면의 마감 경로와 같은 정의입니다.
 *
 * 사용: node scripts/measure-pair-theme-filter.mjs
 */

import { limitPairSql, limitPairTiers } from "../src/providers/limit-pair.mjs";
import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

const nonBusiness = "(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)";

function summarise(list, pick) {
  if (list.length === 0) return null;

  const values = list.map(pick);
  const gaps = list.map((row) => Number(row.raw_gap));

  return {
    beat: values.filter((v) => v > 0).length / values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    gapUp: gaps.filter((v) => v > 0).length / gaps.length,
    n: values.length,
    nights: new Set(list.map((row) => row.d)).size
  };
}

const config = readConfig();

console.log("측정 중 · 전 기간 짝꿍 + 테마 나머지…");

const { rows } = await query(config, `
  WITH pairs AS (${limitPairSql()}),
  moves AS (
    SELECT symbol, session_date,
           (close / nullif(lag(close) OVER w, 0) - 1) * 100 AS dm
      FROM kr_daily_bars
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  mkt AS (
    SELECT session_date, avg(dm) AS m FROM moves
     WHERE dm IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  ),
  members AS (
    SELECT DISTINCT symbol, theme_name FROM kr_theme_membership WHERE theme_name !~ $1
  ),
  -- 짝 두 종목을 뺀 나머지 테마 회원의 그날 초과등락.
  rest AS (
    SELECT p.session_date, p.second_symbol,
           avg(mv.dm) - max(k.m) AS rest_excess,
           count(*) AS rest_n
      FROM pairs p
      JOIN members me ON me.theme_name = p.theme_name
      JOIN moves mv ON mv.symbol = me.symbol AND mv.session_date = p.session_date
      JOIN mkt k ON k.session_date = p.session_date
     WHERE me.symbol <> p.leader_symbol AND me.symbol <> p.second_symbol
       AND mv.dm IS NOT NULL
     GROUP BY p.session_date, p.second_symbol
  ),
  bars AS (
    SELECT symbol, session_date, close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  outcomes AS (
    SELECT symbol, session_date,
           (next_open / close - 1) * 100 AS gap,
           (next_close / close - 1) * 100 AS hold
      FROM bars WHERE close > 0 AND next_open IS NOT NULL AND next_close IS NOT NULL
  ),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap, avg(hold) AS market_hold
      FROM outcomes GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT p.session_date::text AS d, p.lead_gap, p.leader_move,
         o.gap - n.market_gap AS excess,
         o.hold - n.market_hold AS hold_excess,
         o.gap AS raw_gap,
         r.rest_excess, r.rest_n
    FROM pairs p
    JOIN outcomes o ON o.symbol = p.second_symbol AND o.session_date = p.session_date
    JOIN nights n ON n.session_date = p.session_date
    LEFT JOIN rest r ON r.session_date = p.session_date AND r.second_symbol = p.second_symbol
`, [nonBusiness]);

console.log(`짝 ${rows.length}건 · 나머지 계산됨 ${rows.filter((r) => r.rest_excess !== null).length}건\n`);

const line = (label, s) => s === null
  ? `  ${label.padEnd(16)} 표본 없음`
  : `  ${label.padEnd(16)} ${String(s.n).padStart(5)}건 · ${String(s.nights).padStart(3)}밤 · 상회 ${(s.beat * 100).toFixed(0).padStart(3)}% · 초과 ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(3)}%p`;

for (const { locked, maxLeadGap, tier } of limitPairTiers) {
  const lower = limitPairTiers
    .filter((e) => e.locked && e.maxLeadGap !== null && (maxLeadGap === null || e.maxLeadGap < maxLeadGap))
    .reduce((widest, e) => Math.max(widest, e.maxLeadGap), 0);
  const list = rows.filter((row) => {
    const isLocked = Number(row.leader_move) >= 29;

    if (isLocked !== locked) return false;
    if (!locked) return true;

    const gap = Number(row.lead_gap);

    return gap > lower && (maxLeadGap === null || gap <= maxLeadGap);
  });

  if (list.length === 0) continue;

  const known = list.filter((row) => row.rest_excess !== null);
  const pass = known.filter((row) => Number(row.rest_excess) > 0);
  const fail = known.filter((row) => Number(row.rest_excess) <= 0);

  console.log(`[${tier}]`);
  console.log(line("전체(현행 성적표)", summarise(list, (r) => Number(r.excess))));
  console.log(line("나머지 > 0", summarise(pass, (r) => Number(r.excess))));
  console.log(line("나머지 <= 0", summarise(fail, (r) => Number(r.excess))));
  console.log("");
}

// 나머지 회원 수가 얼마나 얇은지도 같이 봅니다 -- 둘짜리 평균으로 거르면 노이즈로
// 거르는 셈입니다.
const withRest = rows.filter((r) => r.rest_excess !== null);
const thin = withRest.filter((r) => Number(r.rest_n) < 5).length;

console.log(`나머지 회원 5명 미만인 짝: ${thin}/${withRest.length} (${(100 * thin / withRest.length).toFixed(1)}%)`);
process.exit(0);
