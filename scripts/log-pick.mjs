import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 사람이 고른 종가매매 종목을 남깁니다.
 *
 *   node scripts/log-pick.mjs 현대힘스 "한화오션 태국 수주, 조선 섹터 강세, 대장, 호가 강함"
 *   node scripts/log-pick.mjs 460930 "..." --date 2026-09-08
 *
 * 왜 남기는가. 2026-09-08 현대힘스는 종가배팅 조건(당일 +5%·회전율 5%·60일 신고점)에
 * 한참 못 미쳤는데 -- -0.75%, 20억 -- 사용자는 섹터 재료·대장·호가를 보고 종가에
 * 샀고 다음 날 +4.1% 갭이었습니다. 조건이 못 보는 것을 사람이 보는 사례이고,
 * 그런 사례가 스무 건쯤 쌓여야 "조건에 뭘 더해야 하나"를 물을 수 있습니다.
 * 기억은 맞은 것만 남기므로 틀린 것까지 같은 자리에 적어야 합니다.
 *
 * kind='user_close_bet'으로 kr_signal_outcomes에 들어가고, 채점은
 * nightly-review.mjs가 다음 거래일 봉으로 알아서 합니다(next_open·next_close·
 * market_next_open). 이유는 theme 칼럼에 그대로 적습니다 -- 나중에 갈라 볼 때
 * "섹터"·"호가"·"대장" 같은 낱말로 묶습니다.
 */

const config = readConfig();
const args = process.argv.slice(2);
const dateAt = args.indexOf("--date");
const day = dateAt >= 0 ? args[dateAt + 1] : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const positional = args.filter((value, index) => index !== dateAt && index !== dateAt + 1);
const [who, reason = ""] = positional;

if (!who) {
  console.log("사용법: node scripts/log-pick.mjs <종목명|코드> \"<이유>\" [--date YYYY-MM-DD]");
  process.exit(1);
}

const found = await query(config, `
  SELECT DISTINCT ON (symbol) symbol, name FROM kr_daily_universe
   WHERE symbol = $1 OR name = $1
   ORDER BY symbol, session_date DESC LIMIT 1`, [who]);

if (!found.rows.length) {
  console.log(`'${who}'를 유니버스에서 못 찾았습니다. 코드 6자리로 다시 해보세요.`);
  process.exit(1);
}

const { symbol, name } = found.rows[0];

const bar = await query(config, `
  SELECT close_price::float8 AS close, change_rate::float8 AS rate FROM kr_daily_universe
   WHERE symbol = $1 AND session_date = $2::date`, [symbol, day]);

const result = await query(config, `
  INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
  VALUES ('user_close_bet', $1::date, $2, now(), '사람', $3, $4)
  ON CONFLICT (kind, session_date, symbol) DO UPDATE SET theme = EXCLUDED.theme
  RETURNING (xmax = 0) AS inserted`,
  [day, symbol, reason.slice(0, 200), bar.rows[0]?.rate ?? null]);

const inserted = result.rows[0]?.inserted;

console.log(`${inserted ? "남겼습니다" : "이유를 고쳤습니다"} · ${name} (${symbol}) · ${day}`
  + (bar.rows[0] ? ` · 종가 ${bar.rows[0].close.toLocaleString("ko-KR")}원 (${bar.rows[0].rate > 0 ? "+" : ""}${bar.rows[0].rate}%)` : " · 그날 종가 없음(장중이면 15:50 뒤에)")
  + (reason ? `\n  이유: ${reason}` : ""));
console.log("채점은 다음 거래일 봉이 들어오면 nightly-review가 합니다.");

process.exit(0);
