import { readConfig } from "../src/config.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Which themes the board is missing, measured rather than recalled.
 *
 * A theme is not an industry. It is the answer to why a stock rose today, and
 * on 2026-08-18 the top three domestic leaders by turnover were a resort, a
 * rail signalling maker and an apparel brand rising on one remark about the
 * North. Every one classified 미분류, so no group formed and the board showed
 * 반도체. No register can express that group, and naming it from memory is how
 * a wrong code gets in - one candidate on the first pass came back
 * 푸른로보틱스 rather than the intended 푸른기술.
 *
 * The collector now records the minute series, and stocks bid up in the same
 * ticks are visible in it without anyone knowing what to call them. This turns
 * a session into that list, largest unexplained group first.
 *
 * It decides nothing. Thresholds here would be invented, and this project does
 * not invent thresholds before measuring, so they are all options and the
 * reading is left to a person. What it produces is a work list: a group worth
 * naming goes into the curated map in themes.mjs, and the same table is what
 * the clustering work trains on once weeks of it exist.
 *
 *   npm run theme:candidates
 *   npm run theme:candidates -- --date=2026-08-18 --min-move=5 --min-ticks=6
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

const config = readConfig();
const date = readOption("date", sessionDate("KR"));
const minMove = Number(readOption("min-move", "5"));
const minTicks = Number(readOption("min-ticks", "6"));
const minCorrelation = Number(readOption("min-correlation", "0.6"));

/**
 * change_rate is cumulative against the previous close, so its level says only
 * that a stock rose today and every riser correlates with every other. The
 * signal is in the differences between ticks: two stocks bid up in the same
 * minutes are being traded on one story.
 */
function increments(series, ticks) {
  const values = [];

  for (let index = 1; index < ticks.length; index += 1) {
    const previous = series.get(ticks[index - 1]);
    const current = series.get(ticks[index]);

    values.push(previous === undefined || current === undefined ? null : current - previous);
  }

  return values;
}

function correlation(left, right) {
  const pairs = left
    .map((value, index) => [value, right[index]])
    .filter(([a, b]) => a !== null && b !== null);

  if (pairs.length < minTicks - 1) return null;

  const count = pairs.length;
  const meanLeft = pairs.reduce((sum, [a]) => sum + a, 0) / count;
  const meanRight = pairs.reduce((sum, [, b]) => sum + b, 0) / count;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;

  for (const [a, b] of pairs) {
    covariance += (a - meanLeft) * (b - meanRight);
    varianceLeft += (a - meanLeft) ** 2;
    varianceRight += (b - meanRight) ** 2;
  }

  // A stock that hit its limit early is flat for the rest of the session, and
  // flat is not agreement with anything. Reported as unmeasurable rather than
  // as a correlation of one, which is what a zero-variance series would give.
  if (varianceLeft === 0 || varianceRight === 0) return null;

  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/**
 * Complete linkage: a stock joins only if it agrees with every member already
 * there.
 *
 * Single linkage was tried first and chains. One 0.6 pair is enough to weld two
 * unrelated groups together, and the first run put 대아티아이 and 부산산업 - a
 * real pair - in with 에이직랜드, KR모터스 and a newly listed biotech, none of
 * which correlate with each other at all. A theme is a set whose members all
 * move together, so that is what the test has to be.
 */
function cluster(symbols, correlations) {
  const groups = [];

  for (const symbol of symbols) {
    const joined = groups.find((group) =>
      group.every((member) => (correlations.get(`${member}|${symbol}`) ?? -1) >= minCorrelation)
    );

    if (joined) joined.push(symbol);
    else groups.push([symbol]);
  }

  return groups.filter((group) => group.length >= 2);
}

/** How tightly a group actually holds together, for judging the threshold. */
function meanCorrelation(symbols, correlations) {
  const values = [];

  for (let left = 0; left < symbols.length; left += 1) {
    for (let right = left + 1; right < symbols.length; right += 1) {
      const value = correlations.get(`${symbols[left]}|${symbols[right]}`);

      if (value !== undefined) values.push(value);
    }
  }

  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatEok(value) {
  return `${Math.round(Number(value) / 100000000).toLocaleString("ko-KR")}억`;
}

const samples = await query(config, `
  SELECT symbol, name, theme, observed_at, change_rate, turnover
  FROM market_price_samples
  WHERE session_date = $1 AND market = 'KR' AND change_rate IS NOT NULL
  ORDER BY observed_at
`, [date]);

if (samples.rows.length === 0) {
  console.log(`\n${date} 시세 표본이 없습니다.\n`);
  process.exit(0);
}

const bySymbol = new Map();

for (const row of samples.rows) {
  const entry = bySymbol.get(row.symbol) ?? {
    name: row.name ?? row.symbol,
    peakMove: -Infinity,
    peakTurnover: 0,
    series: new Map(),
    symbol: row.symbol,
    theme: row.theme
  };

  entry.series.set(row.observed_at.getTime(), Number(row.change_rate));
  entry.peakMove = Math.max(entry.peakMove, Number(row.change_rate));
  entry.peakTurnover = Math.max(entry.peakTurnover, Number(row.turnover ?? 0));
  bySymbol.set(row.symbol, entry);
}

const ticks = [...new Set(samples.rows.map((row) => row.observed_at.getTime()))].sort((left, right) => left - right);
// Only the unclassified ones: a group the board already names is not a gap.
const candidates = [...bySymbol.values()]
  .filter((entry) => entry.theme === "미분류" || entry.theme === null)
  .filter((entry) => entry.peakMove >= minMove && entry.series.size >= minTicks)
  .sort((left, right) => right.peakTurnover - left.peakTurnover);

console.log(`\n테마 후보 · ${date}`);
console.log(`  전체 ${bySymbol.size}종목 · ${ticks.length}틱 · 미분류 급등 ${candidates.length}종목`);
console.log(`  기준 ${minMove}% 이상 · ${minTicks}틱 이상 · 상관 ${minCorrelation} 이상 (모두 --옵션으로 조정)\n`);

if (candidates.length < 2) {
  console.log("  묶을 후보가 부족합니다.\n");
  process.exit(0);
}

const incrementsBySymbol = new Map(candidates.map((entry) => [entry.symbol, increments(entry.series, ticks)]));
const correlations = new Map();

for (let left = 0; left < candidates.length; left += 1) {
  for (let right = left + 1; right < candidates.length; right += 1) {
    const first = candidates[left].symbol;
    const second = candidates[right].symbol;
    const value = correlation(incrementsBySymbol.get(first), incrementsBySymbol.get(second));

    if (value !== null) {
      correlations.set(`${first}|${second}`, value);
      correlations.set(`${second}|${first}`, value);
    }
  }
}

const headlines = await query(config, `
  SELECT headline, label
  FROM market_news_items
  WHERE region = 'KR' AND published_at >= $1::date AND published_at < $1::date + 1
`, [date]);

const groups = cluster(candidates.map((entry) => entry.symbol), correlations)
  .map((symbols) => {
    const members = symbols.map((symbol) => bySymbol.get(symbol));

    return {
      cohesion: meanCorrelation(symbols, correlations),
      members,
      turnover: members.reduce((sum, member) => sum + member.peakTurnover, 0)
    };
  })
  .sort((left, right) => right.turnover - left.turnover);

if (groups.length === 0) {
  console.log("  같은 틱에 함께 움직인 그룹이 없습니다. 개별 재료로 오른 종목들입니다.\n");
}

groups.forEach((group, index) => {
  const cohesion = group.cohesion === null ? "측정불가" : group.cohesion.toFixed(2);

  console.log(`  그룹 ${index + 1} · ${group.members.length}종목 · 거래대금 합 ${formatEok(group.turnover)} · 평균 상관 ${cohesion}`);

  for (const member of group.members) {
    console.log(`    ${member.name.padEnd(16)} ${member.symbol}  ${member.peakMove.toFixed(1).padStart(6)}%  ${formatEok(member.peakTurnover).padStart(9)}`);
  }

  // A headline naming a member is the cheapest hint at what the group should be
  // called. Most days there is none, because the policy story that moved them
  // never carries a ticker, and that silence is itself the finding.
  const matched = headlines.rows.filter((row) => group.members.some((member) => row.headline.includes(member.name)));

  if (matched.length > 0) {
    console.log("    관련 헤드라인:");
    for (const row of matched.slice(0, 3)) console.log(`      [${row.label}] ${row.headline.slice(0, 58)}`);
  } else {
    console.log("    관련 헤드라인 없음 — 종목명이 안 들어간 기사가 움직였을 수 있습니다");
  }

  console.log("");
});

const grouped = new Set(groups.flatMap((group) => group.members.map((member) => member.symbol)));
const alone = candidates.filter((entry) => !grouped.has(entry.symbol));

if (alone.length > 0) {
  console.log(`  안 묶인 미분류 급등 ${alone.length}종목 (개별 재료이거나 틱이 모자람)`);

  for (const entry of alone.slice(0, 10)) {
    console.log(`    ${entry.name.padEnd(16)} ${entry.symbol}  ${entry.peakMove.toFixed(1).padStart(6)}%  ${formatEok(entry.peakTurnover).padStart(9)}`);
  }

  console.log("");
}

process.exit(0);
