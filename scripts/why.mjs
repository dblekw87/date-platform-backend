import { describeLockQueue, readLockQueue } from "../src/providers/limit-up-queue.mjs";
import { loadLimitUpEvidence } from "../src/providers/limit-up-evidence.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 이 종목, 지금 들어갈 재료가 있나. 한 줄로 답합니다.
 *
 *   node scripts/why.mjs 나무AX
 *   node scripts/why.mjs 242040
 *   node scripts/why.mjs HLB 2026-09-28
 *
 * **왜 만드는가.** 사용자가 9월 결산에 "기사부터 확인한다, 없으면 안 들어간다"를
 * 적어 놓고 2026-09-28에 또 재료 없는 종목에 들어가 -88,520원을 잃었습니다.
 * 결심이 모자란 게 아니라, 09:18에 호가가 튀는 것을 보면서 그것을 확인할 방법이
 * 없었습니다. 기사를 검색해 읽고 판단하는 데는 몇 분이 걸리고, 그 몇 분이 없어서
 * 그냥 들어갑니다. 그래서 몇 초로 줄입니다.
 *
 * 판정은 알림이 쓰는 것과 **같은 함수**(loadLimitUpEvidence)입니다. 화면과 알림이
 * 다른 기준을 쓰면 "알림은 안 왔는데 화면은 재료 있다고 한다"가 생기고, 그러면
 * 둘 다 안 믿게 됩니다.
 *
 *   direct   그 종목을 지목한 기사      실측 잠김률 46%  ← 가장 셈
 *   filing   그날 공시                  14%(표본 14건, 미해결)
 *   family   계열사 지목                33%
 *   grouped  관련주 묶음 기사           30%   ← 기본 34%보다 낮음. 재료로 안 침
 *   theme    같은 테마 다른 종목 기사   25%
 *   none     아무것도 없음              24%
 *
 * 알림이 보내는 것은 direct·filing·family뿐이고(보냄 43% 대 대기 25%), 여기서도
 * 같게 가릅니다. grouped·theme는 "재료 있음"으로 세지 않습니다 -- 이름이 그럴듯해서
 * 사람을 가장 많이 속이는 칸입니다.
 */
const config = readConfig();
const args = process.argv.slice(2);
const day = args.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const wanted = args.find((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value));

if (!wanted) {
  console.log("종목명이나 코드를 주세요 -- node scripts/why.mjs 나무AX");
  process.exit(1);
}

/*
 * 이름으로 찾습니다. 정확히 같은 이름 -> 앞부분 일치 -> 포함 순.
 *
 * **세 곳을 같이 봅니다.** kr_listings만 보면 2026-09-28에 "나무AX"가 안 잡혔습니다 --
 * 거기에는 정식 상호 `나무에이엑스`로 들어 있고, 화면에 뜨는 약명은 표본 쪽에
 * `나무AX`로 있었습니다(2026-08-23 상호변경, 09-04 한글약명). 사람은 화면에 보이는
 * 이름으로 묻는데 그 이름이 상장 표에 없으면 "못 찾았습니다"가 나오고, 그러면
 * 확인을 포기하고 그냥 들어갑니다 -- 이 스크립트가 막으려던 바로 그 일입니다.
 */
const { rows: found } = await query(config, `
  WITH names AS (
    SELECT symbol, name FROM kr_listings
    UNION
    SELECT symbol, alias AS name FROM kr_symbol_aliases WHERE alias IS NOT NULL
    UNION
    SELECT DISTINCT symbol, name FROM market_price_samples
     WHERE market = 'KR' AND name IS NOT NULL AND session_date >= current_date - 30
  )
  SELECT symbol, min(name) AS name FROM names
   WHERE symbol = $1 OR name = $1 OR name ILIKE $2 OR name ILIKE $3
   GROUP BY symbol
   ORDER BY (symbol = $1) DESC, (min(name) = $1) DESC, (min(name) ILIKE $2) DESC, length(min(name))
   LIMIT 5`, [wanted, `${wanted}%`, `%${wanted}%`]);

if (!found.length) {
  console.log(`'${wanted}' 를 못 찾았습니다.`);
  process.exit(1);
}

const [stock] = found;

if (found.length > 1) {
  console.log(`(여럿 중 첫 번째: ${found.map((row) => `${row.name} ${row.symbol}`).join(" · ")})`);
}

/* 오늘 시세. 없으면 없다고 적습니다 -- 0으로 적으면 안 움직인 것과 구분이 안 됩니다. */
const { rows: quote } = await query(config, `
  SELECT DISTINCT ON (symbol) change_rate::float8 AS rate, turnover::float8, market_cap::float8 AS cap,
         theme, to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
    FROM market_price_samples
   WHERE market = 'KR' AND symbol = $1 AND session_date = $2::date
   ORDER BY symbol, observed_at DESC`, [stock.symbol, day]);
const now = quote[0] ?? null;
const eok = (value) => value === null || value === undefined ? "?" : `${Math.round(value / 1e8).toLocaleString("ko-KR")}억`;

console.log("");
console.log(`${stock.name} (${stock.symbol}) · ${day}`);

if (now) {
  console.log(`  ${now.at} ${now.rate > 0 ? "+" : ""}${now.rate.toFixed(2)}% · 거래대금 ${eok(now.turnover)} · 시총 ${eok(now.cap)} · 테마 ${now.theme ?? "-"}`);
} else {
  console.log("  오늘 장중 표본이 없습니다 (순위권 밖이거나 장 시작 전)");
}

const evidence = await loadLimitUpEvidence(config, {
  name: stock.name,
  symbol: stock.symbol,
  theme: now?.theme ?? null
}, day);

/* 알림과 같은 기준. grouped·theme는 재료로 치지 않습니다. */
const real = ["direct", "family", "filing"].includes(evidence.kind);

console.log("");
console.log(real ? `  ✅ 재료 있음 · ${evidence.kind}` : `  ⛔ 재료 없음 · ${evidence.kind}`);

for (const filing of evidence.filings) {
  console.log(`      공시 ${filing.at} ${(filing.report_name ?? "").slice(0, 60)}`);
}

for (const item of evidence.news) {
  const peer = item.peer_name ?? item.peer;

  console.log(`      ${evidence.kind === "theme" ? `참고(${peer} +${Number(item.move).toFixed(0)}%)` : "뉴스"} ${item.at} ${item.headline.slice(0, 60)}`);
}

for (const caution of evidence.cautions ?? []) console.log(`      주의 ${caution}`);

/*
 * 재료로 안 치는 정정 공시. 실측상 값이 없지만(원본의 1/9) 오늘 펨트론처럼
 * 그 안에 답이 있을 때가 있어, 판단은 사람이 하게 보여만 줍니다.
 */
for (const item of evidence.amended ?? []) {
  console.log(`      참고 ${item.at} ${(item.report_name ?? "").slice(0, 60)}`);
  if (item.original_url) console.log(`           ${item.original_url}`);
}

/* 걸러낸 악재. 이유로는 안 쓰지만 사람은 봐야 합니다. */
for (const bad of evidence.warnings ?? []) {
  console.log(`      ⚠ 악재 ${bad.at} ${bad.headline.slice(0, 60)}`);
}

/*
 * 기사가 움직임보다 먼저였는지. 2026-10-01 LK삼양이 "주가 훨훨" 기사로 재료
 * 판정을 받았는데 그 시각 이미 +22%였습니다. 뒤에 온 기사는 그 움직임의 이유가
 * 아닙니다 -- 실측으로 다음 날 초과가 선행 -0.31%p, 후행 -0.97%p로 갈리고
 * 시가총액 세 칸 모두에서 같은 방향입니다.
 */
/*
 * 상한가로 달혔으면 하룰밤 들고 갈 자리인지도 같이 봅니다. 사용자가 장중매매를
 * 접었으므로 남는 판단이 그것밖에 없습니다. 잔량보다 잔긴 시각이 앞이고, 잔량은
 * 오후에 잔긴 것을 가를 때만 섭니다 -- 실제 수치는 limit-up-queue.mjs에 있습니다.
 */
const lockQueue = describeLockQueue(await readLockQueue(config, stock.symbol, day));

if (lockQueue) {
  console.log("");
  console.log(`  잠김 ${lockQueue}`);
}

const timing = evidence.timing;

if (timing) {
  console.log("");
  console.log(timing.lead
    ? `  ⏱ 선행 · 기사 ${timing.newsAt} → +10% 도달 ${timing.moveAt}`
    : `  ⏱ 후행 · +10% 도달 ${timing.moveAt} → 기사 ${timing.newsAt}  (오른 뒤에 쓴 글입니다)`);
}

console.log("");

if (!real) {
  console.log("  관망입니다. grouped·theme는 기본(34%)보다 낮아 재료로 치지 않습니다.");
} else if (timing && !timing.lead) {
  console.log("  근거가 움직임보다 늦게 왔습니다. 재료라기보다 복기일 수 있습니다.");
  console.log("  실측: 후행 152건 초과 -0.97%p(상회 35%) · 선행 74건 -0.31%p(상회 38%).");
} else {
  console.log("  들어갈 근거는 있습니다. 자리와 손절선은 따로 정하세요.");
}
console.log("");
process.exit(0);
