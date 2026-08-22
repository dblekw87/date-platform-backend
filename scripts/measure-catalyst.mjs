import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 호재가 먼저인가 -- 공시 종류별로 익일 갭을 재서.
 *
 * 종가배팅에서 순서는 호재가 먼저이고 거래량·윗꼬리·신고점 돌파는 그 뒤에 남는
 * 흔적입니다. 지금 화면의 조건은 전부 흔적 쪽이라, 원인을 조건에 넣으려면 "그날 그
 * 종목에 재료가 있었는가"가 익일 갭을 실제로 갈라놓는지부터 봐야 합니다.
 *
 * 두 가지를 묻습니다.
 *
 *   1. 공시 종류마다 익일 갭이 다른가. 계약·수주와 증자·지분이 같을 리 없습니다
 *   2. 차트 조건에 호재를 얹으면 더 좋아지는가, 아니면 차트가 이미 호재를 다 말하고
 *      있어서 아무것도 더해지지 않는가
 *
 * 두 번째가 진짜 질문입니다. 거래량이 터지고 신고점을 돌파한 것이 호재의 흔적이라면,
 * 흔적을 이미 본 뒤에 원인을 또 확인하는 것은 같은 정보를 두 번 세는 것일 수 있습니다.
 *
 * 한계 하나를 먼저 적습니다. backfill한 공시에는 접수 **시각**이 없습니다(과거
 * 날짜는 DART 당일공시 화면이 열리지 않습니다). 그래서 10시 공시와 17시 공시가
 * 구분되지 않는데, 앞엣것은 이미 그날 종가에 반영돼 익일 갭과 상관이 약합니다.
 * 둘을 섞으면 장 마감 후 재료의 효과가 **과소평가**됩니다 -- 즉 여기 나오는 숫자는
 * 하한입니다.
 *
 *   node scripts/measure-catalyst.mjs
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
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
    SELECT symbol, session_date,
           (next_open / close - 1) * 100 AS gap,
           (close / prev_close - 1) * 100 AS day_move,
           (high - close) / nullif(high - low, 0) AS upper_shadow,
           volume / nullif(avg_volume, 0) AS volume_ratio,
           close > open AS bullish,
           close > prior_high AS broke_today,
           prev_close > prior_high_yesterday AS broke_yesterday
      FROM bars
     WHERE next_open IS NOT NULL AND prev_close > 0 AND close > 0 AND high > low
       AND prior_high IS NOT NULL AND prior_high_yesterday IS NOT NULL
       AND history >= 20 AND close * volume >= 1000000000
  ),
  nights AS (
    SELECT session_date, avg(gap) AS night_gap
      FROM scored GROUP BY session_date HAVING count(*) >= 50
  ),
  filings AS (
    SELECT symbol, session_date, array_agg(DISTINCT tag) AS tags
      FROM market_disclosures, unnest(tags) AS tag
     WHERE market = 'KR' AND symbol IS NOT NULL AND session_date IS NOT NULL
     GROUP BY symbol, session_date
  )
  SELECT s.session_date::text AS d, s.symbol, s.day_move, s.upper_shadow, s.volume_ratio,
         s.bullish, s.broke_today, s.broke_yesterday,
         coalesce(f.tags, ARRAY[]::text[]) AS tags,
         s.gap - n.night_gap AS excess
    FROM scored s
    JOIN nights n ON n.session_date = s.session_date
    LEFT JOIN filings f ON f.symbol = s.symbol AND f.session_date = s.session_date
   WHERE s.session_date >= (SELECT min(session_date) FROM market_disclosures WHERE market = 'KR')
     AND s.session_date <= (SELECT max(session_date) FROM market_disclosures WHERE market = 'KR')
`);

const num = (v) => Number(v);
const nights = new Set(rows.map((r) => r.d)).size;
const report = (label, list) => {
  if (list.length < 60) {
    console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 표본 부족`);

    return;
  }

  const xs = list.map((r) => num(r.excess));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 상회 ${String(Math.round((beat / xs.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};
const has = (r, tag) => r.tags.includes(tag);
const chart = (r) => r.bullish && r.broke_today && !r.broke_yesterday
  && num(r.upper_shadow) < 0.3 && num(r.volume_ratio) >= 2 && num(r.day_move) >= 10;

console.log(`표본 ${rows.length}건 · 밤 ${nights}개 · 공시가 있는 기간만`);
console.log(`공시가 붙은 종목-일: ${rows.filter((r) => r.tags.length > 0).length}건\n`);

console.log("[1] 공시 종류별 익일 갭 — 차트 조건 없이");
report("공시 없음", rows.filter((r) => r.tags.length === 0));
for (const tag of ["계약·수주", "주주환원", "인수합병", "설비투자", "실적", "증자·지분", "경영권", "자금거래", "해명", "주의", "정기·안내", "기타"]) {
  report(tag, rows.filter((r) => has(r, tag)));
}

console.log("\n[2] 차트 조건만 vs 차트 + 호재 — 진짜 질문");
const charted = rows.filter(chart);

report("차트 조건 (기존)", charted);
report("  + 공시 아예 없음", charted.filter((r) => r.tags.length === 0));
report("  + 공시 있음 (종류 무관)", charted.filter((r) => r.tags.length > 0));
report("  + 계약·수주", charted.filter((r) => has(r, "계약·수주")));
report("  + 주주환원", charted.filter((r) => has(r, "주주환원")));
report("  + 인수합병", charted.filter((r) => has(r, "인수합병")));
report("  + 증자·지분", charted.filter((r) => has(r, "증자·지분")));
report("  + 주의", charted.filter((r) => has(r, "주의")));

console.log("\n[3] 호재만으로 사면 — 차트 조건 없이 공시만");
const good = (r) => has(r, "계약·수주") || has(r, "주주환원") || has(r, "인수합병") || has(r, "설비투자");

report("호재 공시 (4종)", rows.filter(good));
report("  + 당일 상승", rows.filter((r) => good(r) && num(r.day_move) > 0));
report("  + 당일 5%↑", rows.filter((r) => good(r) && num(r.day_move) >= 5));
report("  + 당일 10%↑", rows.filter((r) => good(r) && num(r.day_move) >= 10));
report("  + 거래량 2배↑", rows.filter((r) => good(r) && num(r.volume_ratio) >= 2));
report("  + 신고점 돌파", rows.filter((r) => good(r) && r.broke_today && !r.broke_yesterday));

process.exit(0);
