import { classifyDisclosure, isMachineHeadline, isReasonHeadline, mentionsBadNews } from "../src/providers/overnight-classify.mjs";
import { isListHeadline } from "../src/providers/close-bet-alert.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 우선주 상한가 다음 날 -- 재료가 있던 것과 없던 것.
 *
 *   node scripts/measure-preferred-material.mjs
 *
 * 2026-11-10 반등장에 11/09 급등 우선주가 갈렸습니다. 재료가 있던 대한항공우(한진칼
 * 지분 경쟁)는 또 상한가, 재료 없이 피난처 돈만 받던 덕성우 −15%·대원전선우 −8%.
 * 사용자 요청으로 이 갈림을 잽니다.
 *
 * 재료는 두 가지로 봅니다:
 *   기사·공시  종가배팅 알림과 같은 거름(close-bet-alert.mjs loadMaterial)으로, 직전 장
 *              마감 15:30부터 **그날 15:20까지**만. 지금 시각까지 보면 뒷날 기사가 섞입니다.
 *              우선주 기사는 대개 보통주 이름으로 나오므로 보통주 코드도 같이 봅니다
 *              (끝자리를 0으로: 003495 → 003490, 18064K → 180640). 08/14 이후만.
 *   보통주 동반  같은 날 보통주가 +10% 이상. 회사·그룹 재료가 있으면 보통주도 움직인다는
 *              가정이고, 일봉이라 전 기간을 덮습니다. 덕성우 11/09는 보통주 −7.84%.
 * 시장 국면(다음 날 전 종목 중앙 ±1%)도 같이 가릅니다(11/10 우선주 국면 측정 이어서).
 */
const config = readConfig();
const commonOf = (symbol) => `${symbol.slice(0, 5)}0`;

const { rows: events } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date d, open::float8 o, high::float8 h, close::float8 c,
           lag(close::float8) OVER w pc, lag(session_date) OVER w pd,
           lead(session_date) OVER w nd, lead(open::float8) OVER w no, lead(close::float8) OVER w nc
      FROM kr_daily_bars WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  mkt AS (SELECT d, percentile_cont(0.5) WITHIN GROUP (ORDER BY c / pc - 1) ret FROM b WHERE o > 0 AND pc > 0 GROUP BY d)
  SELECT p.symbol, p.d::text d, p.pd::text pd, (p.c >= p.h) locked,
         (p.no / p.c - 1) * 100 gap, (p.nc / p.c - 1) * 100 nclose,
         (cm.c / cm.pc - 1) * 100 common_rate, m.ret * 100 mret
    FROM b p
    JOIN mkt m ON m.d = p.nd
    LEFT JOIN b cm ON cm.d = p.d AND cm.symbol = left(p.symbol, 5) || '0'
   WHERE p.symbol ~ '^[0-9]{5}[579KL]$' AND p.c / nullif(p.pc, 0) - 1 >= 0.295
     AND p.no > 0 AND p.nc > 0 AND p.pd IS NOT NULL`);

/* 기사·공시 재료 -- 08/14 이후 사건만. */
async function hasMaterial(event) {
  const symbols = [event.symbol, commonOf(event.symbol)];
  const since = new Date(`${event.pd}T15:30:00+09:00`);
  const until = new Date(`${event.d}T15:20:00+09:00`);
  const { rows: filed } = await query(config, `
    SELECT report_name, title FROM market_disclosures
     WHERE market = 'KR' AND symbol = ANY($1) AND filed_at >= $2 AND filed_at <= $3`, [symbols, since, until]);

  if (filed.some((row) => !String(row.report_name ?? "").startsWith("[기재정정]") && classifyDisclosure(row.report_name, row.title) === "good")) return true;

  const { rows: news } = await query(config, `
    SELECT headline FROM market_news_items, unnest(related_symbols) s
     WHERE region = 'KR' AND s = ANY($1) AND published_at >= $2 AND published_at <= $3`, [symbols, since, until]);

  return news.some((row) => isReasonHeadline(row.headline) && !mentionsBadNews(row.headline)
    && !isMachineHeadline(row.headline) && !isListHeadline(row.headline));
}

for (const event of events) {
  event.news = event.d >= "2026-08-14" ? await hasMaterial(event) : null;
  event.commonUp = event.common_rate == null ? null : Number(event.common_rate) >= 10;
}

const med = (list) => {
  const sorted = [...list].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
};
const f = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

function line(label, set) {
  if (!set.length) return console.log(`${label} | 0`);
  const closes = set.map((row) => Number(row.nclose));

  console.log([
    label, set.length,
    f(med(set.map((row) => Number(row.gap)))),
    f(med(closes)),
    `${Math.round((100 * closes.filter((x) => x >= 29.5).length) / set.length)}%`,
    `${Math.round((100 * closes.filter((x) => x <= -10).length) / set.length)}%`
  ].join(" | "));
}

const header = "구분 | 건수 | 다음 시가 갭 중앙 | 다음 종가 중앙 | 또 상한가 | 종가 −10%↓";
const up = (row) => Number(row.mret) >= 1;

console.log("== 기사·공시 재료 (08/14~, 상한가 전부)");
console.log(header);
const recent = events.filter((row) => row.news !== null);

line("재료 있음", recent.filter((row) => row.news));
line("재료 없음", recent.filter((row) => !row.news));
line("재료 있음 · 다음날 시장 상승", recent.filter((row) => row.news && up(row)));
line("재료 없음 · 다음날 시장 상승", recent.filter((row) => !row.news && up(row)));
line("재료 있음 · 잠김", recent.filter((row) => row.news && row.locked));
line("재료 없음 · 잠김", recent.filter((row) => !row.news && row.locked));

console.log("\n== 보통주 동반 (+10%↑, 전 기간)");
console.log(header);
const priced = events.filter((row) => row.commonUp !== null);

line("보통주도 +10%↑", priced.filter((row) => row.commonUp));
line("우선주만", priced.filter((row) => !row.commonUp));
line("보통주도 · 다음날 시장 상승", priced.filter((row) => row.commonUp && up(row)));
line("우선주만 · 다음날 시장 상승", priced.filter((row) => !row.commonUp && up(row)));
line("보통주도 · 그 외 날", priced.filter((row) => row.commonUp && !up(row)));
line("우선주만 · 그 외 날", priced.filter((row) => !row.commonUp && !up(row)));

console.log("\n두 재료 기준의 겹침 (08/14~):");
const both = recent.filter((row) => row.commonUp !== null);

console.log(`  기사 있음·보통주 동반 ${both.filter((r) => r.news && r.commonUp).length} · 기사 있음·우선주만 ${both.filter((r) => r.news && !r.commonUp).length} · 기사 없음·보통주 동반 ${both.filter((r) => !r.news && r.commonUp).length} · 기사 없음·우선주만 ${both.filter((r) => !r.news && !r.commonUp).length}`);

process.exit(0);
