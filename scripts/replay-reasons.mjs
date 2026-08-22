import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { attachLeaderReasons } from "../src/providers/reasons.mjs";

/**
 * The reason engine against the days that actually happened.
 *
 * `test:reasons` is a fixture: every headline in it was chosen because it was
 * hard, so passing says the paths work, not that they fire. This replays the
 * collected sessions instead — the leaders the board really showed, the news
 * that had really been published by then, the filings that had really arrived —
 * and counts how many leaders get an answer at all.
 *
 * Nothing published after the snapshot minute is passed in. A replay that reads
 * the whole day's news would explain the close with headlines written after it.
 *
 * 시장 국면 cannot be replayed: the index level is not in the time series, only
 * the stocks are. Its absence here is not the generator being quiet.
 *
 *   node scripts/replay-reasons.mjs [--days 8] [--leaders 8] [--show]
 */

const config = readConfig();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);

  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const days = flag("days", 8);
const leaderCount = flag("leaders", 8);
const show = args.includes("--show");

const rows = async (sql, params = []) => (await query(config, sql, params)).rows;

/**
 * pg hands back a `date` column as a JS Date at local midnight, so
 * `toISOString()` on it rolls back a day in KST. Every date leaves SQL as text.
 */
const sessions = await rows(`
  SELECT session_date::text AS day, max(observed_at) AS close_at
  FROM market_price_samples
  WHERE market = 'KR' AND source = 'kis:krx' AND leader_rank IS NOT NULL
  GROUP BY 1
  ORDER BY 1 DESC
  LIMIT $1
`, [days]);

if (sessions.length === 0) {
  console.log("국내 정규장 표본이 없습니다. 수집기가 하루라도 돈 뒤에 다시 돌리세요.");
  process.exit(1);
}

const totals = { leaders: 0, paths: new Map(), reasons: 0, withReason: 0 };

for (const session of sessions.reverse()) {
  const { close_at: closeAt, day } = session;
  const leaders = (await rows(`
    SELECT DISTINCT ON (symbol) symbol, name, theme, change_rate, leader_rank
    FROM market_price_samples
    WHERE market = 'KR' AND source = 'kis:krx' AND session_date = $1::date
      AND observed_at = $2 AND leader_rank IS NOT NULL
    ORDER BY symbol, leader_rank
  `, [day, closeAt]))
    .sort((left, right) => left.leader_rank - right.leader_rank)
    .slice(0, leaderCount)
    .map((row) => ({
      caution: "-",
      changeRateValue: Number(row.change_rate),
      market: "KR",
      name: row.name,
      pairTrade: "-",
      peerCount: 0,
      symbol: row.symbol,
      theme: row.theme
    }));

  const headlines = (await rows(`
    SELECT id, label, original_url, published_at, related_symbols, headline
    FROM market_news_items
    WHERE region = 'KR' AND published_at <= $1
      AND published_at >= $1 - interval '18 hours'
    ORDER BY published_at DESC
  `, [closeAt])).map((row) => ({
    id: row.id,
    label: row.label,
    originalUrl: row.original_url,
    publishedAt: row.published_at,
    relatedSymbols: row.related_symbols ?? [],
    text: row.headline
  }));

  const disclosures = (await rows(`
    SELECT action, filed_at, original_url, symbol, title, urgency
    FROM market_disclosures
    WHERE market = 'KR' AND session_date = $1::date AND filed_at <= $2
  `, [day, closeAt])).map((row) => ({
    action: row.action,
    filedAt: row.filed_at,
    originalUrl: row.original_url,
    symbol: row.symbol,
    title: row.title,
    urgency: row.urgency
  }));

  const results = await attachLeaderReasons(config, leaders, {
    disclosures,
    headlines,
    macroSnapshot: [],
    market: "KR"
  });
  const answered = results.filter((result) => (result.reasons ?? []).length > 0);

  totals.leaders += results.length;
  totals.withReason += answered.length;

  console.log(`\n${day}  주도주 ${results.length}  뉴스 ${headlines.length}건  공시 ${disclosures.length}건`);
  console.log(`  이유 있음 ${answered.length}/${results.length}`);

  for (const result of results) {
    const reasons = result.reasons ?? [];

    totals.reasons += reasons.length;

    for (const reason of reasons) {
      totals.paths.set(reason.path, (totals.paths.get(reason.path) ?? 0) + 1);
    }

    if (!show) continue;

    const rate = Number.isFinite(result.changeRateValue) ? `${result.changeRateValue.toFixed(2)}%` : "-";

    console.log(`    ${(result.name ?? result.symbol).padEnd(14)} ${rate.padStart(7)}  ${result.theme ?? ""}`);

    if (reasons.length === 0) {
      console.log("        이유 미확인");
      continue;
    }

    for (const reason of reasons) {
      console.log(`        [${reason.path}/${reason.kind}] ${reason.title} · ${reason.confidence}`);
      for (const line of reason.evidence ?? []) console.log(`            ${line}`);
    }
  }
}

console.log("\n=== 합계 ===");
console.log(`  주도주 ${totals.leaders}  이유 있음 ${totals.withReason} (${Math.round((totals.withReason / totals.leaders) * 100)}%)  이유 ${totals.reasons}개`);

for (const [path, count] of [...totals.paths].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${path.padEnd(10)} ${count}`);
}

process.exit(0);
