import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 주도 섹터의 중소형주가 그날 상한가를 가는가 -- 뉴스가 없어도.
 *
 *   node scripts/backtest-leader-sector-smallcap.mjs
 *
 * 사용자 가설 (2026-09-29): "주도 섹터는 대부분 거래대금이 몰린 대형주 위주인데,
 * 그 섹터에 기반한 중소형주들이 그날 상한가를 찍기도 하더라. 뉴스가 없더라도."
 *
 * **앞을 안 보게 짜는 것이 이 측정의 전부입니다.** 하루가 끝난 뒤에 "오늘 주도
 * 섹터는 무엇이었나"를 정하고 그 안에서 상한가를 세면 당연히 많이 나옵니다 --
 * 상한가 간 종목이 섹터를 주도로 만들었으니까요. 그건 측정이 아니라 동어반복입니다.
 *
 * 그래서 두 시점을 자릅니다.
 *
 *   09:30까지의 값으로만  주도 섹터를 정합니다(leader-alert.mjs와 같은 규칙:
 *                         거래대금 100위를 섹터로 묶고, 20조 넘는 종목은 대표에서
 *                         빼고, 보여줄 종목들의 중앙 등락이 양수인 것만).
 *   09:30 이후에만        상한가 도달을 셉니다. 09:30 전에 이미 29.5%였던 종목은
 *                         그 시점에 살 수 없었으므로 빼야 합니다.
 *
 * 뉴스도 같은 자리에서 자릅니다 -- 09:30까지 나온, 그 종목을 지목한 기사만
 * "뉴스 있음"으로 칩니다. 장 마감 후 기사는 그때 몰랐습니다.
 *
 * 비교 대상은 셋입니다. 하나만 보면 반드시 틀립니다.
 *
 *   전체            그날 거래되는 모든 종목 (기본 빈도)
 *   주도 섹터 밖     주도가 아닌 섹터의 종목
 *   주도 섹터 안     가설이 말하는 자리
 */
const config = readConfig();
const cutoff = "09:30";
const limitRate = 29.5;
const poolSize = 100;
const maximumLeadCap = 20e12;
const perSector = 3;
const minMembers = 2;
const showSectors = 3;
const notSectors = new Set(["ETF", "미분류", "개별 이슈", "거래대금 급증", "소형주 급등"]);

/* 09:30까지의 마지막 값과, 그 뒤의 최고 등락. 한 번에 받아 옵니다. */
const { rows } = await query(config, `
  WITH early AS (
    SELECT DISTINCT ON (s.session_date, s.symbol)
           s.session_date, s.symbol, s.name, s.theme,
           s.change_rate::float8 AS early_rate, s.turnover::float8 AS early_turnover,
           s.market_cap::float8 AS cap
      FROM market_price_samples s
     WHERE s.market = 'KR' AND s.source LIKE 'kis:krx%'
       AND (s.observed_at AT TIME ZONE 'Asia/Seoul')::time <= time '${cutoff}'
       AND s.turnover IS NOT NULL
       -- 상장 당일은 전일 종가가 없어 등락률에 비교 대상이 없습니다.
       AND EXISTS (SELECT 1 FROM kr_daily_bars b
                    WHERE b.symbol = s.symbol AND b.session_date < s.session_date)
     ORDER BY s.session_date, s.symbol, s.observed_at DESC
  ),
  later AS (
    SELECT session_date, symbol, max(change_rate)::float8 AS peak_after
      FROM market_price_samples
     WHERE market = 'KR' AND source LIKE 'kis:krx%'
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::time > time '${cutoff}'
     GROUP BY session_date, symbol
  ),
  tagged AS (
    SELECT DISTINCT n.session_date, n.symbol FROM (
      SELECT (published_at AT TIME ZONE 'Asia/Seoul')::date AS session_date, s AS symbol, published_at
        FROM market_news_items, LATERAL unnest(related_symbols) s
       WHERE region = 'KR'
    ) n
     WHERE (n.published_at AT TIME ZONE 'Asia/Seoul')::time <= time '${cutoff}'
  ),
  /* 공시도 같은 자리에서 자릅니다. 장 마감 뒤 접수분은 그때 몰랐습니다.
     [기재정정]은 뺍니다 -- 이미 나온 공시의 오타 수정이 대부분이라 새 사실이
     아닌데 접수 시각은 오늘로 찍힙니다(overnight-classify.mjs와 같은 규칙). */
  filed AS (
    SELECT DISTINCT (filed_at AT TIME ZONE 'Asia/Seoul')::date AS session_date, symbol
      FROM market_disclosures
     WHERE market = 'KR' AND symbol IS NOT NULL
       AND (filed_at AT TIME ZONE 'Asia/Seoul')::time <= time '${cutoff}'
       AND coalesce(report_name, '') NOT LIKE '[기재정정]%'
  )
  SELECT e.session_date::text AS d, e.symbol, e.name, e.theme, e.early_rate,
         e.early_turnover, e.cap, l.peak_after,
         (t.symbol IS NOT NULL) AS had_news,
         (f.symbol IS NOT NULL) AS had_filing
    FROM early e
    LEFT JOIN later l ON l.session_date = e.session_date AND l.symbol = e.symbol
    LEFT JOIN tagged t ON t.session_date = e.session_date AND t.symbol = e.symbol
    LEFT JOIN filed f ON f.session_date = e.session_date AND f.symbol = e.symbol
`);

const byDay = new Map();

for (const row of rows) {
  if (!byDay.has(row.d)) byDay.set(row.d, []);

  byDay.get(row.d).push(row);
}

/* leader-alert.mjs의 bySector와 같은 규칙. 거기를 고치면 여기도 고쳐야 합니다 --
   고르는 쪽과 재는 쪽이 갈리면 측정이 화면을 설명하지 못합니다. */
function leadingSectors(list) {
  const pool = [...list].sort((a, b) => Number(b.early_turnover) - Number(a.early_turnover)).slice(0, poolSize);
  const groups = new Map();

  for (const row of pool) {
    const sector = String(row.theme ?? "").trim();

    if (!sector || notSectors.has(sector)) continue;
    if (!groups.has(sector)) groups.set(sector, []);

    groups.get(sector).push(row);
  }

  return new Set([...groups.entries()]
    .filter(([, members]) => members.length >= minMembers)
    .map(([sector, members]) => {
      const representable = members.filter((member) => !Number.isFinite(Number(member.cap)) || Number(member.cap) < maximumLeadCap);
      const shown = (representable.length > 0 ? representable : members).slice(0, perSector);
      const moves = shown.map((member) => Number(member.early_rate)).filter(Number.isFinite).sort((a, b) => a - b);

      return {
        lead: representable.length > 0 ? Number(representable[0].early_turnover) : 0,
        move: moves.length ? moves[Math.floor(moves.length / 2)] : null,
        sector
      };
    })
    .filter((group) => group.lead > 0 && group.move !== null && group.move > 0)
    .sort((left, right) => right.lead - left.lead)
    .slice(0, showSectors)
    .map((group) => group.sector));
}

const marked = [];

for (const [day, list] of byDay) {
  const leaders = leadingSectors(list);

  for (const row of list) {
    /* 09:30에 이미 상한가면 그 시점에 살 수 없습니다. 모집단에서 뺍니다. */
    if (Number(row.early_rate) >= limitRate) continue;
    if (row.peak_after === null || row.peak_after === undefined) continue;

    marked.push({
      ...row,
      day,
      hit: Number(row.peak_after) >= limitRate,
      inLeader: leaders.has(String(row.theme ?? "").trim())
    });
  }
}

const band = (row) => {
  const cap = Number(row.cap);

  if (!Number.isFinite(cap)) return "시총없음";

  return cap >= 1e12 ? "대형" : cap >= 3000e8 ? "중형" : "소형";
};
const report = (label, list) => {
  if (!list.length) {
    console.log(`  ${label.padEnd(30)}      -`);

    return;
  }

  const hits = list.filter((row) => row.hit).length;

  console.log(`  ${label.padEnd(30)} ${String(list.length).padStart(6)}건 · 상한가 ${String(hits).padStart(3)}건 · ${((100 * hits) / list.length).toFixed(2)}%`);
};

console.log(`\n주도 섹터의 중소형주가 상한가를 가는가 · ${byDay.size}세션`);
console.log(`${cutoff}까지의 값으로 섹터를 정하고, 그 뒤에 ${limitRate}% 도달을 셉니다.`);
console.log(`(${cutoff}에 이미 상한가인 종목은 살 수 없으므로 제외)\n`);

report("전체 (기본 빈도)", marked);
report("주도 섹터 밖", marked.filter((row) => !row.inLeader));
report("주도 섹터 안", marked.filter((row) => row.inLeader));

console.log("\n규모별 · 주도 섹터 안");
for (const size of ["소형", "중형", "대형"]) {
  report(`${size}`, marked.filter((row) => row.inLeader && band(row) === size));
}

console.log("\n규모별 · 주도 섹터 밖 (같은 규모끼리 비교해야 합니다)");
for (const size of ["소형", "중형", "대형"]) {
  report(`${size}`, marked.filter((row) => !row.inLeader && band(row) === size));
}

console.log(`\n뉴스 유무 (${cutoff}까지 그 종목을 지목한 기사)`);
report("주도 섹터 안 · 뉴스 있음", marked.filter((row) => row.inLeader && row.had_news));
report("주도 섹터 안 · 뉴스 없음", marked.filter((row) => row.inLeader && !row.had_news));
report("주도 섹터 밖 · 뉴스 있음", marked.filter((row) => !row.inLeader && row.had_news));
report("주도 섹터 밖 · 뉴스 없음", marked.filter((row) => !row.inLeader && !row.had_news));

console.log(`\n공시 유무 (${cutoff}까지 접수, 기재정정 제외)`);
report("주도 섹터 안 · 공시 있음", marked.filter((row) => row.inLeader && row.had_filing));
report("주도 섹터 안 · 공시 없음", marked.filter((row) => row.inLeader && !row.had_filing));
report("주도 섹터 밖 · 공시 있음", marked.filter((row) => !row.inLeader && row.had_filing));
report("주도 섹터 밖 · 공시 없음", marked.filter((row) => !row.inLeader && !row.had_filing));

/* 재료 = 뉴스든 공시든 하나라도. 사용자가 쓰는 말에 맞춥니다. */
const material = (row) => row.had_news || row.had_filing;

console.log("\n재료(뉴스 또는 공시) 유무");
report("주도 섹터 안 · 재료 있음", marked.filter((row) => row.inLeader && material(row)));
report("주도 섹터 안 · 재료 없음", marked.filter((row) => row.inLeader && !material(row)));
report("주도 섹터 밖 · 재료 있음", marked.filter((row) => !row.inLeader && material(row)));
report("주도 섹터 밖 · 재료 없음", marked.filter((row) => !row.inLeader && !material(row)));

console.log("\n주도 섹터 안 · 소형만");
report("소형 · 뉴스 있음", marked.filter((row) => row.inLeader && band(row) === "소형" && row.had_news));
report("소형 · 뉴스 없음", marked.filter((row) => row.inLeader && band(row) === "소형" && !row.had_news));
report("소형 · 공시 있음", marked.filter((row) => row.inLeader && band(row) === "소형" && row.had_filing));
report("소형 · 재료 있음", marked.filter((row) => row.inLeader && band(row) === "소형" && material(row)));
report("소형 · 재료 없음", marked.filter((row) => row.inLeader && band(row) === "소형" && !material(row)));

/* 실제로 어떤 것들이었는지. 숫자만 보면 무엇을 잡은 건지 모릅니다. */
const hits = marked.filter((row) => row.inLeader && row.hit && band(row) !== "대형");

console.log(`\n주도 섹터 안에서 상한가 간 중소형주 ${hits.length}건`);
for (const row of hits.slice(0, 20)) {
  console.log(`  ${row.day} ${String(row.name).padEnd(14)} ${band(row)} · ${row.theme} · ${cutoff} ${Number(row.early_rate) >= 0 ? "+" : ""}${Number(row.early_rate).toFixed(1)}% · 뉴스 ${row.had_news ? "있음" : "없음"}`);
}

process.exit(0);
