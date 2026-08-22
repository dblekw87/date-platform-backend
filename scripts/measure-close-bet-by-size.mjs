import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅 문턱을 규모별로 -- 대형주가 구조적으로 빠지지 않도록.
 *
 * 지금 조건은 "당일 10% 이상"이고, 그것은 실측에서 나온 값이지만 한 가지를 놓쳤습니다:
 * 초대형주는 하루 10%를 거의 움직이지 않습니다. 삼성전자와 SK하이닉스는 1.6년간
 * 조건을 만족한 날이 0일입니다. 원전 호재로 두산에너빌리티가 오르는 날을 잡자는
 * 것이 화면의 목적인데, 그 종목은 1.6년에 2일만 걸렸습니다.
 *
 * 버그는 아니고 조건의 성격입니다. 다만 "대·중·소형주가 조건이 맞으면 다 뜬다"가
 * 옳은 화면이므로, 문턱을 규모별로 따로 재야 합니다. 삼성전자의 3%와 소형주의
 * 15%는 같은 종류의 사건입니다.
 *
 * 규모는 kr_daily_universe의 **현재** 시가총액으로 나눕니다. 1.6년 동안 구간을
 * 넘나든 종목이 있을 테니 근사입니다 -- 구간 경계에 걸친 종목이 잘못 분류될 수
 * 있고, 그만큼 할인해서 읽어야 합니다.
 *
 *   node scripts/measure-close-bet-by-size.mjs
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH caps AS (
    SELECT DISTINCT ON (symbol) symbol, market_cap
      FROM kr_daily_universe
     WHERE market_cap > 0
     ORDER BY symbol, session_date DESC
  ),
  bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING) AS prior_high,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 61 PRECEDING AND 2 PRECEDING) AS prior_high_yesterday,
           avg(volume) OVER (PARTITION BY symbol ORDER BY session_date
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date
                          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS history
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  scored AS (
    SELECT b.*, c.market_cap,
           (b.next_open / b.close - 1) * 100 AS gap,
           (b.close / b.prev_close - 1) * 100 AS day_move,
           (b.high - b.close) / nullif(b.high - b.low, 0) AS upper_shadow,
           b.volume / nullif(b.avg_volume, 0) AS volume_ratio,
           b.close > b.open AS bullish,
           b.close > b.prior_high AS broke_today,
           b.prev_close > b.prior_high_yesterday AS broke_yesterday
      FROM bars b
      JOIN caps c ON c.symbol = b.symbol
     WHERE b.next_open IS NOT NULL AND b.prev_close > 0 AND b.close > 0 AND b.high > b.low
       AND b.prior_high IS NOT NULL AND b.prior_high_yesterday IS NOT NULL
       AND b.history >= 20 AND b.close * b.volume >= 1000000000
  ),
  nights AS (
    SELECT session_date, avg(gap) AS night_gap
      FROM scored GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT s.session_date::text AS d, s.symbol, s.market_cap, s.day_move, s.upper_shadow,
         s.volume_ratio, s.bullish, s.broke_today, s.broke_yesterday,
         s.gap - n.night_gap AS excess
    FROM scored s JOIN nights n ON n.session_date = s.session_date
`);

const nights = new Set(rows.map((r) => r.d)).size;
const num = (v) => Number(v);
const activated = (r) => r.bullish && r.broke_today && !r.broke_yesterday
  && num(r.upper_shadow) < 0.3 && num(r.volume_ratio) >= 2;

const buckets = [
  { label: "대형 (1조 이상)", test: (r) => num(r.market_cap) >= 1e12 },
  { label: "중형 (3천억~1조)", test: (r) => num(r.market_cap) >= 3e11 && num(r.market_cap) < 1e12 },
  { label: "소형 (3천억 미만)", test: (r) => num(r.market_cap) < 3e11 }
];

const report = (label, list) => {
  if (list.length < 60) {
    console.log(`    ${label.padEnd(16)} ${String(list.length).padStart(5)}건 · 표본 부족`);

    return;
  }

  const xs = list.map((r) => num(r.excess));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`    ${label.padEnd(16)} ${String(list.length).padStart(5)}건 · 하루 ${(list.length / nights).toFixed(1)}건 · 상회 ${String(Math.round((beat / xs.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log(`표본 ${rows.length}건 · 밤 ${nights}개 · 시총 아는 종목만`);
console.log("조건은 활성화양봉 + 윗꼬리30%↓ + 거래량2배↑ 고정, 상승률 문턱만 바꿉니다.\n");

for (const bucket of buckets) {
  const pool = rows.filter(bucket.test);

  console.log(`${bucket.label} · 전체 ${pool.length}건`);

  console.log("  [A] 돌파 요구 + 거래량 문턱을 낮추면 (윗꼬리30%↓ 고정, 당일 5%↑)");
  for (const ratio of [1, 1.2, 1.5, 2, 3]) {
    report(`거래량 ${ratio}배↑`, pool.filter((r) => r.bullish && r.broke_today && !r.broke_yesterday
      && num(r.upper_shadow) < 0.3 && num(r.volume_ratio) >= ratio && num(r.day_move) >= 5));
  }

  console.log("  [B] 돌파를 요구하지 않으면 (윗꼬리30%↓ + 거래량1.5배↑ 고정)");
  for (const threshold of [2, 3, 5, 7, 10]) {
    report(`당일 ${threshold}%↑`, pool.filter((r) => r.bullish
      && num(r.upper_shadow) < 0.3 && num(r.volume_ratio) >= 1.5 && num(r.day_move) >= threshold));
  }

  console.log("  [C] 돌파 요구 · 거래량 1.5배 · 상승률만 바꾸면");
  for (const threshold of [2, 3, 5, 7, 10]) {
    report(`당일 ${threshold}%↑`, pool.filter((r) => r.bullish && r.broke_today && !r.broke_yesterday
      && num(r.upper_shadow) < 0.3 && num(r.volume_ratio) >= 1.5 && num(r.day_move) >= threshold));
  }

  console.log("");
}

process.exit(0);
