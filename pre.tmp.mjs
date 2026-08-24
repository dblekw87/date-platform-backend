import { readConfig } from "./src/config.mjs";
import { query } from "./src/db/client.mjs";
import { sessionDate } from "./src/providers/market-session.mjs";

const config = readConfig();
const day = sessionDate("KR");
const { rows } = await query(config, `
  SELECT source,
         to_char(min(observed_at) + interval '9 hours','HH24:MI') AS first_kst,
         to_char(max(observed_at) + interval '9 hours','HH24:MI') AS last_kst,
         count(DISTINCT date_trunc('minute', observed_at)) AS mins, count(DISTINCT symbol) AS syms
    FROM market_price_samples WHERE market='KR' AND session_date=$1::date
   GROUP BY 1 ORDER BY 1
`, [day]);

console.log(`오늘(${day}) 국내 수집`);
rows.forEach((r) => console.log(`  ${String(r.source).padEnd(15)} ${r.first_kst}~${r.last_kst}  ${String(r.mins).padStart(3)}분  ${r.syms}종목`));

const tag = await query(config, `
  SELECT count(*) n, count(*) FILTER (WHERE coalesce(array_length(related_symbols,1),0) > 0) AS tagged
    FROM market_news_items WHERE region='KR'
`);

console.log(`\n재시작 전 태깅: ${tag.rows[0].tagged}/${tag.rows[0].n} (${Math.round(tag.rows[0].tagged/tag.rows[0].n*100)}%)`);
process.exit(0);
