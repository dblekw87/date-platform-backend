import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { classifyHeadline, classifyDisclosure } from "../src/providers/overnight-classify.mjs";
import { storyTokens } from "../src/providers/overnight-collect.mjs";

/**
 * 장 마감 뒤에 나온 재료가 다음 장에서 돈이 되는가.
 *
 * 주말 뉴스로 월요일 종목을 고르려면 먼저 답해야 하는 질문입니다. 헤드라인은
 * 두 종류가 섞여 있습니다 -- **직전 장에서 오른 것을 복기하는 기사**와 **장이
 * 닫힌 뒤에 처음 나온 사실**. 앞의 것은 이미 가격에 있고 뒤의 것만 아직
 * 거래되지 않았습니다. 이 구분이 실제로 수익률을 가르는지 재는 스크립트입니다.
 *
 * 재는 방법은 [[pullback-verdict]]에서 배운 대로 **초과수익**입니다. 그날
 * 시장 전체가 오르면 아무거나 사도 오르므로, 같은 날 같은 모집단의 평균을 빼야
 * 조건 자체의 값을 봅니다.
 *
 * 수익률은 셋으로 나눕니다. 재료는 보통 시초가에 반영되므로 갭과 장중을 합쳐
 * 보면 무엇을 먹었는지 알 수 없습니다.
 *
 *   gap       전일 종가 → 시가    남이 먼저 먹는 부분
 *   intraday  시가 → 종가        09:00에 사서 종가에 팔면 먹는 부분
 *   total     전일 종가 → 종가
 *
 *   node scripts/measure-overnight-news.mjs
 */

const config = readConfig();

// 유동성 바닥. 거래대금이 이보다 적으면 살 수 없는 값이 찍히므로 모집단에서
// 뺍니다. [[leader-pool-filters]] -- 판단 조건이 아니라 모집단 조건입니다.
const minTurnover = 1_000_000_000;

const sessions = (await query(config, `
  SELECT DISTINCT session_date::text AS d FROM kr_daily_bars
  WHERE session_date >= '2026-08-14' ORDER BY 1`)).rows.map((r) => r.d);

const bars = (await query(config, `
  SELECT b.session_date::text AS d, b.symbol, b.open::float8, b.close::float8,
         u.name, u.turnover::float8, u.market_cap::float8
    FROM kr_daily_bars b
    LEFT JOIN kr_daily_universe u ON u.symbol = b.symbol AND u.session_date = b.session_date
   WHERE b.session_date >= '2026-08-14' AND b.open > 0 AND b.close > 0`)).rows;

const byDay = new Map();

for (const row of bars) {
  if (!byDay.has(row.d)) byDay.set(row.d, new Map());
  byDay.get(row.d).set(row.symbol, row);
}

const news = (await query(config, `
  SELECT s AS symbol, published_at, headline, source
    FROM market_news_items, LATERAL unnest(related_symbols) s
   WHERE region = 'KR' AND published_at >= '2026-08-18'`)).rows;

const filings = (await query(config, `
  SELECT symbol, filed_at, report_name, title
    FROM market_disclosures
   WHERE market = 'KR' AND symbol IS NOT NULL AND filed_at >= '2026-08-18'`)).rows;

/* 창은 직전 장 마감(15:40)부터 당일 개장 직전(08:50)까지입니다. 08:50을 끝으로
 * 두는 것은 NXT 프리마켓이 그때 멈추기 때문이고, 그 뒤에 나온 기사는 우리가
 * 09:00에 주문을 낼 때 아직 못 봤을 수 있습니다. */
function windowFor(day) {
  const index = sessions.indexOf(day);

  if (index < 1) return null;

  return {
    from: new Date(`${sessions[index - 1]}T15:40:00+09:00`),
    to: new Date(`${day}T08:50:00+09:00`),
    previous: sessions[index - 1],
    /* 직전 장이 열려 있던 동안. 그 사이에 이미 기사가 돌던 종목은, 마감 뒤에
     * 나온 기사가 새 사실이 아니라 낮에 하던 얘기의 연장일 수 있습니다. */
    sessionFrom: new Date(`${sessions[index - 1]}T09:00:00+09:00`),
    sessionTo: new Date(`${sessions[index - 1]}T15:40:00+09:00`)
  };
}

const buckets = new Map();

function record(name, day, symbol, gap, intraday, total) {
  if (!buckets.has(name)) buckets.set(name, []);
  buckets.get(name).push({ day, symbol, gap, intraday, total });
}

const marketByDay = new Map();

for (const day of sessions) {
  const today = byDay.get(day);
  const window = windowFor(day);

  if (!window) continue;

  const yesterday = byDay.get(window.previous);
  const population = [];

  for (const [symbol, bar] of today) {
    const before = yesterday?.get(symbol);

    if (!before || !before.close || !bar.open || !bar.close) continue;
    if (!(before.turnover >= minTurnover)) continue;

    population.push({
      symbol,
      name: bar.name,
      gap: (bar.open / before.close - 1) * 100,
      intraday: (bar.close / bar.open - 1) * 100,
      total: (bar.close / before.close - 1) * 100
    });
  }

  if (population.length < 100) continue;

  const mean = (key) => population.reduce((sum, row) => sum + row[key], 0) / population.length;
  const market = { gap: mean("gap"), intraday: mean("intraday"), total: mean("total") };

  marketByDay.set(day, { market, size: population.length });

  const tags = new Map();
  const tag = (symbol, label) => {
    if (!tags.has(symbol)) tags.set(symbol, new Set());
    tags.get(symbol).add(label);
  };

  /* 분류된 것만 세면 대조군이 틀립니다. 공시가 **났다는 사실 자체**가 이미
   * 움직이는 종목을 고르는 조건이라, 좋은 공시의 값을 보려면 나쁜 공시가 아니라
   * 공시 전체와 견줘야 합니다. 뉴스도 같습니다. [[us-short-volume-verdict]]에서
   * 수준이 아니라 기준선 대비 변화만 살아남은 것과 같은 자리입니다. */
  /* 낮에 다뤄졌는가를 낱말로 봅니다 -- 고르는 쪽(overnight-rank.mjs)과 같은 규칙.
   * 종목 단위 참/거짓이었을 때 64 대 65로 갈렸는데, 같은 종목이라도 다른 얘기면
   * "처음"으로 치는 규칙이 되었으니 잰 것도 그 규칙이어야 합니다. */
  const coveredTokens = new Map();
  const nightMaterial = new Map();

  for (const item of news) {
    if (item.published_at >= window.sessionFrom && item.published_at < window.sessionTo) {
      if (!coveredTokens.has(item.symbol)) coveredTokens.set(item.symbol, new Set());
      for (const token of storyTokens(item.headline)) coveredTokens.get(item.symbol).add(token);
    }

    if (item.published_at >= window.from && item.published_at < window.to && classifyHeadline(item.headline) === "material") {
      if (!nightMaterial.has(item.symbol)) nightMaterial.set(item.symbol, []);
      nightMaterial.get(item.symbol).push(item.headline);
    }
  }

  const isNewStory = (symbol) => {
    const day = coveredTokens.get(symbol);

    if (!day || !day.size) return true;

    return (nightMaterial.get(symbol) ?? []).some((headline) => {
      const shared = [...storyTokens(headline)].filter((token) => day.has(token)).length;

      return shared < 2;
    });
  };

  for (const item of news) {
    if (item.published_at < window.from || item.published_at >= window.to) continue;

    tag(item.symbol, "뉴스 있음(대조군)");

    const kind = classifyHeadline(item.headline);

    if (kind) tag(item.symbol, `news:${kind}`);
  }

  for (const item of filings) {
    if (item.filed_at < window.from || item.filed_at >= window.to) continue;

    tag(item.symbol, "공시 있음(대조군)");

    const kind = classifyDisclosure(item.report_name, item.title);

    if (kind) tag(item.symbol, `filing:${kind}`);
  }

  for (const row of population) {
    const labels = tags.get(row.symbol);
    const excess = {
      gap: row.gap - market.gap,
      intraday: row.intraday - market.intraday,
      total: row.total - market.total
    };

    record("전체(대조군)", day, row.symbol, excess.gap, excess.intraday, excess.total);

    if (!labels) continue;

    for (const label of labels) record(label, day, row.symbol, excess.gap, excess.intraday, excess.total);

    if (labels.has("news:material") && !labels.has("news:recap")) {
      record("news:material만(복기 없음)", day, row.symbol, excess.gap, excess.intraday, excess.total);
    }

    if (labels.has("news:material") && labels.has("filing:good")) {
      record("재료+호재공시 겹침", day, row.symbol, excess.gap, excess.intraday, excess.total);
    }

    if (labels.has("filing:good") && !labels.has("news:recap")) {
      record("호재공시·복기없음", day, row.symbol, excess.gap, excess.intraday, excess.total);
    }

    /*
     * 낮에 이미 다뤄진 종목인가.
     *
     * 재료가 아직 거래되지 않은 것을 찾는 자리이므로, 직전 장중에 이미 기사가
     * 돌던 종목은 그만큼 덜 새롭습니다. 2026-09-06 주말 후보 18종목 중 11종목이
     * 여기 해당했습니다 -- 그 구분이 값을 갖는지 재는 줄입니다.
     */
    const first = isNewStory(row.symbol) ? "처음" : "이어진";

    if (labels.has("news:material") && !labels.has("news:recap")) {
      record(`재료·${first} 나온 것`, day, row.symbol, excess.gap, excess.intraday, excess.total);
    }

    if (labels.has("filing:good") && !labels.has("news:recap")) {
      record(`호재공시·${first} 나온 것`, day, row.symbol, excess.gap, excess.intraday, excess.total);
    }
  }
}

console.log(`\n장 마감 후 재료 → 다음 장 초과수익 (시장 평균 대비, %p)\n`);
console.log(`세션 ${marketByDay.size}개 · 유동성 바닥 거래대금 ${(minTurnover / 1e8).toFixed(0)}억\n`);
console.log("조건                          N     갭    장중     전체   장중승률");

const order = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);

for (const [name, rows] of order) {
  if (rows.length < 12) continue;

  const avg = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const wins = rows.filter((row) => row.intraday > 0).length;

  console.log(
    name.padEnd(28),
    String(rows.length).padStart(5),
    avg("gap").toFixed(2).padStart(6),
    avg("intraday").toFixed(2).padStart(6),
    avg("total").toFixed(2).padStart(7),
    `${((wins / rows.length) * 100).toFixed(0)}%`.padStart(8)
  );
}

/* 평균 하나로는 하루가 만든 값인지 알 수 없습니다. 10세션짜리 표본에서는 특히
 * 그렇습니다 -- 세션별로 갈라 보고 부호가 뒤집히는지부터 봅니다. */
console.log("");
console.log("세션별 장중 초과수익 (%p)");
console.log("");

const watched = ["공시 있음(대조군)", "filing:good", "news:recap", "news:material만(복기 없음)", "재료·처음 나온 것", "재료·이어진 나온 것", "호재공시·처음 나온 것", "호재공시·이어진 나온 것"];
const days = [...marketByDay.keys()].sort();

console.log("조건".padEnd(24) + days.map((d) => d.slice(5).padStart(7)).join(""));

for (const name of watched) {
  const rows = buckets.get(name) ?? [];
  const cells = days.map((day) => {
    const slice = rows.filter((row) => row.day === day);

    if (!slice.length) return "     ·";

    return (slice.reduce((sum, row) => sum + row.intraday, 0) / slice.length).toFixed(1).padStart(7);
  });

  console.log(name.padEnd(24) + cells.join(""));
}

process.exit(0);
