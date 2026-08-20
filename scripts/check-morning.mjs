/**
 * 아침 점검용 한 줄 상태.
 *
 *   node scripts/check-morning.mjs us   → 최근 25분 미국 표본 종목 수
 *   node scripts/check-morning.mjs kr   → 오늘 국내 프리마켓·정규장 행수와 첫 틱
 *
 * 감시 스크립트가 컨테이너로 psql을 쏘다가 빈 문자열을 받아 "0건"과 "조회 실패"를
 * 구분하지 못한 적이 있어, 다른 스크립트와 같은 설정으로 물어보게 만들었습니다.
 */

import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

const config = readConfig();
const what = process.argv[2];

async function one(sql) {
  const result = await query(config, sql);

  return result.rows[0] ?? {};
}

if (what === "us") {
  const row = await one(`
    SELECT count(DISTINCT symbol)::int AS symbols
    FROM market_price_samples
    WHERE market = 'US' AND source LIKE 'yahoo:us:%'
      AND observed_at > now() - interval '25 minutes'`);

  console.log(row.symbols ?? 0);
} else if (what === "kr") {
  const row = await one(`
    SELECT
      coalesce(count(*) FILTER (WHERE source LIKE 'kis:nxt%'), 0)::int AS pre_rows,
      coalesce(count(DISTINCT symbol) FILTER (WHERE source LIKE 'kis:nxt%'), 0)::int AS pre_symbols,
      to_char(min(observed_at) FILTER (WHERE source LIKE 'kis:nxt%') AT TIME ZONE 'Asia/Seoul', 'HH24:MI:SS') AS pre_first,
      coalesce(count(*) FILTER (WHERE source LIKE 'kis:krx%'), 0)::int AS krx_rows,
      coalesce(count(DISTINCT symbol) FILTER (WHERE source LIKE 'kis:krx%'), 0)::int AS krx_symbols,
      to_char(min(observed_at) FILTER (WHERE source LIKE 'kis:krx%') AT TIME ZONE 'Asia/Seoul', 'HH24:MI:SS') AS krx_first,
      coalesce(count(DISTINCT observed_at) FILTER (WHERE source LIKE 'kis:krx%'), 0)::int AS krx_ticks
    FROM market_price_samples
    WHERE market = 'KR' AND session_date = (now() AT TIME ZONE 'Asia/Seoul')::date`);
  const flags = await one("SELECT count(*)::int AS n FROM kr_symbol_flags WHERE session_date = (now() AT TIME ZONE 'Asia/Seoul')::date");
  const volume = await one("SELECT count(DISTINCT session_date)::int AS n FROM us_short_volume");

  console.log(JSON.stringify({ ...row, flags: flags.n, shortVolumeSessions: volume.n }));
} else if (what === "pulse") {
  // One line a watchdog can read: how many minutes since anything landed. A
  // collector that has quietly stopped looks exactly like a quiet market until
  // somebody measures the gap.
  const row = await one(`
    SELECT
      round(extract(epoch from now() - max(observed_at) FILTER (WHERE market = 'KR')) / 60)::int AS kr_minutes,
      round(extract(epoch from now() - max(observed_at) FILTER (WHERE market = 'US')) / 60)::int AS us_minutes
    FROM market_price_samples
    WHERE observed_at > now() - interval '12 hours'`);
  const news = await one("SELECT round(extract(epoch from now() - max(observed_at)) / 60)::int AS minutes FROM market_news_items");
  const volume = await one("SELECT count(DISTINCT session_date)::int AS n FROM us_short_volume");

  console.log(JSON.stringify({
    krMinutes: row.kr_minutes,
    newsMinutes: news.minutes,
    shortVolumeSessions: volume.n,
    usMinutes: row.us_minutes
  }));
} else if (what === "us-sources") {
  // Per-source counts for a session summary. It lives here rather than inside
  // the watch script because a node -e nested in a bash function lost its
  // argument to quoting and reported "probe failed" against a healthy
  // collector — an alert that cried wolf is worse than no alert.
  const hours = Number(process.argv[3] ?? 1);
  const result = await query(config, `
    SELECT source, count(*)::int AS rows, count(DISTINCT symbol)::int AS symbols,
           to_char(min(observed_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS first_at,
           to_char(max(observed_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS last_at
    FROM market_price_samples
    WHERE market = 'US' AND observed_at > now() - ($1 || ' hours')::interval
    GROUP BY source
    ORDER BY 2 DESC
  `, [hours]);

  console.log(result.rows
    .map((row) => `${row.source.replace("yahoo:us:", "")} ${row.rows}행/${row.symbols}종목 ${row.first_at}~${row.last_at}`)
    .join(" · ") || "없음");
} else if (what === "program") {
  const row = await one(`
    SELECT count(*)::int AS rows, count(DISTINCT symbol)::int AS symbols,
           min(observed_time) AS first_at, max(observed_time) AS last_at
    FROM kr_program_trade
    WHERE session_date = (now() AT TIME ZONE 'Asia/Seoul')::date`);

  console.log(JSON.stringify({
    firstAt: row.first_at,
    lastAt: row.last_at,
    rows: row.rows,
    symbols: row.symbols
  }));
}

process.exit(0);
