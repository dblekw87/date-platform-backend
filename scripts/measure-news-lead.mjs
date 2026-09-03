import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 뉴스가 가격보다 앞서는가 — 그날 안 움직인 종목도 다음 날 오르는가.
 *
 *   node scripts/measure-news-lead.mjs
 *
 * 지금까지 잰 조건은 전부 **가격이 이미 움직인 뒤**였습니다. 종가배팅은 당일 5~10%↑,
 * 주도주는 5%↑ 회원 수. 사용자 지적: "뉴스가 나오면 그것대로 재료가 되어 다음 날
 * 오를 수 있다." 그건 한 번도 조건에 넣은 적이 없습니다.
 *
 * 계기는 2026-09-03 철강입니다. 09시부터 중소형 철강이 +20~30% 갔는데, **전날
 * 주가는 0%였습니다**(금강철강 0.00 · 하이스틸 −0.33 · 넥스틸 −0.78 · 신스틸 −0.73).
 * 그런데 전날 저녁에 철강 기사가 여섯 건 몰려 있었습니다. 가격만 보는 조건으로는
 * 절대 못 잡고, 뉴스만 보는 조건이면 잡혔을 자리입니다.
 *
 * 재는 것: **장 마감 뒤 기사가 난 종목이 다음 날 어떻게 되는가.** 창은 15:30부터
 * 다음 장 08:50까지 -- 종가에 사고 아침에 파는 사람이 실제로 읽을 수 있는 구간입니다.
 *
 * 핵심 분할은 **그날 주가가 움직였는가**입니다. 이미 오른 종목의 저녁 기사는
 * 결과 보도일 수 있고([[close-bet-findings]]의 "기사 시점에 20%↑면 +0.00%p"),
 * 안 움직인 종목의 기사는 다른 것입니다. 둘을 섞으면 답이 안 나옵니다.
 *
 * 값은 그날 밤 **시장 평균 갭 대비 초과분**입니다. 뉴스 코퍼스가 2026-08-14부터라
 * 밤이 열몇 개뿐이니, 방향만 보고 조건으로 옮기지 마세요.
 */

const config = readConfig();
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}%p`;

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close, volume,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  /*
   * 시장 평균 갭을 **표본과 같은 모집단**에서 냅니다.
   *
   * 전 종목 4,300개로 잡으면 거래가 거의 없는 종목이 평균을 끌어내려, 유동성 있는
   * 종목은 무엇이든 시장을 이기는 것처럼 보입니다. 처음 돌렸을 때 "기사 없음"이
   * +1.383%p·상회 75%로 나온 것이 그것이었습니다 -- 아무 신호도 없는 집단이 시장을
   * 그만큼 이길 수는 없습니다. 거래대금 5억 문턱을 양쪽에 똑같이 겁니다.
   */
  market AS (
    SELECT session_date, avg(open / nullif(prev, 0) - 1) * 100 AS gap
      FROM (SELECT symbol, session_date, open, close, volume,
                   lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
              FROM kr_daily_bars) t
     WHERE prev > 0 AND close * volume >= 500000000
     GROUP BY session_date HAVING count(*) >= 50
  ),
  nights AS (
    SELECT b.symbol, b.session_date, b.close,
           (b.close / b.prev_close - 1) * 100 AS day_move,
           b.close * b.volume AS turnover,
           (b.next_open / b.close - 1) * 100
             - (SELECT gap FROM market m WHERE m.session_date > b.session_date
                 ORDER BY m.session_date LIMIT 1) AS gap_excess,
           (b.next_close / b.close - 1) * 100
             - (SELECT gap FROM market m WHERE m.session_date > b.session_date
                 ORDER BY m.session_date LIMIT 1) AS day2_excess
      FROM bars b
     WHERE b.prev_close > 0 AND b.close > 0 AND b.next_open > 0
       AND b.session_date >= '2026-08-14'
  ),
  -- 장 마감 뒤부터 다음 장 시작 전까지. 종가에 사는 사람이 읽을 수 있는 구간입니다.
  evening AS (
    SELECT n.symbol, n.session_date, count(*) AS articles
      FROM nights n
      JOIN market_news_items i
        ON i.region = 'KR' AND n.symbol = ANY(i.related_symbols)
       AND i.published_at AT TIME ZONE 'Asia/Seoul'
             > (n.session_date + interval '15 hours 30 minutes')
       AND i.published_at AT TIME ZONE 'Asia/Seoul'
             < ((SELECT min(session_date) FROM nights n2 WHERE n2.session_date > n.session_date)
                 + interval '8 hours 50 minutes')
     GROUP BY n.symbol, n.session_date
  )
  SELECT n.symbol, n.session_date::text AS d, n.day_move, n.turnover,
         n.gap_excess, n.day2_excess, coalesce(e.articles, 0) AS articles
    FROM nights n LEFT JOIN evening e USING (symbol, session_date)
   WHERE n.gap_excess IS NOT NULL AND n.turnover >= 500000000
`);

const num = (value) => Number(value);
const all = rows.map((row) => ({
  articles: num(row.articles),
  day2: num(row.day2_excess),
  excess: num(row.gap_excess),
  move: num(row.day_move),
  symbol: row.symbol
}));

function report(label, list, key = "excess", floor = 20) {
  const xs = list.map((row) => row[key]).filter((x) => Number.isFinite(x));

  if (xs.length < floor) {
    console.log(`  ${label.padEnd(30)} ${String(xs.length).padStart(6)}건  표본 부족`);

    return;
  }

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length / xs.length * 100;

  console.log(`  ${label.padEnd(30)} ${String(xs.length).padStart(6)}건  초과 ${pct(mean).padStart(9)}  상회 ${beat.toFixed(0).padStart(3)}%`);
}

console.log(`\n저녁 뉴스가 다음 날 갭을 만드는가 · ${all.length.toLocaleString("ko-KR")} 종목-밤`);
console.log("창은 15:30~익일 08:50. 값은 그날 밤 시장 평균 갭 대비 초과분.\n");

console.log("[1] 저녁 기사 유무");
report("기사 없음", all.filter((row) => row.articles === 0));
report("기사 1건", all.filter((row) => row.articles === 1));
report("기사 2건 이상", all.filter((row) => row.articles >= 2));

/*
 * 여기가 사용자가 말한 자리입니다. 그날 가격이 안 움직였는데 저녁에 기사가 난 것 --
 * 가격 조건으로는 절대 후보가 안 되는 종목입니다.
 */
console.log("\n[2] 그날 주가가 안 움직였는데 기사가 난 경우");

const quiet = all.filter((row) => Math.abs(row.move) < 2);

report("보합(±2% 미만) · 기사 없음", quiet.filter((row) => row.articles === 0));
report("보합 · 기사 1건", quiet.filter((row) => row.articles === 1));
report("보합 · 기사 2건 이상", quiet.filter((row) => row.articles >= 2));

console.log("\n[3] 이미 오른 종목의 저녁 기사 — 결과 보도인가");

const ran = all.filter((row) => row.move >= 5);

report("당일 5%↑ · 기사 없음", ran.filter((row) => row.articles === 0));
report("당일 5%↑ · 기사 1건", ran.filter((row) => row.articles === 1));
report("당일 5%↑ · 기사 2건 이상", ran.filter((row) => row.articles >= 2));

console.log("\n[4] 당일 등락 구간별 · 기사 2건 이상");

for (const [low, high, label] of [
  [-100, -2, "하락 −2%↓"], [-2, 2, "보합 ±2%"], [2, 5, "2~5%"],
  [5, 10, "5~10%"], [10, 100, "10%↑"]
]) {
  report(`  ${label}`, all.filter((row) =>
    row.articles >= 2 && row.move >= low && row.move < high));
}

console.log("\n[5] 다음 날 종가까지 들고 가면 (기사 2건 이상)");
report("보합", quiet.filter((row) => row.articles >= 2), "day2");
report("당일 5%↑", ran.filter((row) => row.articles >= 2), "day2");

console.log("");
process.exit(0);
