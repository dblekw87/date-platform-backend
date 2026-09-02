import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { closeBetCandidateSql, historyBoundFor } from "../src/providers/close-bet.mjs";

/**
 * 국내장이 끝나면 스스로 채점하고, 사전이 빠뜨린 테마 후보를 찾습니다.
 *
 *   node scripts/nightly-review.mjs [YYYY-MM-DD]
 *
 * 세 가지를 합니다.
 *
 *   1. 오늘 난 신호를 기록한다
 *   2. 다음 거래일 봉이 들어온 신호를 채점한다
 *   3. 같이 움직였는데 공유 테마가 없는 쌍을 센다
 *
 * **왜 기록부터인가.** 지금까지는 신호가 맞았는지를 사람이 그때그때 확인했습니다.
 * 그러면 기억에 남는 것만 남습니다 -- 2026-08-27 VNRX는 조건에 맞아 알림이 나갔고
 * 마감 -20.8%였는데, 물어보지 않았으면 아무 데도 안 남았을 것입니다. 스무 건쯤
 * 쌓여야 조건이 진짜인지 말할 수 있고, 그 스무 건은 저절로 모이지 않습니다.
 *
 * **왜 자동 반영을 안 하는가.** 테마 귀속을 자동 판정하려는 시도가 다섯 번
 * 실패했습니다 -- 멤버 비교, 회원 겹침, 이름 토큰, 뉴스 지목, 재료 분리 전부
 * 멀쩡한 카드를 부쉈습니다. 그래서 여기서는 후보를 세기만 하고 반영은 근거가
 * 쌓인 뒤 사람이 켭니다. 발견까지는 자동이라 손으로 찾을 일은 없습니다.
 */

const config = readConfig();
// 날짜처럼 생긴 인자만 날짜로 봅니다. --backfill 같은 깃발과 그 값이 여기 걸리면
// 'YYYY-MM-DD'가 아닌 문자열이 date로 넘어가 파싱에서 터집니다.
const asked = process.argv.slice(2).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? null;

async function sessionDay() {
  if (asked) return asked;

  const { rows } = await query(config, "SELECT max(session_date)::text AS d FROM market_price_samples WHERE market='KR'");

  return rows[0].d;
}

/** 오늘 난 짝꿍 신호를 남깁니다. 이미 있으면 덮지 않습니다 -- 처음 잡힌 상태가 신호입니다. */
async function record(day) {
  const result = await query(config, `
    WITH ticks AS (
      SELECT symbol, observed_at, change_rate
        FROM market_price_samples
       WHERE market='KR' AND session_date=$1::date AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
    ),
    members AS (
      SELECT DISTINCT symbol, theme_name FROM kr_theme_membership
       WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠|지주사)'
    ),
    locked AS (
      SELECT DISTINCT ON (symbol) symbol, observed_at AS lock_at
        FROM ticks WHERE change_rate >= 29.5 ORDER BY symbol, observed_at
    ),
    paired AS (
      SELECT DISTINCT ON (s.symbol)
             s.symbol, s.change_rate AS entry_rate, s.observed_at AS detected_at,
             l.symbol AS leader_symbol, m.theme_name
        FROM locked l
        JOIN members m ON m.symbol = l.symbol
        JOIN members m2 ON m2.theme_name = m.theme_name AND m2.symbol <> l.symbol
        JOIN ticks s ON s.symbol = m2.symbol
         AND s.observed_at BETWEEN l.lock_at AND l.lock_at + interval '3 minutes'
         AND s.change_rate BETWEEN 10 AND 29
       ORDER BY s.symbol, s.observed_at
    )
    INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme,
                                    entry_rate, leader_symbol, leader_rate)
    SELECT 'limit_pair', $1::date, p.symbol, p.detected_at, '상한가', p.theme_name,
           p.entry_rate, p.leader_symbol, 30
      FROM paired p
    ON CONFLICT (kind, session_date, symbol) DO NOTHING
  `, [day]);

  return result.rowCount ?? 0;
}

/*
 * 종가배팅 후보를 그날치로 기록합니다.
 *
 * 짝꿍만 채점하고 있었습니다. 종가배팅은 사용자가 실제로 가장 많이 쓰는 매매인데
 * 그날 무엇이 떴는지가 아무 데도 안 남아서, 조건을 바꾼 뒤 좋아졌는지 나빠졌는지를
 * 물어볼 수가 없었습니다. 2026-08-29에 윗꼬리 문턱을 0.3에서 0.15로 좁혔으니
 * 특히 그렇습니다 -- 좁힌 판단이 맞았는지는 그 뒤에 뜬 후보들로만 답할 수 있습니다.
 *
 * 화면과 **같은 SQL**을 씁니다. 여기서 조건을 다시 쓰면 화면에 뜬 것과 채점된 것이
 * 달라져서, 채점 결과가 화면에 대해 아무 말도 못 하게 됩니다.
 *
 * detected_at은 15:30입니다. 실제 진입 자리이고, 짝꿍처럼 장중에 잡히는 신호가
 * 아니라 마감에 한 번 정해지는 신호이기 때문입니다.
 */
async function recordCloseBet(day) {
  const result = await query(config, `
    WITH candidates AS (${closeBetCandidateSql({ day, since: historyBoundFor(day) })})
    INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
    SELECT 'close_bet', c.session_date, c.symbol,
           (c.session_date + interval '15 hours 30 minutes') AT TIME ZONE 'Asia/Seoul',
           c.size_label, NULL, c.day_move
      FROM candidates c
     WHERE c.session_date = $1::date
    ON CONFLICT (kind, session_date, symbol) DO NOTHING
  `, [day]);

  return result.rowCount ?? 0;
}
/** 그날 이후를 채웁니다. 다음 거래일 봉이 들어온 것만 채점됩니다. */
async function score() {
  const result = await query(config, `
    /*
     * intraday는 **선택**입니다.
     *
     * 예전에는 필수였습니다(FROM intraday i, nextday n). 짝꿍은 장중에 잡히니
     * 그 뒤 분봉이 남아 문제가 없었는데, 종가배팅은 15:30에 정해집니다 --
     * detected_at 뒤의 분봉이 없어서 조인이 비고, 그 신호는 영원히 scored_at이
     * NULL로 남습니다. 채점되지 않는 것은 없는 것과 같습니다.
     */
    WITH intraday AS (
      SELECT o.kind, o.session_date, o.symbol,
             min(s.change_rate) AS low, max(s.change_rate) AS high,
             (array_agg(s.change_rate ORDER BY s.observed_at DESC))[1] AS close
        FROM kr_signal_outcomes o
        JOIN market_price_samples s ON s.symbol=o.symbol AND s.session_date=o.session_date
         AND s.market='KR' AND s.source LIKE 'kis:krx%' AND s.observed_at > o.detected_at
       WHERE o.scored_at IS NULL
       GROUP BY o.kind, o.session_date, o.symbol
    ),
    nextday AS (
      SELECT o.kind, o.session_date, o.symbol, b.open AS next_open, b.close AS next_close
        FROM kr_signal_outcomes o
        JOIN LATERAL (
          SELECT open, close FROM kr_daily_bars d
           WHERE d.symbol = o.symbol AND d.session_date > o.session_date
           ORDER BY d.session_date LIMIT 1
        ) b ON true
       WHERE o.scored_at IS NULL
    ),
    market AS (
      SELECT session_date, avg(open / nullif(prev, 0) - 1) * 100 AS gap
        FROM (SELECT symbol, session_date, open,
                     lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
                FROM kr_daily_bars) t
       WHERE prev > 0 GROUP BY session_date HAVING count(*) >= 50
    )
    UPDATE kr_signal_outcomes o
       SET session_low = i.low, session_high = i.high, session_close = i.close,
           next_open = n.next_open, next_close = n.next_close,
           market_next_open = (SELECT gap FROM market m
                                WHERE m.session_date > o.session_date
                                ORDER BY m.session_date LIMIT 1),
           scored_at = now()
      FROM nextday n
      LEFT JOIN intraday i
        ON i.kind = n.kind AND i.session_date = n.session_date AND i.symbol = n.symbol
     WHERE n.kind=o.kind AND n.session_date=o.session_date AND n.symbol=o.symbol
       AND o.scored_at IS NULL
  `);

  return result.rowCount ?? 0;
}

/**
 * 같이 크게 움직였는데 공유 테마가 없는 쌍을 셉니다.
 *
 * 하루 같이 오른 것은 우연입니다. 매주 같이 오르면 사전이 놓친 무언가가 있는
 * 것이고, 그때 사람이 보고 판단합니다.
 */
async function candidates(day) {
  const result = await query(config, `
    WITH moved AS (
      SELECT DISTINCT ON (symbol) symbol
        FROM market_price_samples
       WHERE market='KR' AND session_date=$1::date AND source LIKE 'kis:krx%'
         AND change_rate >= 10 AND turnover >= 1000000000
       ORDER BY symbol, observed_at DESC
    ),
    orphan AS (
      SELECT a.symbol AS left_symbol, b.symbol AS right_symbol
        FROM moved a JOIN moved b ON a.symbol < b.symbol
       WHERE NOT EXISTS (
         SELECT 1 FROM kr_theme_membership ma
           JOIN kr_theme_membership mb ON mb.theme_name = ma.theme_name
          WHERE ma.symbol = a.symbol AND mb.symbol = b.symbol)
    )
    INSERT INTO kr_theme_candidates (left_symbol, right_symbol, first_seen, last_seen)
    SELECT left_symbol, right_symbol, $1::date, $1::date FROM orphan
    ON CONFLICT (left_symbol, right_symbol) DO UPDATE
      SET seen_days = kr_theme_candidates.seen_days + 1, last_seen = EXCLUDED.last_seen
     WHERE kr_theme_candidates.last_seen < EXCLUDED.last_seen
  `, [day]);

  return result.rowCount ?? 0;
}

/*
 * --backfill N: 지난 N개 장의 종가배팅 후보를 한 번에 기록합니다.
 *
 * 오늘치만 쌓으면 채점된 표본이 스무 건을 넘는 데 몇 주가 걸립니다. 후보를
 * 만드는 SQL이 과거 날짜에도 그대로 도니, 지난 장을 훑어 채워 두면 월요일부터
 * 바로 볼 것이 생깁니다. **미래를 안 씁니다** -- 후보 판정은 그날 종가까지의
 * 정보만 쓰고, 채점은 다음날 봉으로 따로 합니다.
 */
const backfillAt = process.argv.indexOf("--backfill");

if (backfillAt >= 0) {
  const count = Number(process.argv[backfillAt + 1] ?? 60);
  const { rows: days } = await query(config, `
    SELECT session_date::text AS d FROM kr_daily_bars
     GROUP BY session_date ORDER BY session_date DESC LIMIT $1`, [count]);
  let written = 0;

  console.log("");
  console.log(`종가배팅 후보 소급 기록 · 지난 ${days.length}개 장`);

  for (const row of days.reverse()) written += await recordCloseBet(row.d);

  console.log(`  ${written}건 기록`);
  console.log(`  채점 ${await score()}건`);
  console.log("");
}

const day = await sessionDay();

console.log("");
console.log(`=== ${day} 국내장 정리 ===`);
console.log("");
console.log(`  짝꿍 기록   ${await record(day)}건`);
console.log(`  종가배팅    ${await recordCloseBet(day)}건`);
console.log(`  채점 완료   ${await score()}건`);
console.log(`  테마 후보   ${await candidates(day)}쌍`);

const summary = await query(config, `
  SELECT kind, count(*) AS n,
         round(avg(session_low - entry_rate)::numeric, 2) AS drawdown,
         count(*) FILTER (WHERE session_low - entry_rate <= -10) AS deep,
         round(avg(session_close - entry_rate)::numeric, 2) AS to_close
    FROM kr_signal_outcomes
   WHERE scored_at IS NOT NULL
     -- 종가배팅은 뺍니다. 이 요약의 축은 장중 되돌림인데, 15:30에 사는 신호에는
     -- 장중이 없습니다 -- 컬럼이 비어서 평균이 0에 가깝게 나오고, 그 0이
     -- '되돌림이 없었다'로 읽힙니다. 아래에서 밤 기준으로 따로 셉니다.
     AND kind <> 'close_bet'
   GROUP BY kind`);

/*
 * 종가배팅은 따로 셉니다.
 *
 * 위의 요약은 장중 되돌림(session_low - entry_rate)이 축인데, 종가배팅에는 그런
 * 것이 없습니다 -- 15:30에 사서 다음날 아침에 파니 보유 구간이 통째로 밤입니다.
 * 재야 할 값은 **그날 밤 시장 평균 갭을 뺀 초과분** 하나뿐이고, 그건 진입가(당일
 * 종가)가 있어야 계산되므로 일봉을 다시 붙입니다.
 */
const closeBet = await query(config, `
  WITH market AS (
    SELECT session_date, avg(open / nullif(prev, 0) - 1) * 100 AS gap
      FROM (SELECT symbol, session_date, open,
                   lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
              FROM kr_daily_bars) t
     WHERE prev > 0 GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT o.tier, count(*) AS n,
         round(avg((o.next_open / b.close - 1) * 100 - m.gap)::numeric, 3) AS excess,
         round((count(*) FILTER (WHERE (o.next_open / b.close - 1) * 100 - m.gap > 0)::numeric
                / nullif(count(*), 0) * 100), 0) AS beat
    FROM kr_signal_outcomes o
    JOIN kr_daily_bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
    JOIN LATERAL (SELECT gap FROM market m2 WHERE m2.session_date > o.session_date
                   ORDER BY m2.session_date LIMIT 1) m ON true
   WHERE o.kind = 'close_bet' AND o.scored_at IS NOT NULL AND o.next_open IS NOT NULL
   GROUP BY o.tier ORDER BY o.tier
`);

if (closeBet.rows.length > 0) {
  console.log("");
  console.log("종가배팅 채점 누적 — 익일 시가 청산, 그날 밤 시장 평균 갭을 뺀 초과분");
  console.log("");
  closeBet.rows.forEach((row) =>
    console.log(`  ${String(row.tier).padEnd(6)} ${String(row.n).padStart(4)}건 · 초과 ${Number(row.excess) >= 0 ? "+" : ""}${row.excess}%p · 상회 ${row.beat}%`));
  console.log("");
  console.log("  보정표(kr_close_bet_calibration)와 벌어지면 조건이 시장과 안 맞기 시작한 것입니다.");
}
if (summary.rows.length > 0) {
  console.log("");
  console.log("채점된 신호 누적");
  console.log("");
  summary.rows.forEach((row) =>
    console.log(`  ${String(row.kind).padEnd(12)} ${String(row.n).padStart(4)}건 · 되돌림 ${row.drawdown}%p · 10%p 이상 ${row.deep}건 · 마감까지 ${row.to_close}%p`));
  console.log("");
  console.log("  ※ 20건을 넘기 전에는 조건을 바꾸지 마세요. 한 건 빗나갔다고 고치면 과적합입니다.");
}

const top = await query(config, `
  SELECT c.seen_days,
         (SELECT name FROM kr_daily_universe u WHERE u.symbol=c.left_symbol ORDER BY session_date DESC LIMIT 1) AS left_name,
         (SELECT name FROM kr_daily_universe u WHERE u.symbol=c.right_symbol ORDER BY session_date DESC LIMIT 1) AS right_name
    FROM kr_theme_candidates c WHERE c.seen_days >= 2
   ORDER BY c.seen_days DESC, c.last_seen DESC LIMIT 10`);

console.log("");
console.log("반복된 테마 후보 (공유 테마 없이 같이 오름)");
console.log("");

if (top.rows.length === 0) console.log("  아직 없음 -- 이틀 이상 반복돼야 올라옵니다");

top.rows.forEach((row) =>
  console.log(`  ${row.seen_days}일  ${String(row.left_name ?? "?").padEnd(14)} ↔ ${row.right_name ?? "?"}`));

process.exit(0);
