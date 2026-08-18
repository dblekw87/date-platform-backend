import { query } from "../db/client.mjs";

/**
 * Which themes the board is missing, measured rather than recalled.
 *
 * A theme is not an industry. It is the answer to why a stock rose today, and
 * on 2026-08-18 the top three domestic leaders by turnover were a resort, a
 * rail signalling maker and an apparel brand rising on one remark about the
 * North. Every one classified 미분류, so no group formed and the board showed
 * 반도체. That was found because somebody happened to look at the screen and
 * ask; nothing in the system would have raised it.
 *
 * So the collector writes this at the close of every session. Finding the group
 * is the part a machine can do. Naming it is not - today's candidate list also
 * offered 파두 and 후성, which move with the semiconductor names without
 * belonging to them, and a run that added groups by itself would have been
 * wrong twice before lunch.
 */

const defaults = { minCorrelation: 0.6, minMove: 5, minTicks: 6 };

/**
 * change_rate is cumulative against the previous close, so its level says only
 * that a stock rose and every riser correlates with every other. The signal is
 * in the differences between ticks: two stocks bid up in the same minutes are
 * being traded on one story.
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

function correlation(left, right, minTicks) {
  const pairs = left
    .map((value, index) => [value, right[index]])
    .filter(([first, second]) => first !== null && second !== null);

  if (pairs.length < minTicks - 1) return null;

  const count = pairs.length;
  const meanLeft = pairs.reduce((sum, [first]) => sum + first, 0) / count;
  const meanRight = pairs.reduce((sum, [, second]) => sum + second, 0) / count;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;

  for (const [first, second] of pairs) {
    covariance += (first - meanLeft) * (second - meanRight);
    varianceLeft += (first - meanLeft) ** 2;
    varianceRight += (second - meanRight) ** 2;
  }

  // A stock that hit its limit early is flat for the rest of the session, and
  // flat is not agreement with anything. Unmeasurable rather than a perfect
  // correlation, which is what a zero-variance series would otherwise give.
  if (varianceLeft === 0 || varianceRight === 0) return null;

  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/**
 * Complete linkage: a stock joins only if it agrees with every member already
 * there.
 *
 * Single linkage was tried first and chains. One 0.6 pair is enough to weld two
 * unrelated groups together, and the first run put 대아티아이 and 부산산업 - a
 * real pair - in with 에이직랜드, KR모터스 and a biotech that listed that
 * morning. A theme is a set whose members all move together, so that is the
 * test.
 */
function cluster(symbols, correlations, minCorrelation) {
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

export async function buildThemeCandidates(config, date, options = {}) {
  const { minCorrelation, minMove, minTicks } = { ...defaults, ...options };
  // The evening pass follows the day's names rather than ranking, and its rows
  // would stretch every series four hours past the session being read.
  const samples = await query(config, `
    SELECT symbol, name, theme, observed_at, change_rate, turnover
    FROM market_price_samples
    WHERE session_date = $1 AND market = 'KR' AND change_rate IS NOT NULL
      AND source NOT LIKE '%:after'
    ORDER BY observed_at
  `, [date]);

  if (samples.rows.length === 0) return { candidates: [], date, groups: [], symbols: 0, ticks: 0 };

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

  if (candidates.length < 2) {
    return { candidates, date, groups: [], symbols: bySymbol.size, ticks: ticks.length };
  }

  const incrementsBySymbol = new Map(candidates.map((entry) => [entry.symbol, increments(entry.series, ticks)]));
  const correlations = new Map();

  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const first = candidates[left].symbol;
      const second = candidates[right].symbol;
      const value = correlation(incrementsBySymbol.get(first), incrementsBySymbol.get(second), minTicks);

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
  const groups = cluster(candidates.map((entry) => entry.symbol), correlations, minCorrelation)
    .map((symbols) => {
      const members = symbols.map((symbol) => bySymbol.get(symbol));

      return {
        cohesion: meanCorrelation(symbols, correlations),
        // A headline naming a member is the cheapest hint at what to call the
        // group. Most days there is none, because the policy story that moved
        // them never carries a ticker, and that silence is itself the finding.
        headlines: headlines.rows.filter((row) => members.some((member) => row.headline.includes(member.name))).slice(0, 3),
        members,
        turnover: members.reduce((sum, member) => sum + member.peakTurnover, 0)
      };
    })
    .sort((left, right) => right.turnover - left.turnover);

  return { candidates, date, groups, minCorrelation, minMove, minTicks, symbols: bySymbol.size, ticks: ticks.length };
}

function formatEok(value) {
  return `${Math.round(Number(value) / 100000000).toLocaleString("ko-KR")}억`;
}

export function formatThemeCandidates(report) {
  const lines = [];

  lines.push(`테마 후보 · ${report.date}`);
  lines.push(`  전체 ${report.symbols}종목 · ${report.ticks}틱 · 미분류 급등 ${report.candidates.length}종목`);

  if (report.minMove !== undefined) {
    lines.push(`  기준 ${report.minMove}% 이상 · ${report.minTicks}틱 이상 · 상관 ${report.minCorrelation} 이상`);
  }

  lines.push("");

  if (report.groups.length === 0) {
    lines.push("  같은 틱에 함께 움직인 그룹이 없습니다.");
    lines.push("");

    return lines.join("\n");
  }

  report.groups.forEach((group, index) => {
    const cohesion = group.cohesion === null ? "측정불가" : group.cohesion.toFixed(2);

    lines.push(`  그룹 ${index + 1} · ${group.members.length}종목 · 거래대금 합 ${formatEok(group.turnover)} · 평균 상관 ${cohesion}`);

    for (const member of group.members) {
      lines.push(`    ${member.name.padEnd(16)} ${member.symbol}  ${member.peakMove.toFixed(1).padStart(6)}%  ${formatEok(member.peakTurnover).padStart(9)}`);
    }

    if (group.headlines.length > 0) {
      lines.push("    관련 헤드라인:");
      for (const row of group.headlines) lines.push(`      [${row.label}] ${row.headline.slice(0, 58)}`);
    } else {
      lines.push("    관련 헤드라인 없음 — 종목명이 안 들어간 기사가 움직였을 수 있습니다");
    }

    lines.push("");
  });

  const grouped = new Set(report.groups.flatMap((group) => group.members.map((member) => member.symbol)));
  const alone = report.candidates.filter((entry) => !grouped.has(entry.symbol));

  if (alone.length > 0) {
    lines.push(`  안 묶인 미분류 급등 ${alone.length}종목 (개별 재료이거나 틱이 모자람)`);

    for (const entry of alone.slice(0, 10)) {
      lines.push(`    ${entry.name.padEnd(16)} ${entry.symbol}  ${entry.peakMove.toFixed(1).padStart(6)}%  ${formatEok(entry.peakTurnover).padStart(9)}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
