import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 함께 움직인 테마 패널이 보여주는 멤버를 걸러야 하는가. -- 걸 필요 없었습니다.
 *
 *   node scripts/measure-theme-coherence.mjs
 *
 * 사용자가 짚은 화면: SI(시스템통합) 1등주 아이티센글로벌 +6.46%, 그 아래
 * LG씨엔에스 +0.97 · 다우기술 +0.79 · 포스코DX +0.49. "함께 오른 4종목"이라고
 * 적혀 있지만 셋은 사실상 안 움직였습니다. 넷 중 하나(비트플래닛 +30%)만 갔고
 * 그건 SI가 아니라 가상화폐 때문입니다.
 *
 * **구간을 틀리면 답이 뒤집힙니다.** 이 스크립트가 재는 익일 **종가** 기준으로는
 * 10% 아래 멤버의 초과수익이 0이거나 마이너스라, 문턱을 올려야 할 것처럼 보입니다.
 * 그런데 패널이 약속하는 건 익일 **시가 갭**이고, 갭으로 재면 0~1% 멤버도
 * +0.210%p(t 13.3)에 테마가 +0.121%p를 보탭니다. 전 구간이 플러스입니다.
 * 갭을 받고 장중에 도로 뱉는 것이지, 보여줄 근거가 없는 게 아닙니다.
 *
 * 두 구간을 같이 읽어야 합니다 -- 이 패널은 하룻밤짜리이고 다음날 종가까지
 * 들고 가면 20% 이상 멤버 말고는 남는 게 없습니다.
 *
 *   [1] 멤버 자신이 얼마나 올랐어야 하는가 -- 멤버 상승률 구간별 초과수익
 *   [2] 테마가 얼마나 뭉쳐 있어야 하는가 -- 그날 그 테마에서 3% 이상 오른
 *       멤버의 비율(응집도)별 초과수익
 *
 * 기준선은 언제나 그날 시장 평균입니다. 테마가 통째로 오르는 날은 아무거나 사도
 * 오르고 그건 규칙의 공이 아닙니다.
 */

const config = readConfig();
const minTurnover = 1_000_000_000;
const minLeaderMove = 5;

const { rows } = await query(config, `
  WITH members AS (
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_members
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\(REITs\)|국내 상장 중국기업|지주사)'
  ),
  bars AS (
    SELECT symbol, session_date, close, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  moves AS (
    SELECT symbol, session_date, turnover,
           (close / prev_close - 1) * 100 AS day_move,
           (next_close / close - 1) * 100 AS next_day
      FROM bars
     WHERE prev_close > 0 AND close > 0 AND next_close IS NOT NULL
  ),
  nights AS (
    SELECT session_date, avg(next_day) AS market_next
      FROM moves GROUP BY session_date HAVING count(*) >= 50
  ),
  -- 응집도는 거래대금 문턱 **전에** 재야 합니다. 문턱 뒤에 재면 큰 종목만 남은
  -- 테마가 저절로 뭉쳐 보입니다.
  coherence AS (
    SELECT t.theme_name, m.session_date,
           avg(CASE WHEN m.day_move >= 3 THEN 1.0 ELSE 0 END) * 100 AS hot_share,
           count(*) AS listed
      FROM moves m JOIN members t ON t.symbol = m.symbol
     GROUP BY t.theme_name, m.session_date
  ),
  themed AS (
    SELECT m.symbol, m.session_date, m.turnover, m.day_move, m.next_day, t.theme_name,
           row_number() OVER (PARTITION BY t.theme_name, m.session_date
                              ORDER BY m.turnover DESC) AS turnover_rank,
           count(*) OVER (PARTITION BY t.theme_name, m.session_date) AS theme_size
      FROM moves m JOIN members t ON t.symbol = m.symbol
     WHERE m.day_move > 0 AND m.turnover >= ${minTurnover}
  ),
  leaders AS (
    SELECT theme_name, session_date, symbol AS leader_symbol, day_move AS leader_move
      FROM themed WHERE turnover_rank = 1 AND day_move >= ${minLeaderMove} AND theme_size >= 2
  )
  SELECT l.session_date::text AS d, l.theme_name, l.leader_move,
         f.symbol AS follower, f.day_move AS follower_move,
         f.next_day - n.market_next AS excess,
         c.hot_share, c.listed
    FROM leaders l
    JOIN themed f ON f.theme_name = l.theme_name AND f.session_date = l.session_date
                 AND f.symbol <> l.leader_symbol
    JOIN nights n ON n.session_date = l.session_date
    JOIN coherence c ON c.theme_name = l.theme_name AND c.session_date = l.session_date
`);

const num = (v) => Number(v);
const nights = new Set(rows.map((r) => r.d)).size;

function report(label, list) {
  if (list.length < 50) {
    console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 표본 부족`);

    return;
  }

  const xs = list.map((r) => num(r.excess));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;
  // 표본이 커지면 작은 평균도 유의해 보입니다. t값을 같이 적어 눈으로 거를 수 있게.
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  const t = mean / (sd / Math.sqrt(xs.length));

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 상회 ${String(Math.round((beat / xs.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p · t ${t.toFixed(1)}`);
}

console.log(`\n멤버 ${rows.length.toLocaleString("ko-KR")}건 · 밤 ${nights}개 · 주도주 ${minLeaderMove}%↑ · 거래대금 10억↑`);
console.log(`기준선 = 그날 시장 평균 익일 수익률. 초과 0이면 규칙이 아무것도 안 한 것입니다.\n`);

console.log("[1] 멤버 자신이 얼마나 올랐어야 하는가");
report("전체 (지금 조건: >0%)", rows);
[[0, 1], [1, 3], [3, 5], [5, 10], [10, 100]].forEach(([lo, hi]) =>
  report(`  ${lo}~${hi}%`, rows.filter((r) => num(r.follower_move) > lo && num(r.follower_move) <= hi)));

console.log("\n[2] 테마 응집도 — 그날 그 테마에서 3%↑ 오른 비율");
[[0, 10], [10, 20], [20, 35], [35, 100]].forEach(([lo, hi]) =>
  report(`  ${lo}~${hi}%`, rows.filter((r) => num(r.hot_share) > lo && num(r.hot_share) <= hi)));

console.log("\n[3] 테마 크기 — 넓은 테마가 묽은가");
[[2, 20], [20, 50], [50, 120], [120, 9999]].forEach(([lo, hi]) =>
  report(`  ${lo}~${hi}종목`, rows.filter((r) => num(r.listed) >= lo && num(r.listed) < hi)));

console.log("\n[4] 두 조건을 같이 걸면");
report("멤버 3%↑", rows.filter((r) => num(r.follower_move) >= 3));
report("응집도 20%↑", rows.filter((r) => num(r.hot_share) >= 20));
report("멤버 3%↑ + 응집도 20%↑", rows.filter((r) => num(r.follower_move) >= 3 && num(r.hot_share) >= 20));

process.exit(0);
