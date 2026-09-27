import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 짝꿍을 올리는 것이 누구인가 — 외국인·기관·프로그램.
 *
 * 사용자 가설 (2026-09-27): "짝꿍 매매의 핵심은 외인 단타나 기관 단타 또는
 * 프로그램 매매가 올리는 경우들이 많긴 하던데."
 *
 * 두 가지를 따로 답합니다. 섞으면 안 됩니다.
 *
 *   1) 정말 많은가          주도주가 오른 날, 실제로 외국인·기관·프로그램이
 *                          순매수였던 비율. 가설의 앞부분은 빈도 주장입니다.
 *   2) 그것이 값을 갖는가    수급으로 갈랐을 때 짝꿍의 하룻밤 초과수익이
 *                          달라지는가. 빈도가 높아도 대조군과 같으면 못 씁니다.
 *
 * 짝 정의는 measure-pair-trade.mjs와 같습니다 -- 테마에서 거래대금 1위이고
 * +5% 이상 오른 종목을 주도주로, 같은 테마의 나머지 상승 종목을 짝꿍으로 봅니다.
 * 수익률은 그날 시장 평균을 뺀 초과분입니다.
 *
 * **표본이 좁습니다.** kr_program_trade가 2026-08-21부터, kr_investor_flow가
 * 07-07부터입니다. 앞선 짝꿍 측정은 18만쌍이었는데 여기는 그 일부만 남습니다.
 *
 * **결과 (2026-09-27, 22,899쌍 · 57세션).** 빈도는 맞고 값은 반증입니다.
 *
 *   빈도   주도주가 +5% 이상 오른 날 기관 순매수 78% · 프로그램 70% · 외국인 62%,
 *          개인 순매수는 21%뿐. 사용자 관찰대로 올리는 쪽은 개인이 아닙니다.
 *
 *   값     부호로 가르면 외국인 순매수 -0.46%p 대 순매도 +0.26%p로 갈리는 것처럼
 *          보이는데, **규모를 다시 잰 것입니다.** 외국인 순매수인 날 주도주 시총
 *          중앙값 6.3조 대 순매도인 날 1.2조 -- 다섯 배입니다. 짝꿍 규모 칸 안에서
 *          다시 가르면 부호가 칸마다 뒤집힙니다(소형 순매도가 0.33%p 낫고, 대형은
 *          순매수가 0.32%p 낫고, 중형은 차이 없음). 기관도 같습니다. 세기를 5분위로
 *          잘라도 단조가 아니고 인접 분위가 +0.59에서 -0.99로 튑니다.
 *
 * 그래서 **수급으로 짝을 고르지 않습니다.** 사후 조건으로 짝을 거르려는 시도가
 * 이것으로 세 번째 반증입니다(재료, 테마 나머지, 수급). 갈리는 것은 여전히 규모
 * 하나입니다 -- 소형 +0.11%p / 중형 -0.37 / 대형 -0.60.
 *
 * 다시 잴 때: 프로그램은 5주치(7,015쌍)뿐이라 장중 시점으로 자르면 표본이 더
 * 줄어듭니다. 일별 순매수는 **끝난 뒤의 값**이라 진입 시점에는 모르는 수이고,
 * 장중 값으로 다시 재려면 kr_program_trade의 시각별 누적을 써야 합니다.
 */
const config = readConfig();
const minLeaderMove = 5;
const minTurnover = 1_000_000_000;

const { rows } = await query(config, `
  WITH members AS (
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_membership
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)'
  ),
  bars AS (
    SELECT symbol, session_date, close, volume, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(close) OVER w AS next_close,
           lead(open) OVER w AS next_open
      FROM kr_daily_bars
     WHERE session_date >= '2026-07-01'
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  moves AS (
    SELECT symbol, session_date, turnover,
           (close / prev_close - 1) * 100 AS day_move,
           (next_close / close - 1) * 100 AS next_day,
           (next_open / close - 1) * 100 AS gap
      FROM bars
     WHERE prev_close > 0 AND close > 0 AND next_close IS NOT NULL
  ),
  nights AS (
    SELECT session_date, avg(next_day) AS market_next, avg(gap) AS market_gap
      FROM moves GROUP BY session_date HAVING count(*) >= 50
  ),
  themed AS (
    SELECT m.symbol, m.session_date, m.turnover, m.day_move, m.next_day, m.gap, t.theme_name,
           row_number() OVER (PARTITION BY t.theme_name, m.session_date
                              ORDER BY m.turnover DESC) AS turnover_rank,
           count(*) OVER (PARTITION BY t.theme_name, m.session_date) AS theme_size
      FROM moves m
      JOIN members t ON t.symbol = m.symbol
     WHERE m.day_move > 0 AND m.turnover >= ${minTurnover}
  ),
  leaders AS (
    SELECT theme_name, session_date, symbol AS leader_symbol, day_move AS leader_move,
           turnover AS leader_turnover, theme_size
      FROM themed WHERE turnover_rank = 1 AND day_move >= ${minLeaderMove} AND theme_size >= 2
  ),
  -- 프로그램 순매수는 장중 누적이라 그날 마지막 관측이 일간 합계입니다.
  program AS (
    SELECT DISTINCT ON (symbol, session_date) symbol, session_date, net_amount::float8 AS program_amount
      FROM kr_program_trade ORDER BY symbol, session_date, observed_time DESC
  )
  SELECT l.session_date::text AS d, l.theme_name, l.leader_symbol, l.leader_move::float8,
         l.leader_turnover::float8,
         f.symbol AS follower, f.day_move::float8 AS follower_move,
         (f.next_day - n.market_next)::float8 AS follower_excess,
         (f.gap - n.market_gap)::float8 AS follower_gap_excess,
         (l.leader_move - f.day_move)::float8 AS lead_gap,
         lf.foreign_amount::float8 AS leader_foreign,
         lf.institution_amount::float8 AS leader_institution,
         lf.individual_amount::float8 AS leader_individual,
         lp.program_amount AS leader_program,
         ff.foreign_amount::float8 AS follower_foreign,
         ff.institution_amount::float8 AS follower_institution,
         fp.program_amount AS follower_program,
         -- 규모 통제용. 외국인 순매수는 큰 종목에 쏠려서, 규모를 같이 봐야
         -- 수급을 잰 것인지 규모를 다시 잰 것인지 가릴 수 있습니다.
         lu.market_cap::float8 AS leader_cap,
         fu.market_cap::float8 AS follower_cap
    FROM leaders l
    JOIN themed f ON f.theme_name = l.theme_name AND f.session_date = l.session_date
                 AND f.symbol <> l.leader_symbol
    JOIN nights n ON n.session_date = l.session_date
    LEFT JOIN kr_investor_flow lf ON lf.symbol = l.leader_symbol AND lf.session_date = l.session_date
    LEFT JOIN kr_investor_flow ff ON ff.symbol = f.symbol AND ff.session_date = l.session_date
    LEFT JOIN program lp ON lp.symbol = l.leader_symbol AND lp.session_date = l.session_date
    LEFT JOIN program fp ON fp.symbol = f.symbol AND fp.session_date = l.session_date
    LEFT JOIN kr_daily_universe lu ON lu.symbol = l.leader_symbol AND lu.session_date = l.session_date
    LEFT JOIN kr_daily_universe fu ON fu.symbol = f.symbol AND fu.session_date = l.session_date
`);

const nights = new Set(rows.map((row) => row.d)).size;

console.log(`\n짝 ${rows.length}쌍 · ${nights}세션 · 주도주 +${minLeaderMove}% 이상, 거래대금 ${minTurnover / 1e8}억 이상\n`);

/* 1) 빈도. 가설의 앞부분입니다. 수급 표가 비어 있는 종목은 분모에서 뺍니다 --
   "자료가 없다"를 "순매도였다"로 세면 답이 틀립니다. */
const share = (label, list, test) => {
  const known = list.filter((row) => test(row) !== null);
  const yes = known.filter((row) => test(row) === true).length;

  console.log(`  ${label.padEnd(26)} ${String(known.length).padStart(6)}쌍 중 ${String(yes).padStart(6)}쌍 · ${known.length ? Math.round((100 * yes) / known.length) : 0}%`);
};
const sign = (value) => value === null || value === undefined ? null : Number(value) > 0;

console.log("1) 주도주가 오른 날, 누가 순매수였나");
share("외국인 순매수", rows, (row) => sign(row.leader_foreign));
share("기관 순매수", rows, (row) => sign(row.leader_institution));
share("프로그램 순매수", rows, (row) => sign(row.leader_program));
share("개인 순매수", rows, (row) => sign(row.leader_individual));
share("외국인+기관 둘 다 순매수", rows, (row) => row.leader_foreign === null || row.leader_institution === null
  ? null
  : Number(row.leader_foreign) > 0 && Number(row.leader_institution) > 0);

/* 2) 값. 짝꿍의 하룻밤 초과수익을 수급으로 갈라 봅니다. */
const report = (label, list, key = "follower_excess") => {
  if (list.length < 50) {
    console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}쌍 · 표본 부족`);

    return;
  }

  const xs = list.map((row) => Number(row[key]));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}쌍 · 상회 ${String(Math.round((100 * beat) / xs.length)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log("\n2) 짝꿍의 하룻밤 초과수익 (익일 종가 기준)");
report("전체(대조군)", rows);

const has = (row, field) => row[field] !== null && row[field] !== undefined;

console.log("\n  주도주 수급으로 갈랐을 때");
report("주도주 외국인 순매수", rows.filter((row) => has(row, "leader_foreign") && Number(row.leader_foreign) > 0));
report("주도주 외국인 순매도", rows.filter((row) => has(row, "leader_foreign") && Number(row.leader_foreign) <= 0));
report("주도주 기관 순매수", rows.filter((row) => has(row, "leader_institution") && Number(row.leader_institution) > 0));
report("주도주 기관 순매도", rows.filter((row) => has(row, "leader_institution") && Number(row.leader_institution) <= 0));
report("주도주 프로그램 순매수", rows.filter((row) => has(row, "leader_program") && Number(row.leader_program) > 0));
report("주도주 프로그램 순매도", rows.filter((row) => has(row, "leader_program") && Number(row.leader_program) <= 0));
report("주도주 개인만 (외인·기관 매도)", rows.filter((row) => has(row, "leader_foreign") && has(row, "leader_institution")
  && Number(row.leader_foreign) <= 0 && Number(row.leader_institution) <= 0));

console.log("\n  짝꿍 자신의 수급으로 갈랐을 때");
report("짝꿍 외국인 순매수", rows.filter((row) => has(row, "follower_foreign") && Number(row.follower_foreign) > 0));
report("짝꿍 외국인 순매도", rows.filter((row) => has(row, "follower_foreign") && Number(row.follower_foreign) <= 0));
report("짝꿍 기관 순매수", rows.filter((row) => has(row, "follower_institution") && Number(row.follower_institution) > 0));
report("짝꿍 기관 순매도", rows.filter((row) => has(row, "follower_institution") && Number(row.follower_institution) <= 0));
report("짝꿍 프로그램 순매수", rows.filter((row) => has(row, "follower_program") && Number(row.follower_program) > 0));
report("짝꿍 프로그램 순매도", rows.filter((row) => has(row, "follower_program") && Number(row.follower_program) <= 0));

/* ---- 여기부터 규모 통제. 1차에서 나온 갈림이 규모인지 수급인지 가립니다. ---- */

const capReport = (label, list) => {
  if (list.length < 50) {
    console.log(`    ${label.padEnd(24)} ${String(list.length).padStart(6)}쌍 · 표본 부족`);

    return;
  }

  const xs = list.map((row) => Number(row.follower_excess));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`    ${label.padEnd(24)} ${String(list.length).padStart(6)}쌍 · 상회 ${String(Math.round((100 * beat) / xs.length)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log(`\n짝 ${rows.length}쌍 (주도주 수급 자료 있는 것만)\n`);

/* 먼저 교란이 실제로 있는지 확인합니다 -- 외국인이 산 주도주가 정말 더 큰가. */
/* 2단계는 주도주 수급을 아는 행만 씁니다. 1단계는 분모를 넓게 둬야 빈도가
   맞으므로 거기서 걸러 버리면 안 됩니다. */
const known = rows.filter((row) => row.leader_foreign !== null && row.leader_foreign !== undefined);
const withCap = known.filter((row) => row.leader_cap);
const mean = (list, key) => list.reduce((sum, row) => sum + Number(row[key]), 0) / (list.length || 1);
const bought = withCap.filter((row) => Number(row.leader_foreign) > 0);
const sold = withCap.filter((row) => Number(row.leader_foreign) <= 0);

console.log("교란 확인 · 주도주 시총 중앙값 (억)");
const median = (list) => {
  const xs = list.map((row) => Number(row.leader_cap)).sort((a, b) => a - b);

  return xs.length ? Math.round(xs[Math.floor(xs.length / 2)] / 1e8) : 0;
};

console.log(`  외국인 순매수인 날  ${median(bought).toLocaleString("ko-KR")}억  (${bought.length}쌍)`);
console.log(`  외국인 순매도인 날  ${median(sold).toLocaleString("ko-KR")}억  (${sold.length}쌍)`);

/* 규모 칸 안에서 다시. 짝꿍 시총으로 나눕니다 -- 사는 것은 짝꿍이니까요. */
const caps = [
  { label: "소형 3천억 미만", max: 3000e8, min: 0 },
  { label: "중형 3천억~1조", max: 1e12, min: 3000e8 },
  { label: "대형 1조 이상", max: Infinity, min: 1e12 }
];

console.log("\n짝꿍 규모 칸 안에서 주도주 외국인 수급으로 갈랐을 때");

for (const cap of caps) {
  const inBand = known.filter((row) => row.follower_cap && Number(row.follower_cap) >= cap.min && Number(row.follower_cap) < cap.max);

  console.log(`\n  ${cap.label} (${inBand.length}쌍)`);
  capReport("전체", inBand);
  capReport("외국인 순매수", inBand.filter((row) => Number(row.leader_foreign) > 0));
  capReport("외국인 순매도", inBand.filter((row) => Number(row.leader_foreign) <= 0));
  capReport("기관 순매수", inBand.filter((row) => row.leader_institution !== null && Number(row.leader_institution) > 0));
  capReport("기관 순매도", inBand.filter((row) => row.leader_institution !== null && Number(row.leader_institution) <= 0));
}

/* 세기를 분위로 자릅니다. 단조가 아니면 부호 갈림은 우연일 가능성이 큽니다. */
console.log("\n주도주 외국인 순매수 세기 (거래대금 대비, 5분위)");

const ratios = known
  .filter((row) => row.leader_turnover)
  /* _amount는 원이 아니라 **백만원**입니다(019 마이그레이션 주석 참고 -- 거기가
     원이라고 적혀 있어서 처음엔 5분위 경계가 전부 0.000%로 뭉쳤습니다). */
  .map((row) => ({ ...row, ratio: (Number(row.leader_foreign) * 1e6) / Number(row.leader_turnover) }))
  .sort((a, b) => a.ratio - b.ratio);
const step = Math.floor(ratios.length / 5);

for (let index = 0; index < 5; index += 1) {
  const slice = ratios.slice(index * step, index === 4 ? ratios.length : (index + 1) * step);
  /* 비율이 아주 작아 소수 한 자리로는 전부 0.0으로 뭉칩니다. 경계가 안 보이면
     단조인지 아닌지를 읽는 사람이 확인할 수 없습니다. */
  const low = (slice[0].ratio * 100).toFixed(3);
  const high = (slice[slice.length - 1].ratio * 100).toFixed(3);

  capReport(`${index + 1}분위 ${low}~${high}%`, slice);
}


process.exit(0);
