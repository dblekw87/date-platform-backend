import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 사람이 실제로 한 매매를 남깁니다.
 *
 *   node scripts/log-pick.mjs 현대힘스 "한화오션 태국 수주, 조선 섹터 강세, 대장, 호가 강함"
 *   node scripts/log-pick.mjs 460930 "..." --date 2026-09-08
 *   node scripts/log-pick.mjs 393210 "..." --type 상따 --entry 3300 --exit 3346
 *
 * 왜 남기는가. 2026-09-08 현대힘스는 종가배팅 조건(당일 +5%·회전율 5%·60일 신고점)에
 * 한참 못 미쳤는데 -- -0.75%, 20억 -- 사용자는 섹터 재료·대장·호가를 보고 종가에
 * 샀고 다음 날 +4.1% 갭이었습니다. 조건이 못 보는 것을 사람이 보는 사례이고,
 * 그런 사례가 스무 건쯤 쌓여야 "조건에 뭘 더해야 하나"를 물을 수 있습니다.
 * 기억은 맞은 것만 남기므로 틀린 것까지 같은 자리에 적어야 합니다.
 *
 * **종류를 같이 적습니다 (2026-09-23).** 사용자가 하는 매매는 셋이고 진입·청산 자리가
 * 다릅니다 -- 한 자로 재면 두 개가 틀립니다.
 *
 *   종가매매  종가 매수      → 익일 09:05~09:10   next_open으로 채점하는 게 맞음
 *   상따      장중 상한가 부근 → 익일 시가         진입가가 종가가 아님(평단을 적을 것)
 *   장중매매  장중 매수      → 같은 날 장중       익일과 무관, 실현값으로만 채점
 *
 * 종류는 tier에 `사람 · <종류>`로, 평단·청산가는 entry_price·exit_price에 들어갑니다
 * (마이그레이션 038). 모르면 비워 두면 되고, 그때는 예전처럼 종가 기준으로 읽습니다.
 *
 * kind='user_close_bet'으로 kr_signal_outcomes에 들어가고, 채점은 nightly-review.mjs가
 * 다음 거래일 봉으로 합니다. **장중매매는 next_open이 의미 없으니 숫자를 읽을 때
 * 종류로 갈라 보세요** -- 표에는 남지만 그 값으로 평가하면 안 됩니다. 이유는 theme
 * 칼럼에 그대로 적습니다.
 */

const config = readConfig();
const args = process.argv.slice(2);

/** `--이름 값` 꼴을 빼내고 나머지를 자리 인자로 돌려줍니다. */
function takeOptions(list, names) {
  const values = {};
  const rest = [];

  for (let index = 0; index < list.length; index += 1) {
    const name = list[index].startsWith("--") ? list[index].slice(2) : null;

    if (name && names.includes(name)) {
      values[name] = list[index + 1];
      index += 1;
      continue;
    }

    rest.push(list[index]);
  }

  return { rest, values };
}

const { rest: positional, values: options } = takeOptions(args, ["date", "type", "entry", "exit"]);
const day = options.date ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const kinds = ["종가매매", "상따", "장중매매"];
const [who, reason = ""] = positional;

if (!who) {
  console.log("사용법: node scripts/log-pick.mjs <종목명|코드> \"<이유>\" [--date YYYY-MM-DD] [--type 종가매매|상따|장중매매] [--entry 평단] [--exit 청산가]");
  process.exit(1);
}

if (options.type && !kinds.includes(options.type)) {
  console.log(`--type은 ${kinds.join(" | ")} 중 하나여야 합니다. 받은 값: ${options.type}`);
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
const entry = options.entry ? Number(options.entry) : null;
const exit = options.exit ? Number(options.exit) : null;
const result = await query(config, `
  INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate, entry_price, exit_price)
  VALUES ('user_close_bet', $1::date, $2, now(), $3, $4, $5, $6, $7)
  ON CONFLICT (kind, session_date, symbol) DO UPDATE
     SET theme = EXCLUDED.theme, tier = EXCLUDED.tier,
         entry_price = coalesce(EXCLUDED.entry_price, kr_signal_outcomes.entry_price),
         exit_price = coalesce(EXCLUDED.exit_price, kr_signal_outcomes.exit_price)
  RETURNING (xmax = 0) AS inserted`,
  [day, symbol, `사람${options.type ? ` · ${options.type}` : ""}`, reason.slice(0, 200), bar.rows[0]?.rate ?? null, entry, exit]);
const inserted = result.rows[0]?.inserted;
const realized = entry && exit ? ((exit / entry - 1) * 100).toFixed(2) : null;

console.log(`${inserted ? "남겼습니다" : "고쳤습니다"} · ${name} (${symbol}) · ${day}${options.type ? ` · ${options.type}` : ""}`
  + (bar.rows[0] ? ` · 종가 ${bar.rows[0].close.toLocaleString("ko-KR")}원 (${bar.rows[0].rate > 0 ? "+" : ""}${bar.rows[0].rate}%)` : " · 그날 종가 없음(장중이면 15:50 뒤에)")
  + (entry ? `\n  평단 ${entry.toLocaleString("ko-KR")}원` + (exit ? ` → 청산 ${exit.toLocaleString("ko-KR")}원 · 실현 ${realized > 0 ? "+" : ""}${realized}%` : "") : "")
  + (reason ? `\n  이유: ${reason}` : ""));

console.log(options.type === "장중매매"
  ? "장중매매는 당일에 끝나므로 익일 시가 채점은 참고값일 뿐입니다."
  : "채점은 다음 거래일 봉이 들어오면 nightly-review가 합니다.");

process.exit(0);
