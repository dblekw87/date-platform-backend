import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 주도주 매매 — 그날 돈이 몰린 종목을 사서 며칠 안에 나오는 것.
 *
 *   npm run kr:leaders
 *
 * 사용자가 하는 매매 넷 중 마지막으로 안 잰 것입니다. 화면에는 이미 주도주 목록이
 * 있지만 **그걸 사면 시장을 이기는가**는 물어본 적이 없습니다.
 *
 * ## 화면의 정의를 그대로 씁니다
 *
 * `providers/leadership.mjs`의 `rankDayLeaders`는 **오른 종목 중 거래대금 비중**으로
 * 줄을 세웁니다(share × 100 + recentShare × 60 + 거래량·상승률 소폭). 여기서는 그
 * 주된 축인 거래대금 순위를 일봉으로 재현합니다. 장중 최근창(recentShare)은 분봉이
 * 8/18부터라 과거에 없습니다 -- 그래서 이 측정은 화면 순위의 **근사**입니다.
 *
 * 새 정의를 만들지 않는 이유는 짝꿍에서 배운 것입니다. 재는 것과 화면에 뜨는 것이
 * 다르면 나온 숫자가 그 화면을 설명하지 못합니다.
 *
 * ## ETF를 빼야 합니다
 *
 * 거래대금 상위는 ETF가 점령합니다 -- 2026-08-21 상위 12개 중 6개가 KODEX·TIGER
 * 였습니다. 주도주 매매의 대상이 아니므로 브랜드 접두어로 걷어냅니다. 이름을 모르는
 * 종목(상장폐지 등으로 universe 스냅샷에 없는 것)은 **남깁니다** -- 빼면 사라진
 * 종목만 빠져서 생존편향이 생깁니다.
 *
 * ## 보유 구간
 *
 * 사이트가 단타용이고 "하루나 길어야 삼일"이라 D+1·D+2·D+3만 봅니다. 하룻밤
 * (종가→익일 시가)도 따로 내서 [[close-bet-findings]]와 같은 자로 비교합니다.
 */

const config = readConfig();
const started = Date.now();

const minimumTurnover = 1_000_000_000;

// 브랜드 접두어. 4,300종목 중 1,031개가 걸립니다.
const etfPattern = "^(KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|SOL |ACE |PLUS |RISE |WOORI|BNK|히어로즈|마이다스|파워|TIMEFOLIO|KIWOOM|FOCUS|KTOP|TREX|네비게이터|비대면)";

const { rows } = await query(config, `
  WITH named AS (
    SELECT b.symbol, b.session_date, b.open, b.close, b.volume,
           b.close * b.volume AS turnover,
           u.name,
           lag(b.close) OVER w AS prev_close,
           lead(b.open) OVER w AS next_open,
           lead(b.close, 1) OVER w AS c1,
           lead(b.close, 2) OVER w AS c2,
           lead(b.close, 3) OVER w AS c3
      FROM kr_daily_bars b
      -- LEFT JOIN이라 이름을 모르는 종목도 남습니다. 그쪽을 빼면 상장폐지된
      -- 주도주가 통째로 사라져 성적이 좋아 보입니다.
      LEFT JOIN kr_daily_universe u
        ON u.symbol = b.symbol AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe)
    WINDOW w AS (PARTITION BY b.symbol ORDER BY b.session_date)
  ),
  eligible AS (
    SELECT * FROM named
     WHERE prev_close > 0 AND close > 0 AND c3 IS NOT NULL AND next_open IS NOT NULL
       AND coalesce(name, '') !~ '${etfPattern}'
  ),
  -- 시장은 그날 조건 없는 전 종목 평균입니다. 주도주만으로 평균을 내면 자기 자신을
  -- 빼는 꼴이라 아무것도 안 남습니다.
  market AS (
    SELECT session_date,
           avg((next_open / close - 1) * 100) AS mg,
           avg((c1 / close - 1) * 100) AS m1,
           avg((c2 / close - 1) * 100) AS m2,
           avg((c3 / close - 1) * 100) AS m3
      FROM eligible
     GROUP BY session_date
    HAVING count(*) >= 100
  ),
  rising AS (
    SELECT e.*,
           (e.close / e.prev_close - 1) * 100 AS day_move,
           row_number() OVER (PARTITION BY e.session_date ORDER BY e.turnover DESC) AS money_rank,
           row_number() OVER (PARTITION BY e.session_date ORDER BY (e.close / e.prev_close) DESC) AS move_rank
      FROM eligible e
      JOIN market m ON m.session_date = e.session_date
     -- 화면과 같은 조건: 오른 종목만 주도주가 됩니다.
     WHERE e.close > e.prev_close AND e.turnover >= ${minimumTurnover}
  )
  SELECT r.session_date::text AS d, r.symbol, r.name, r.money_rank, r.move_rank,
         round(r.day_move::numeric, 2) AS day_move,
         (r.next_open / r.close - 1) * 100 - m.mg AS eg,
         (r.c1 / r.close - 1) * 100 - m.m1 AS e1,
         (r.c2 / r.close - 1) * 100 - m.m2 AS e2,
         (r.c3 / r.close - 1) * 100 - m.m3 AS e3,
         (r.next_open / r.close - 1) * 100 AS gg,
         (r.c1 / r.close - 1) * 100 AS g1,
         (r.c2 / r.close - 1) * 100 AS g2,
         (r.c3 / r.close - 1) * 100 AS g3
    FROM rising r
    JOIN market m ON m.session_date = r.session_date
   WHERE r.money_rank <= 30 OR r.move_rank <= 30
`);

const num = (v) => Number(v);
const sessions = new Set(rows.map((r) => r.d)).size;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-일 · ${sessions}개 장 · ETF 제외 · 오른 종목만`);
console.log(`거래대금 또는 상승률 상위 30위 안만 뽑았습니다.\n`);

function line(label, list, key) {
  if (list.length === 0) return console.log(`  ${label.padEnd(24)} 표본 없음`);

  const raw = list.map((r) => num(r[`g${key}`]));
  const exc = list.map((r) => num(r[`e${key}`]));
  const sign = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;

  console.log(`  ${label.padEnd(24)} ${String(list.length).padStart(6)}건 · 하루 ${(list.length / sessions).toFixed(1)}건 · 원수익 ${sign(mean(raw)).padStart(7)}% · 초과 ${sign(mean(exc)).padStart(7)}%p (상회 ${Math.round(exc.filter((x) => x > 0).length / exc.length * 100)}%)`);
}

// pg가 row_number()를 문자열로 돌려주므로 반드시 숫자로 바꿔서 비교합니다.
// `r.money_rank === 1`은 조용히 전부 거짓이 되어 1위 행이 통째로 사라졌습니다.
const money = (r) => num(r.money_rank);
const move = (r) => num(r.move_rank);
// 상한가에 잠긴 종목은 종가에 살 수가 없습니다. 짝꿍매매가 존재하는 이유가 그것이라
// 성적에서 갈라놓지 않으면 "못 사는 자리"의 수익을 살 수 있는 것처럼 보고하게 됩니다.
const locked = (r) => num(r.day_move) >= 29;

const groups = [
  { label: "거래대금 1위", test: (r) => money(r) === 1 },
  { label: "거래대금 2~3위", test: (r) => money(r) >= 2 && money(r) <= 3 },
  { label: "거래대금 4~8위", test: (r) => money(r) >= 4 && money(r) <= 8 },
  { label: "거래대금 9~30위", test: (r) => money(r) >= 9 && money(r) <= 30 },
  { label: "상승률 1~5위 (전체)", test: (r) => move(r) <= 5 },
  { label: "  └ 상한가 (못 삼)", test: (r) => move(r) <= 5 && locked(r) },
  { label: "  └ 상한가 아님 (살 수 있음)", test: (r) => move(r) <= 5 && !locked(r) },
  { label: "거래대금 8위내 & 5%↑", test: (r) => money(r) <= 8 && num(r.day_move) >= 5 },
  { label: "거래대금 8위내 & 10%↑", test: (r) => money(r) <= 8 && num(r.day_move) >= 10 }
];

const horizons = [
  { key: "g", label: "하룻밤 (종가→익일 시가)" },
  { key: "1", label: "D+1 종가" },
  { key: "2", label: "D+2 종가" },
  { key: "3", label: "D+3 종가" }
];

for (const horizon of horizons) {
  console.log(`=== ${horizon.label} ===\n`);
  groups.forEach((g) => line(g.label, rows.filter(g.test), horizon.key));
  console.log("");
}

console.log(`${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
