import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 짝꿍매매 실측 — 만들어 놓고 한 번도 재지 않은 것을.
 *
 * 화면이 하는 주장은 하나입니다: 테마 주도주가 올랐고 같은 테마의 어떤 종목이
 * 아직 덜 올랐다면, 그 벌어진 만큼이 트레이드가 사는 자리다. `leadGap`이 그
 * 값이고 보드는 그것이 큰 순서로 정렬합니다. 음수는 "이미 주도주보다 더 갔다 =
 * 늦게 읽은 것"이라고 적어 두고 맨 뒤로 보냅니다.
 *
 * 반증 가능한 문장입니다. 뒤처진 종목이 정말 따라오는가, 그리고 벌어진 폭이 클수록
 * 더 따라오는가.
 *
 * 재는 방식은 종가배팅과 같습니다 -- 수익률의 절대값이 아니라 **그날 시장 평균
 * 대비 초과분**입니다. 테마가 통째로 오르는 날은 아무거나 사도 오르고, 그 부분은
 * 짝꿍 규칙의 공이 아닙니다.
 *
 * 테마 편입은 kr_theme_members의 **현재** 스냅샷입니다. 2025년 데이터에 오늘의
 * 편입을 적용하므로 사후편향이 있습니다 -- 지금 그 테마에 속한 종목만 후보가 되고,
 * 당시 편입됐다가 빠진 종목은 사라집니다. 사업 테마는 편입이 잘 안 바뀌어 영향이
 * 작을 것으로 보지만, 작다는 근거는 없습니다. 숫자를 그만큼 할인해서 읽어야 합니다.
 *
 *   node scripts/measure-pair-trade.mjs [--min-leader-move 5] [--min-turnover 1000000000]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const minLeaderMove = flag("min-leader-move", 5);
const minTurnover = flag("min-turnover", 1_000_000_000);

const { rows } = await query(config, `
  WITH members AS (
    -- 지수·구조 테마는 사업이 아니라 상장 형태입니다. 짝꿍이 성립하지 않습니다.
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_members
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)'
  ),
  bars AS (
    SELECT symbol, session_date, close, volume, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(close) OVER w AS next_close,
           lead(open) OVER w AS next_open
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  moves AS (
    SELECT symbol, session_date, turnover,
           (close / prev_close - 1) * 100 AS day_move,
           (next_close / close - 1) * 100 AS next_day,
           (next_open / close - 1) * 100 AS gap,
           -- 갭을 먹고 그대로 들고 있으면 어떻게 되는가. 갭과 익일 종가의 차이가
           -- 그날 장중에 되돌린 몫입니다.
           (next_close / nullif(next_open, 0) - 1) * 100 AS next_intraday
      FROM bars
     WHERE prev_close > 0 AND close > 0 AND next_close IS NOT NULL
  ),
  nights AS (
    SELECT session_date, avg(next_day) AS market_next, avg(gap) AS market_gap,
           avg(next_intraday) AS market_intraday
      FROM moves GROUP BY session_date HAVING count(*) >= 50
  ),
  themed AS (
    SELECT m.symbol, m.session_date, m.turnover, m.day_move, m.next_day, m.gap,
           m.next_intraday, t.theme_name,
           -- 주도주는 그 테마에서 오늘 거래대금이 가장 큰 상승 종목입니다.
           -- 보드가 쓰는 정의와 같습니다.
           row_number() OVER (PARTITION BY t.theme_name, m.session_date
                              ORDER BY m.turnover DESC) AS turnover_rank,
           count(*) OVER (PARTITION BY t.theme_name, m.session_date) AS theme_size
      FROM moves m
      JOIN members t ON t.symbol = m.symbol
     WHERE m.day_move > 0 AND m.turnover >= ${minTurnover}
  ),
  leaders AS (
    SELECT theme_name, session_date, symbol AS leader_symbol,
           day_move AS leader_move, next_day AS leader_next, gap AS leader_gap,
           theme_size
      FROM themed WHERE turnover_rank = 1 AND day_move >= ${minLeaderMove} AND theme_size >= 2
  ),
  -- 짝꿍 테마가 "뒤처진 것이 따라온다"가 아니라 "호재가 테마를 만들고 그 안에서
  -- 순서대로 움직인다"라면, 주도주에 재료가 있었는지가 조건이어야 합니다. 재료가
  -- 없는 날의 동반 상승은 그냥 섹터가 같이 흔들린 것일 수 있습니다.
  catalysts AS (
    SELECT symbol, session_date, array_agg(DISTINCT tag) AS tags
      FROM market_disclosures, unnest(tags) AS tag
     WHERE market = 'KR' AND symbol IS NOT NULL AND session_date IS NOT NULL
     GROUP BY symbol, session_date
  )
  SELECT coalesce(lc.tags, ARRAY[]::text[]) AS leader_tags,
         coalesce(fc.tags, ARRAY[]::text[]) AS follower_tags,
         l.session_date::text AS d, l.theme_name, l.leader_symbol, l.leader_move,
         l.leader_next, l.leader_gap, l.theme_size,
         f.symbol AS follower, f.day_move AS follower_move, f.next_day AS follower_next,
         f.gap AS follower_gap, f.next_intraday AS follower_intraday, f.turnover AS follower_turnover,
         l.leader_move - f.day_move AS lead_gap,
         f.next_day - n.market_next AS follower_excess,
         l.leader_next - n.market_next AS leader_excess,
         f.gap - n.market_gap AS follower_gap_excess,
         f.next_intraday - n.market_intraday AS follower_intraday_excess
    FROM leaders l
    JOIN themed f ON f.theme_name = l.theme_name AND f.session_date = l.session_date
                 AND f.symbol <> l.leader_symbol
    JOIN nights n ON n.session_date = l.session_date
    LEFT JOIN catalysts lc ON lc.symbol = l.leader_symbol AND lc.session_date = l.session_date
    LEFT JOIN catalysts fc ON fc.symbol = f.symbol AND fc.session_date = l.session_date
   WHERE l.session_date >= (SELECT min(session_date) FROM market_disclosures WHERE market = 'KR')
`);

const num = (v) => Number(v);
const nights = new Set(rows.map((r) => r.d)).size;
const report = (label, list, key = "follower_excess") => {
  if (list.length < 50) {
    console.log(`  ${label.padEnd(32)} ${String(list.length).padStart(6)}건 · 표본 부족`);

    return;
  }

  const xs = list.map((r) => num(r[key]));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(32)} ${String(list.length).padStart(6)}건 · 시장 상회 ${String(Math.round((beat / xs.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log(`짝꿍 쌍 ${rows.length}건 · 밤 ${nights}개 · 주도주 ${minLeaderMove}%↑ · 거래대금 ${(minTurnover / 1e8).toFixed(0)}억↑`);
console.log(`기간 ${rows.reduce((a, r) => (r.d < a ? r.d : a), "9999")} ~ ${rows.reduce((a, r) => (r.d > a ? r.d : a), "0")}`);
console.log("\n기준선은 그날 시장 평균 익일 수익률입니다. 초과가 0이면 규칙이 아무것도 안 한 것입니다.\n");

console.log("[1] 짝꿍은 따라오는가 — 익일 종가 기준");
report("짝꿍 전체", rows);
report("  주도주 자신 (비교용)", rows, "leader_excess");

console.log("\n[2] leadGap이 클수록 더 따라오는가 — 보드의 정렬 근거");
report("leadGap 0~3%p", rows.filter((r) => num(r.lead_gap) > 0 && num(r.lead_gap) <= 3));
report("leadGap 3~7%p", rows.filter((r) => num(r.lead_gap) > 3 && num(r.lead_gap) <= 7));
report("leadGap 7~15%p", rows.filter((r) => num(r.lead_gap) > 7 && num(r.lead_gap) <= 15));
report("leadGap 15%p 초과", rows.filter((r) => num(r.lead_gap) > 15));
report("leadGap 음수 (이미 더 감)", rows.filter((r) => num(r.lead_gap) <= 0));

console.log("\n[3] 주도주가 셀수록 좋은가");
report("주도주 5~10%", rows.filter((r) => num(r.leader_move) >= 5 && num(r.leader_move) < 10));
report("주도주 10~20%", rows.filter((r) => num(r.leader_move) >= 10 && num(r.leader_move) < 20));
report("주도주 20% 이상", rows.filter((r) => num(r.leader_move) >= 20));

console.log("\n[4] 테마가 넓을수록 좋은가");
report("같이 오른 멤버 2~3개", rows.filter((r) => num(r.theme_size) <= 3));
report("같이 오른 멤버 4~7개", rows.filter((r) => num(r.theme_size) >= 4 && num(r.theme_size) <= 7));
report("같이 오른 멤버 8개 이상", rows.filter((r) => num(r.theme_size) >= 8));

console.log("\n[5] 언제 파는가 — 같은 종목을 세 구간으로 쪼개면");
report("① 종가 → 익일 시가 (갭)", rows, "follower_gap_excess");
report("② 익일 시가 → 익일 종가 (장중)", rows.filter((r) => r.follower_intraday !== null), "follower_intraday_excess");
report("③ 종가 → 익일 종가 (하루 보유)", rows);

console.log("\n[6] leadGap 음수만 — 보드가 맨 뒤로 보내는 것들");
const ran = rows.filter((r) => num(r.lead_gap) <= 0);

report("① 갭", ran, "follower_gap_excess");
report("② 장중", ran.filter((r) => r.follower_intraday !== null), "follower_intraday_excess");
report("③ 하루 보유", ran);

/*
 * 호재가 테마를 만드는가.
 *
 * 짝꿍이 성립하는 자리가 "뒤처진 것"이 아니라 "재료가 붙은 테마"라면, 주도주에
 * 공시가 있었던 날만 골라야 숫자가 살아나야 합니다.
 */
const good = new Set(["계약·수주", "주주환원", "인수합병", "설비투자", "실적", "경영권"]);
const leaderHasCatalyst = (r) => (r.leader_tags ?? []).some((tag) => good.has(tag));
const anyFiling = (r) => (r.leader_tags ?? []).length > 0;

console.log("\n[7] 주도주에 재료가 있었는가 — 짝꿍 테마가 호재에서 만들어진다면");
report("주도주 공시 없음 · 갭", rows.filter((r) => !anyFiling(r)), "follower_gap_excess");
report("주도주 공시 있음 · 갭", rows.filter(anyFiling), "follower_gap_excess");
report("주도주 호재 공시 · 갭", rows.filter(leaderHasCatalyst), "follower_gap_excess");
report("주도주 호재 · 하루 보유", rows.filter(leaderHasCatalyst));
report("주도주 호재 + leadGap 양수 · 갭", rows.filter((r) => leaderHasCatalyst(r) && num(r.lead_gap) > 0), "follower_gap_excess");
report("주도주 호재 + leadGap 음수 · 갭", rows.filter((r) => leaderHasCatalyst(r) && num(r.lead_gap) <= 0), "follower_gap_excess");
report("짝꿍 자신도 공시 있음 · 갭", rows.filter((r) => (r.follower_tags ?? []).length > 0), "follower_gap_excess");

process.exit(0);
