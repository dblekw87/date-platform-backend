import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 사용자가 알려준 상따 호가 노하우 두 가지 (2026-09-23).
 *
 *   1) 매수 잔량 체크   상한가 매수 잔량이 주식수의 일정 비율(5% 등) 이상인가
 *   2) 잔량 이탈 감시   대량 매수세가 갑자기 취소되는가(허수 잔량)
 *
 * **유통주식수가 없어 상장주식수(시총/현재가)로 잽니다.** 유통은 그보다 적으니
 * 여기 비율은 실제보다 작게 나옵니다 -- 5%라는 숫자를 그대로 옮기면 안 되고 분포로 자릅니다.
 *
 * **2번은 앞을 보는 방식이어야 합니다.** 처음엔 "잠긴 동안 고점 대비 최대 감소"로 쟀는데,
 * 오래 잠긴 종목일수록 표본이 많아 감소폭이 커 보이는 착시였습니다(50%+ 이탈 74% 유지 vs
 * 0~5% 이탈 0% 유지라는 뒤집힌 결과). 그래서 **매 분 시점에서 직전 3분 감소율**을 재고
 * 그 뒤를 봅니다. 사람이 호가창을 보며 내리는 판단과 같은 모양입니다.
 *
 * **결과를 두 가지로 셉니다.** 사용자가 지적한 것이고, 답이 갈립니다 --
 * "잔량 이탈 후 다시 상한가로 잠기는 종목도 많다":
 *
 *              표본    10분 내 풀림   그날 종가에 안 잠김
 *   0~2% 감소  3,002분      1%              7%
 *   2~5%         384분      2%             11%
 *   5~10%        240분      3%             16%
 *   10~20%       174분      8%             15%
 *   20%+         137분     16%             21%
 *
 * 잠깐 풀리는 것은 16배로 갈리는데 **그날 끝까지 잠기는가는 7%→21%, 세 배에 그칩니다.**
 * 풀렸다 다시 잠기면 결과는 같은 자리이고, 20%+ 빠져도 **79%는 종가까지 잠깁니다.**
 * 10~20%(15%)가 5~10%(16%)보다 낮아 단조도 아닙니다. 그래서 2026-09-23에 알림을
 * 만들려다 **접었습니다** -- 하루 2~4통을 보낼 값이 아닙니다.
 *
 * 2026-09-15부터 7세션·잠긴 종목-일 58건뿐이라, 몇 주 더 쌓은 뒤 다시 돌려 보세요:
 *   node scripts/measure-order-book.mjs
 */
const config = readConfig();
const kst = (value) => new Date(value.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

const { rows } = await query(config, `
  SELECT b.symbol, b.session_date, b.observed_at,
         b.change_rate::float8 AS rate, b.price::float8 AS price,
         b.total_bid_qty::float8 AS bid_total, b.total_ask_qty::float8 AS ask_total,
         (SELECT max(p.market_cap)::float8 FROM market_price_samples p
           WHERE p.symbol = b.symbol AND p.session_date = b.session_date) AS cap,
         (SELECT u.change_rate::float8 FROM kr_daily_universe u
           WHERE u.symbol = b.symbol AND u.session_date = b.session_date) AS close_rate,
         (SELECT u.name FROM kr_daily_universe u
           WHERE u.symbol = b.symbol AND u.session_date = b.session_date) AS name
    FROM kr_order_book_samples b
   ORDER BY b.symbol, b.session_date, b.observed_at`);

const days = new Map();

for (const row of rows) {
  if (!(row.cap > 0) || !(row.price > 0) || row.close_rate === null) continue;

  const key = `${row.symbol}|${kst(row.session_date)}`;

  if (!days.has(key)) {
    days.set(key, {
      closeRate: Number(row.close_rate), day: kst(row.session_date),
      name: row.name, samples: [], shares: Number(row.cap) / Number(row.price), symbol: row.symbol
    });
  }

  days.get(key).samples.push(row);
}

const locked = [];
const bad = [];

for (const day of days.values()) {
  const lockedSamples = day.samples.filter((row) => Number(row.ask_total) === 0 && Number(row.rate) >= 29.4);

  if (!lockedSamples.length) continue;

  const ratio = 100 * Number(lockedSamples[0].bid_total) / day.shares;

  // 잔량이 상장주식수를 넘는 것은 데이터가 틀린 것입니다(앤씨앤 9/17: 잔량 7,464만주,
  // 그날 거래량 5만주, 상장 502만주). 세지 않고 따로 셉니다.
  if (!(ratio >= 0) || ratio > 100) { bad.push({ ...day, ratio }); continue; }

  locked.push({ ...day, firstRatio: ratio, held: day.closeRate >= 29.5, lockedSamples });
}

const line = (label, list) => console.log(`  ${label.padEnd(24)} ${String(list.length).padStart(3)}건 · 종가까지 유지 ${String(list.filter((row) => row.held).length).padStart(3)} · ${list.length ? `${Math.round(100 * list.filter((row) => row.held).length / list.length)}%` : "-"}`);

console.log(`호가 표본 있는 종목-일 ${days.size} · 잠긴 적 있는 것 ${locked.length + bad.length}건 (그중 데이터 이상 ${bad.length}건 제외)`);
console.log("2026-09-15~, 상장주식수 기준\n");

console.log("1) 잠긴 직후 매수 잔량 / 상장주식수");
line("전체", locked);
for (const [low, high] of [[0, 0.5], [0.5, 1], [1, 2], [2, 4], [4, 100]]) {
  line(`  ${low}~${high === 100 ? "+" : high}%`, locked.filter((row) => row.firstRatio >= low && row.firstRatio < high));
}

/*
 * 2) 잔량 이탈 -- 매 분이 하나의 판단 자리입니다.
 *    직전 3분 감소율을 보고, 그 뒤 10분 안에 풀렸는지를 셉니다.
 */
const buckets = new Map();

for (const row of locked) {
  const list = row.lockedSamples;
  const all = row.samples;

  for (let index = 3; index < list.length; index += 1) {
    const now = Number(list[index].bid_total);
    const before = Number(list[index - 3].bid_total);

    if (!(before > 0)) continue;

    const drop = 100 * (before - now) / before;
    const at = new Date(list[index].observed_at).getTime();
    // 이 시점 뒤 10분 안에 매도 잔량이 살아났으면 = 풀린 것.
    const unlocked = all.some((sample) => {
      const time = new Date(sample.observed_at).getTime();

      return time > at && time <= at + 10 * 60_000 && Number(sample.ask_total) > 0;
    });
    const label = drop < 2 ? "0~2" : drop < 5 ? "2~5" : drop < 10 ? "5~10" : drop < 20 ? "10~20" : "20+";

    if (!buckets.has(label)) buckets.set(label, { n: 0, unlocked: 0, notHeld: 0 });

    const bucket = buckets.get(label);

    bucket.n += 1;
    if (unlocked) bucket.unlocked += 1;
    // 사용자 지적: 풀렸다 다시 잠기면 같은 자리다. 그날 끝까지 잠겼는지가 돈이 걸린 쪽.
    if (!row.held) bucket.notHeld += 1;
  }
}

console.log("\n2) 직전 3분 매수 잔량 감소 → 그 뒤 10분 안에 풀림");
for (const label of ["0~2", "2~5", "5~10", "10~20", "20+"]) {
  const bucket = buckets.get(label);

  if (!bucket) continue;

  console.log(`  ${label.padStart(6)}% 감소 · ${String(bucket.n).padStart(4)}분`
    + ` · 10분 내 풀림 ${String(Math.round(100 * bucket.unlocked / bucket.n)).padStart(3)}%`
    + ` · 그날 종가에 안 잠김 ${String(Math.round(100 * bucket.notHeld / bucket.n)).padStart(3)}%`);
}

console.log("\n데이터 이상으로 뺀 것");
for (const row of bad) console.log(`  ${row.day} ${String(row.name ?? row.symbol).padEnd(12)} 잔량/주식수 ${row.ratio.toFixed(0)}%`);

console.log("\n풀린 사례");
for (const row of locked.filter((item) => !item.held).sort((left, right) => left.firstRatio - right.firstRatio).slice(0, 10)) {
  console.log(`  ${row.day} ${String(row.name ?? row.symbol).padEnd(12)} 잠김 직후 잔량비 ${row.firstRatio.toFixed(2)}% · 종가 ${row.closeRate}%`);
}

process.exit(0);
