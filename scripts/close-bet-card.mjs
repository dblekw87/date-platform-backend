import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅 후보 한 종목씩, 판단에 필요한 것들을 모아서.
 *
 *   npm run kr:close-bet-card            최근 3개 장
 *   npm run kr:close-bet-card -- 10      최근 10개 장
 *
 * 사용자가 실제로 보는 다섯 가지입니다 -- 신고가 · 거래대금 · 정배열 · 주도섹터 ·
 * 재료가 살아있는지. 여기에 기관·외국인 수급을 붙입니다.
 *
 * **거르지 않고 적기만 합니다.** 판단은 사용자가 합니다. 이 다섯 중 둘은 실측에서
 * 값이 없었고(정배열 50만 밤 +0.009%p, 거래대금 단독 +0.068%p) 하나는 소급 측정이
 * 안 되지만(주도섹터, [[theme-dictionary-lag]]), 그건 자동 조건으로 쓰지 말라는
 * 뜻이지 사람이 보지 말라는 뜻이 아닙니다. 조건에 얹는 것과 눈으로 보는 것은
 * 다릅니다 -- 자동 판정은 다섯 번 실패했고 전부 멀쩡한 카드를 부쉈습니다.
 *
 * **수급에는 시차가 있습니다.** kr_investor_flow는 16:10 정산이라 그날치는 종가에
 * 존재하지 않습니다. 그래서 전일까지만 적습니다 -- 15:20에 실제로 볼 수 있었던
 * 값입니다. 당일치는 다음 날 이 카드를 볼 때 채워집니다.
 */

const config = readConfig();
const limit = Number(process.argv.find((word) => /^\d+$/.test(word)) ?? 3);
const eok = (value) => (value === null ? "-" : `${Math.round(Number(value) / 100000000).toLocaleString("ko-KR")}억`);
const pct = (value, digits = 2) =>
  value === null || value === undefined ? "-" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;

const { rows: picks } = await query(config, `
  SELECT o.session_date::text AS d, o.symbol, o.tier, o.entry_rate, o.next_open,
         (SELECT u.name FROM kr_daily_universe u
           WHERE u.symbol = o.symbol ORDER BY u.session_date DESC LIMIT 1) AS name
    FROM kr_signal_outcomes o
   WHERE o.kind = 'close_bet'
     AND o.session_date IN (SELECT DISTINCT session_date FROM kr_signal_outcomes
                             WHERE kind = 'close_bet' ORDER BY session_date DESC LIMIT $1)
   ORDER BY o.session_date DESC, o.entry_rate DESC
`, [limit]);

if (picks.length === 0) {
  console.log("\n기록된 후보가 없습니다.\n");
  process.exit(0);
}

const symbols = [...new Set(picks.map((row) => row.symbol))];
const days = [...new Set(picks.map((row) => row.d))];

/* 차트 — 신고가와 정배열. 창을 넉넉히 잡고 그날 기준으로 자릅니다. */
const { rows: chart } = await query(config, `
  WITH win AS (
    SELECT symbol, session_date, close, volume, open, high, low,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS 4 PRECEDING) AS ma5,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS 9 PRECEDING) AS ma10,
           avg(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS 19 PRECEDING) AS ma20,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING) AS high60,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 250 PRECEDING AND 1 PRECEDING) AS high250,
           lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_close
      FROM kr_daily_bars WHERE symbol = ANY($1::text[])
  )
  SELECT symbol, session_date::text AS d, close, volume, open, high, low,
         ma5, ma10, ma20, high60, high250, prev_close
    FROM win WHERE session_date = ANY($2::date[])
`, [symbols, days]);

const chartOf = new Map(chart.map((row) => [`${row.d}|${row.symbol}`, row]));

/* 시총 — 회전율에 쓰는 주식수 근사. */
const { rows: caps } = await query(config, `
  SELECT DISTINCT ON (symbol) symbol, market_cap, close_price
    FROM kr_daily_universe WHERE symbol = ANY($1::text[]) AND market_cap > 0 AND close_price > 0
   ORDER BY symbol, session_date DESC
`, [symbols]);

const capOf = new Map(caps.map((row) => [row.symbol, row]));

/* 섹터 — 그날 그 테마가 시장보다 얼마나 앞섰나. 회원 수를 같이 적어야 셋짜리
   테마의 평균에 속지 않습니다. */
const { rows: themes } = await query(config, `
  WITH day_move AS (
    SELECT session_date, symbol, change_rate FROM kr_daily_universe
     WHERE session_date = ANY($2::date[]) AND change_rate IS NOT NULL
  ),
  base AS (SELECT session_date, avg(change_rate) AS market FROM day_move GROUP BY session_date),
  theme_move AS (
    SELECT d.session_date, m.theme_name, avg(d.change_rate) - b.market AS excess, count(*) AS members
      FROM day_move d
      JOIN kr_theme_membership m ON m.symbol = d.symbol
      JOIN base b ON b.session_date = d.session_date
     WHERE m.theme_name !~ '(밸류업|기업인수목적|신규상장|리츠|지주사)'
     GROUP BY d.session_date, m.theme_name, b.market
    HAVING count(*) >= 3
  )
  SELECT DISTINCT ON (t.session_date, m.symbol)
         t.session_date::text AS d, m.symbol, t.theme_name, t.excess, t.members
    FROM kr_theme_membership m
    JOIN theme_move t ON t.theme_name = m.theme_name
   WHERE m.symbol = ANY($1::text[])
   ORDER BY t.session_date, m.symbol, t.excess DESC
`, [symbols, days]);

const themeOf = new Map(themes.map((row) => [`${row.d}|${row.symbol}`, row]));

/* 재료 — 뉴스와 공시를 따로 셉니다. 공시는 신고 의무라 사후·정기가 대부분이고,
   뉴스는 소문·업황·정책까지 담습니다. 대리값으로 쓰면 안 됩니다. */
/*
 * 15:20을 기준으로 가릅니다.
 *
 * 이 매매는 15:00~15:20에 재료를 확인하고 종가에 삽니다. 그 뒤에 나온 기사는
 * 판단에 쓸 수 없었던 것이고, 대개 **결과 보도**입니다 -- 실측에서도 기사 시점에
 * 이미 20% 넘게 올라 있었으면 초과가 +0.00%p였습니다. 한 숫자로 뭉치면 "재료가
 * 있었다"가 "장 끝나고 기사가 났다"와 구분되지 않습니다.
 */
/*
 * 같은 기사를 여러 매체가 냅니다. 국내 코퍼스의 14.1%가 그렇고 한 건이 열 번까지
 * 들어옵니다. 세 줄 자리에 같은 문장을 두 번 쓰면 읽을 것이 하나 줄어듭니다.
 * 구두점과 공백을 걷어낸 제목으로 하루 안에서 한 번만 남깁니다.
 */
const { rows: news } = await query(config, `
  WITH one AS (
    SELECT DISTINCT ON ((published_at AT TIME ZONE 'Asia/Seoul')::date,
                        regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'))
           headline, published_at, related_symbols
      FROM market_news_items
     WHERE region = 'KR'
     ORDER BY (published_at AT TIME ZONE 'Asia/Seoul')::date,
              regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'),
              published_at
  )
  SELECT (published_at AT TIME ZONE 'Asia/Seoul')::date::text AS d, s AS symbol,
         count(*) FILTER (WHERE (published_at AT TIME ZONE 'Asia/Seoul')::time <= '15:20') AS before,
         count(*) FILTER (WHERE (published_at AT TIME ZONE 'Asia/Seoul')::time > '15:20') AS after,
         (array_agg(
            to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') || ' ' || headline
            ORDER BY published_at)
           FILTER (WHERE (published_at AT TIME ZONE 'Asia/Seoul')::time <= '15:20')) AS lines
    FROM one, unnest(related_symbols) AS s
   WHERE s = ANY($1::text[]) AND (published_at AT TIME ZONE 'Asia/Seoul')::date = ANY($2::date[])
   GROUP BY 1, 2
`, [symbols, days]);

const newsOf = new Map(news.map((row) => [`${row.d}|${row.symbol}`, row]));

const { rows: filings } = await query(config, `
  SELECT (filed_at AT TIME ZONE 'Asia/Seoul')::date::text AS d, symbol,
         count(*) FILTER (WHERE (filed_at AT TIME ZONE 'Asia/Seoul')::time <= '15:20') AS before,
         count(*) FILTER (WHERE (filed_at AT TIME ZONE 'Asia/Seoul')::time > '15:20') AS after,
         (array_agg(
            to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') || ' ' || title
            ORDER BY filed_at)
           FILTER (WHERE (filed_at AT TIME ZONE 'Asia/Seoul')::time <= '15:20')) AS lines
    FROM market_disclosures
   WHERE symbol = ANY($1::text[]) AND (filed_at AT TIME ZONE 'Asia/Seoul')::date = ANY($2::date[])
   GROUP BY 1, 2
`, [symbols, days]);

const filingOf = new Map(filings.map((row) => [`${row.d}|${row.symbol}`, row]));

/* 수급 — 전일까지. 금액은 백만원 단위로 들어옵니다. */
const { rows: flows } = await query(config, `
  SELECT symbol, session_date::text AS d, institution_amount, foreign_amount
    FROM kr_investor_flow WHERE symbol = ANY($1::text[])
   ORDER BY symbol, session_date
`, [symbols]);

const flowOf = new Map();

for (const row of flows) {
  const list = flowOf.get(row.symbol) ?? [];

  list.push(row);
  flowOf.set(row.symbol, list);
}

/** 그날 **이전** 며칠. 당일치는 16:10 정산이라 종가에는 없습니다. */
function flowBefore(symbol, day, count) {
  return (flowOf.get(symbol) ?? []).filter((row) => row.d < day).slice(-count);
}

const marketGap = new Map();
const { rows: gaps } = await query(config, `
  SELECT session_date::text AS d, avg(open / nullif(prev, 0) - 1) * 100 AS gap
    FROM (SELECT symbol, session_date, open, close, volume,
                 lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
            FROM kr_daily_bars) t
   WHERE prev > 0 AND close * volume >= 500000000
   GROUP BY session_date HAVING count(*) >= 50
`);

for (const row of gaps) marketGap.set(row.d, Number(row.gap));

const sortedGapDays = [...marketGap.keys()].sort();

console.log(`\n종가배팅 후보 기록 · ${days.length}개 장 · ${picks.length}건`);
console.log("거르지 않고 적기만 합니다. 판단은 직접 하시는 것입니다.\n");

let currentDay = null;

for (const pick of picks) {
  if (pick.d !== currentDay) {
    currentDay = pick.d;
    console.log(`${"─".repeat(78)}\n${pick.d}\n`);
  }

  const bar = chartOf.get(`${pick.d}|${pick.symbol}`);
  const cap = capOf.get(pick.symbol);
  const theme = themeOf.get(`${pick.d}|${pick.symbol}`);
  const article = newsOf.get(`${pick.d}|${pick.symbol}`);
  const filing = filingOf.get(`${pick.d}|${pick.symbol}`);
  const flow = flowBefore(pick.symbol, pick.d, 2);

  console.log(`  ${pick.name ?? pick.symbol} (${pick.symbol}) · ${pick.tier} · 당일 ${pct(Number(pick.entry_rate), 1)}`);

  if (bar) {
    const close = Number(bar.close);
    const break60 = bar.high60 ? (close / Number(bar.high60) - 1) * 100 : null;
    const from250 = bar.high250 ? (close / Number(bar.high250) - 1) * 100 : null;
    const isNew250 = from250 !== null && from250 > 0;
    const shares = cap ? Number(cap.market_cap) / Number(cap.close_price) : null;
    const ratio = shares ? Number(bar.volume) / shares * 100 : null;
    const aligned = bar.ma5 && bar.ma10 && bar.ma20
      && Number(bar.ma5) > Number(bar.ma10) && Number(bar.ma10) > Number(bar.ma20);

    console.log(`    신고가   60일 고점 ${pct(break60)} 돌파` +
      (from250 === null ? "" : ` · 250일 고점 대비 ${pct(from250)}${isNew250 ? " (신고가)" : ""}`));
    console.log(`    거래대금 ${eok(close * Number(bar.volume))}` +
      (ratio === null ? "" : ` · 회전율 ${ratio.toFixed(1)}%`));
    console.log(`    정배열   ${aligned ? "○ 5>10>20" : "× 아님"}` +
      (bar.ma5 ? `  (5일 ${Math.round(Number(bar.ma5)).toLocaleString("ko-KR")} · 10일 ${Math.round(Number(bar.ma10)).toLocaleString("ko-KR")} · 20일 ${Math.round(Number(bar.ma20)).toLocaleString("ko-KR")})` : ""));
  }

  console.log(`    주도섹터 ${theme ? `${theme.theme_name} ${pct(Number(theme.excess))}p · 회원 ${theme.members}종목` : "판정할 테마 없음"}`);

  const material = [];

  const late = Number(article?.after ?? 0) + Number(filing?.after ?? 0);

  if (article && Number(article.before) > 0) material.push(`뉴스 ${article.before}건`);
  if (filing && Number(filing.before) > 0) material.push(`공시 ${filing.before}건`);

  console.log(`    재료     ${material.length > 0 ? material.join(" · ") : "15:20까지 없음"}` +
    (late > 0 ? `  [장 끝난 뒤 ${late}건 — 판단에는 못 쓴 것]` : ""));

  /*
   * 헤드라인을 **여러 줄** 적습니다. 한 건만, 그것도 최신 것으로 보여줬더니
   * 2026-09-03 신스틸에서 14:52 드라마 기사가 뜨고 진짜 재료였던
   * "트럼프 알래스카 LNG 파이프라인 발언에 상한가 직행"이 가려졌습니다.
   * 어느 것이 재료인지는 사람이 고르는 편이 낫고, 고르려면 보여야 합니다.
   * 이른 것부터 적는 것은 방아쇠가 대개 앞에 있기 때문입니다.
   */
  for (const line of (article?.lines ?? []).slice(0, 3)) {
    console.log(`             ${String(line).slice(0, 62)}`);
  }

  for (const line of (filing?.lines ?? []).slice(0, 2)) {
    console.log(`             [공시] ${String(line).slice(0, 56)}`);
  }

  if (flow.length > 0) {
    const say = (row) => `${row.d.slice(5)} 기관 ${pct(null) === "-" ? "" : ""}${Math.round(Number(row.institution_amount ?? 0) / 100).toLocaleString("ko-KR")}억` +
      ` 외인 ${Math.round(Number(row.foreign_amount ?? 0) / 100).toLocaleString("ko-KR")}억`;

    console.log(`    수급     ${flow.map(say).join(" / ")}   (전일까지 · 당일치는 16:10 정산)`);
  } else {
    console.log("    수급     기록 없음");
  }

  const open = pick.next_open === null ? null : Number(pick.next_open);
  const entry = bar ? Number(bar.close) : null;
  const gap = open === null || !(entry > 0) ? null : (open / entry - 1) * 100;
  const next = sortedGapDays.find((value) => value > pick.d);
  const market = next ? marketGap.get(next) : null;

  console.log(`    결과     ${gap === null ? "익일 시가 대기" :
    `갭 ${pct(gap)} · 시장 ${pct(market)} · 초과 ${pct(gap - market)}  ${gap > 0 ? "갭상승" : "갭하락"}`}`);
  console.log("");
}

process.exit(0);
