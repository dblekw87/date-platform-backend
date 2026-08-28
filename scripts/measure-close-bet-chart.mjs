import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 유튜브 종가배팅 3원칙을 우리 데이터로 잽니다.
 *
 *   node scripts/measure-close-bet-chart.mjs
 *
 * 사용자가 가져온 이미지의 세 줄입니다.
 *
 *   1. 강한 재료를 가진 주도섹터에서 종목 찾기
 *   2. 상승 가격대를 쉽게 이탈하지 않는지 확인
 *   3. 일봉상 주가가 5일선 위로 올려놓는지 확인
 *
 * 1번은 여기서 못 잽니다 -- 테마 사전이 현재 시점 스냅샷뿐이라 403일을 소급할 수
 * 없습니다. 재료 쪽(뉴스)은 measure-close-bet-catalyst.mjs가 따로 재고 있습니다.
 *
 * 2번과 3번은 일봉만으로 잽니다.
 *
 *   2번  종가가 당일 레인지의 어디에 붙어 마감했는가. 상단에 붙었으면 오른 값을
 *        지킨 것이고, 하단이면 올랐다가 내준 것입니다.
 *   3번  5일선 **위로 올려놓았는가** -- 어제는 아래, 오늘은 위. 이미 위에 있던
 *        것과 구분합니다. 앞서 잰 "정배열"(+0.009%p)이나 "20일선 위"(+0.024%p)와
 *        다른 조건이라 따로 잽니다. 활성화 양봉이 값을 냈으므로(+0.439%p) 돌파
 *        순간만 따로 보는 것에는 근거가 있습니다.
 *
 * ## 결과 (2026-08-29 · 11,015건 · 399장)
 *
 * **2번은 맞습니다.** 종가가 당일 레인지 상위 85% 위에서 끝난 것이 +2.331%p로
 * 기준(+1.055%p)의 두 배가 넘고, 상회 64%입니다. 그리고 **당일 상승률을 고정해도
 * 네 구간 전부에서 살아남습니다** -- 5~10%에서 +0.647 vs +0.229, 22%↑에서
 * +3.587 vs +1.137. 구간이 달라도 방향이 같으므로 이건 조건 자체의 값입니다.
 *
 * 구간이 매끄럽지 않다는 점이 중요합니다. 하단 +0.685, 중간 +0.264, 상단 +0.282,
 * 고가 마감 +2.331. 기울기가 아니라 **절벽**입니다. 60~85%에 걸쳐 마감한 것은
 * 중간에 마감한 것과 다르지 않습니다.
 *
 * **3번은 아닙니다.** 통제 전에는 좋아 보입니다 -- 고가 마감 위에 5일선 돌파를
 * 얹으면 +2.331 → +3.039%p. 그런데 당일 상승률을 고정하면 네 구간 중 셋에서
 * 오히려 나빠집니다(+0.541 vs +0.647, +0.192 vs +0.791, +0.848 vs +1.487).
 * 22%↑ 구간 하나만 낫습니다.
 *
 * 5일선 돌파가 큰 상승일에 더 자주 생기고 큰 상승일이 더 벌기 때문에 생긴
 * 겉보기였습니다. [[close-bet-findings]]에서 정배열(+0.009%p)·20일선 위
 * (+0.024%p)가 값이 없던 것과 같은 결론이고, **돌파 순간으로 좁혀도 같습니다.**
 *
 * 참고로 '5일선 아래'는 0건입니다. 5% 넘게 오르며 60일 전고점을 뚫은 종목은
 * 언제나 5일선 위입니다 -- 3번은 걸러 주는 조건이 아니라 이미 통과한 조건입니다.
 *
 * 재는 값은 종가배팅 그대로 -- 종가 매수, 익일 시가 매도, **그날 밤 시장 평균 갭을
 * 뺀 초과분**. 밤이 갭의 대부분을 정하므로 절대값을 재면 밤을 재게 됩니다.
 */

const config = readConfig();
const minimumTurnoverRatio = 5;

const { rows } = await query(config, `
  -- 1층: 5일 이동평균. 윈도우 함수는 겹쳐 쓸 수 없으므로 여기서 만들고
  -- 다음 층에서 lag를 겁니다.
  WITH ma AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           avg(close) OVER w5 AS ma5,
           count(*) OVER w5 AS ma5_span
      FROM kr_daily_bars
     WINDOW w5 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)
  ),
  caps AS (
    SELECT symbol, session_date, open, high, low, close, volume, ma5, ma5_span,
           close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lag(ma5) OVER w AS prev_ma5,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING) AS prior_high
      FROM ma
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  shares AS (
    SELECT DISTINCT ON (symbol) symbol, market_cap / nullif(close_price, 0) AS share_count
      FROM kr_daily_universe WHERE market_cap > 0 AND close_price > 0
     ORDER BY symbol, session_date DESC
  ),
  candidates AS (
    SELECT c.symbol, c.session_date,
           (c.close / c.prev_close - 1) * 100 AS day_move,
           (c.next_open / c.close - 1) * 100 AS gap,
           -- 2번: 종가가 당일 레인지의 어디인가. 1이면 고가 마감, 0이면 저가 마감.
           CASE WHEN c.high > c.low THEN (c.close - c.low) / (c.high - c.low) ELSE NULL END AS close_position,
           -- 3번: 오늘 5일선 **위로 올려놓았는가**. 어제는 아래, 오늘은 위.
           (c.ma5_span = 5 AND c.prev_ma5 IS NOT NULL
            AND c.prev_close <= c.prev_ma5 AND c.close > c.ma5) AS crossed_ma5,
           (c.ma5_span = 5 AND c.prev_ma5 IS NOT NULL
            AND c.prev_close > c.prev_ma5 AND c.close > c.ma5) AS kept_above_ma5,
           (c.ma5_span = 5 AND c.close <= c.ma5) AS below_ma5
      FROM caps c
      JOIN shares s ON s.symbol = c.symbol
     WHERE c.prev_close > 0 AND c.next_open IS NOT NULL AND c.prior_high IS NOT NULL
       AND c.turnover >= 1000000000
       AND c.close > c.prior_high
       AND c.volume / nullif(s.share_count, 0) * 100 >= ${minimumTurnoverRatio}
       AND (c.close / c.prev_close - 1) * 100 >= 5
  ),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap
      FROM (SELECT session_date,
                   (lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1) * 100 AS gap
              FROM kr_daily_bars WHERE close > 0) g
     WHERE gap IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT c.symbol, c.session_date::text AS d, c.day_move, c.close_position,
         c.crossed_ma5, c.kept_above_ma5 AS already_above_ma5, c.below_ma5,
         c.gap - n.market_gap AS excess
    FROM candidates c
    JOIN nights n ON n.session_date = c.session_date
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
    console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(5)}건 — 표본 부족`);

    return;
  }

  console.log(`  ${label.padEnd(30)} ${String(s.n).padStart(5)}건 · 초과 ${((s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)).padStart(7)}%p · 상회 ${String(Math.round(s.beat * 100)).padStart(2)}% · t ${s.t.toFixed(1)}`);
};

console.log("");
console.log(`종가배팅 후보 ${rows.length.toLocaleString("ko-KR")}건 · ${new Set(rows.map((r) => r.d)).size}개 장`);
console.log("회전율 5%↑ · 60일 전고점 돌파 · 당일 5%↑ · 거래대금 10억↑");
console.log("종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분");
console.log("");

report("기준 (전체)", rows);

console.log("");
console.log("[2] 상승 가격대를 지켰는가 — 종가가 당일 레인지의 어디인가");
console.log("");

const bands = [[0, 0.3, "하단 (0~30%)"], [0.3, 0.6, "중간 (30~60%)"], [0.6, 0.85, "상단 (60~85%)"], [0.85, 1.01, "고가 마감 (85%↑)"]];

for (const [lo, hi, label] of bands) {
  report(label, rows.filter((row) => {
    const p = Number(row.close_position);

    return Number.isFinite(p) && p >= lo && p < hi;
  }));
}

console.log("");
console.log("[3] 5일선 — 올려놓았는가, 이미 위였는가");
console.log("");

report("오늘 5일선 위로 올려놓음", rows.filter((row) => row.crossed_ma5));
report("이미 5일선 위였음", rows.filter((row) => row.already_above_ma5));
report("5일선 아래", rows.filter((row) => row.below_ma5));

console.log("");
console.log("[2+3] 3번은 2번 위에 무엇을 더하는가 — 이게 진짜 질문입니다");
console.log("");

const topClose = rows.filter((row) => Number(row.close_position) >= 0.85);

report("고가 마감 (85%↑)", topClose);
report("  + 5일선 올려놓음", topClose.filter((row) => row.crossed_ma5));
report("  + 이미 5일선 위였음", topClose.filter((row) => row.already_above_ma5));

console.log("");
report("고가 마감 아님", rows.filter((row) => Number(row.close_position) < 0.85));
report("  + 5일선 올려놓음", rows.filter((row) => Number(row.close_position) < 0.85 && row.crossed_ma5));

console.log("");
console.log("  5일선 돌파가 고가 마감 위에 값을 더하면 첫 줄보다 둘째 줄이 커야 합니다.");
console.log("");
console.log("[통제] 그냥 많이 오른 종목을 고른 것 아닌가 — 당일 상승률을 고정하고 다시");
console.log("");

/*
 * 고가 마감과 5일선 돌파는 둘 다 크게 오른 날에 더 자주 생깁니다. 그러면 조건이
 * 값을 낸 게 아니라 "많이 올랐다"를 다시 말한 것뿐일 수 있습니다. 상승률 구간을
 * 고정하고 그 안에서 갈라야 조건 자체의 값이 보입니다.
 */
const moveBands = [[5, 10], [10, 15], [15, 22], [22, 100]];

for (const [lo, hi] of moveBands) {
  const band = rows.filter((row) => Number(row.day_move) >= lo && Number(row.day_move) < hi);

  console.log(`  당일 ${lo}~${hi === 100 ? "" : hi}% — ${band.length.toLocaleString("ko-KR")}건`);
  report("    고가 마감 + 5일선 돌파", band.filter((row) => Number(row.close_position) >= 0.85 && row.crossed_ma5), 20);
  report("    고가 마감만", band.filter((row) => Number(row.close_position) >= 0.85 && !row.crossed_ma5), 20);
  report("    나머지", band.filter((row) => Number(row.close_position) < 0.85), 20);
  console.log("");
}
console.log("  ※ 1번(강한 재료를 가진 주도섹터)은 여기서 못 잽니다 — 테마 사전이");
console.log("     현재 시점 스냅샷뿐이라 403일을 소급할 수 없습니다. 재료 쪽은");
console.log("     measure-close-bet-catalyst.mjs가 뉴스로 따로 재고 있습니다.");

process.exit(0);
