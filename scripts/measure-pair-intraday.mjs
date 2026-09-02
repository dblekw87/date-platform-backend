import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 짝꿍매매를 **장중 구간**으로 잽니다.
 *
 *   node scripts/measure-pair-intraday.mjs
 *
 * 지금까지 잰 것은 전부 종가에 사서 익일 시가에 판 값입니다(밀착 612건 +5.55%p·상회
 * 76%, [[pair-trade-verdict-kr]]). 그런데 실제 매매는 장중에 들어가 장중에 나옵니다.
 * 두 값이 같으리라고 볼 근거가 없고, 오히려 반대일 이유가 있습니다 -- 화면은 간격이
 * 좁은 `밀착`을 최고로 표시하는데 장중에 간격이 좁다는 건 "이미 다 갔다"는 뜻입니다.
 *
 * 2026-08-27 유디엠텍 → 라온피플이 그 차이를 그대로 보여줬습니다.
 *
 *   12:33  1등주 +29.96% 잠김 · 2등주 +16.12%   간격 13.84%p  ← 진입 자리
 *   13:14                        +28.97%        0.99%p
 *   13:24                        +17.29%       12.67%p  ← 10분 만에 되돌림
 *   15:20                        +29.91%        0.05%p  ← 마감 10분 전 상한가
 *
 * **사후 재구성이 아닙니다.** kr_signal_outcomes에 그날 실제로 발동한 신호가
 * detected_at과 함께 남아 있습니다(nightly-review.mjs가 씁니다). 진입 시각도
 * 진입 가격도 그때 화면이 말한 그대로이고, 여기서 조건을 다시 쓰지 않습니다.
 * 조건을 다시 쓰면 화면에 뜬 것과 채점된 것이 달라져 아무 말도 못 하게 됩니다.
 *
 * **대조군은 "그 시각에 오르고 있던 다른 종목"입니다.** 초과분을 지수 대비로 재면
 * 이 매매에 대해 아무것도 못 묻습니다 -- 급등주를 아무거나 샀어도 지수는 이겼을
 * 테니까요. 물어야 할 것은 좁습니다: 같은 순간에 +10~29%로 달리던 종목이 수십 개
 * 있었는데, 그중 **상한가 1등주와 테마를 공유하는 종목**을 고른 것이 값이 있었는가.
 *
 * 표본이 얇습니다. 하루 1~2쌍을 기대했는데 실제로는 하루 5~20건이 잡히지만(2등주
 * 문턱이 10%라 그렇습니다) 그래도 장 수가 열 몇 개뿐입니다. 통계가 아니라 관찰로
 * 읽으세요. 등급 기준을 바꾸려면 더 기다리는 편이 낫습니다.
 */

const config = readConfig();
const num = (value) => (value === null || value === undefined ? null : Number(value));
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

/** 진입가 대비 수익률입니다. 둘 다 전일 종가 대비 등락률이므로 비율로 나눕니다. */
function moveFrom(entryRate, rate) {
  const base = 100 + entryRate;

  if (!(base > 0)) return null;

  return ((100 + rate) / base - 1) * 100;
}

function stats(values) {
  const xs = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);

  if (xs.length === 0) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = xs[Math.floor(xs.length / 2)];
  const win = xs.filter((x) => x > 0).length / xs.length * 100;

  return { count: xs.length, mean, median, win, worst: xs[0], best: xs[xs.length - 1] };
}

function report(label, values, { min = 1 } = {}) {
  const s = stats(values);

  if (!s || s.count < min) {
    console.log(`  ${label.padEnd(26)} ${String(s?.count ?? 0).padStart(5)}건  -`);

    return;
  }

  console.log(`  ${label.padEnd(26)} ${String(s.count).padStart(5)}건  평균 ${pct(s.mean).padStart(8)}` +
    `  중앙 ${pct(s.median).padStart(8)}  상회 ${s.win.toFixed(0).padStart(3)}%` +
    `  최악 ${pct(s.worst).padStart(8)}`);
}

/*
 * 신호 한 건 = 그날 그 종목에 대해 처음 잡힌 짝꿍 자리입니다.
 *
 * 일봉을 붙이는 이유는 익일 시가 때문입니다. 장중에 파는 것과 들고 가는 것 중
 * 어느 쪽이 나은지가 이 측정의 절반이고, 그건 같은 신호에 대해 둘 다 재야
 * 답할 수 있습니다.
 */
const { rows: signals } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  )
  SELECT o.session_date::text AS d, o.symbol, o.theme, o.leader_symbol,
         o.entry_rate,
         to_char(o.detected_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS entry_time,
         extract(epoch FROM o.detected_at) AS entry_epoch,
         CASE WHEN b.prev_close > 0 AND b.next_open > 0
              THEN (b.next_open / b.prev_close - 1) * 100 END AS next_open_rate,
         CASE WHEN b.prev_close > 0 AND b.next_close > 0
              THEN (b.next_close / b.prev_close - 1) * 100 END AS next_close_rate
    FROM kr_signal_outcomes o
    LEFT JOIN bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
   WHERE o.kind = 'limit_pair' AND o.entry_rate IS NOT NULL
   ORDER BY o.session_date, o.detected_at, o.symbol
`);

/*
 * 진입 뒤의 길입니다. 2등주와 1등주를 같이 받습니다 -- 1등주가 상한가에서 풀리는
 * 순간이 이 매매의 전제가 무너지는 순간이라, 청산 규칙 후보로 같이 재야 합니다.
 *
 * 분 단위로 중복을 걷습니다. 같은 종목이 kis:krx / :pair / :seen 세 소스에 거의
 * 같은 시각으로 들어오므로, 걷지 않으면 한 순간이 세 번 세어지고 소스마다 표본이
 * 다른 구간에서 가중치가 틀어집니다.
 */
const { rows: path } = await query(config, `
  SELECT DISTINCT ON (o.session_date, o.symbol, s.symbol, date_trunc('minute', s.observed_at))
         o.session_date::text AS d, o.symbol AS signal_symbol,
         CASE WHEN s.symbol = o.symbol THEN 'second' ELSE 'leader' END AS role,
         s.change_rate,
         extract(epoch FROM s.observed_at) AS epoch,
         to_char(s.observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS t
    FROM kr_signal_outcomes o
    JOIN market_price_samples s
      ON s.session_date = o.session_date AND s.market = 'KR'
     AND s.source LIKE 'kis:krx%' AND s.change_rate IS NOT NULL
     AND s.symbol IN (o.symbol, o.leader_symbol)
     AND s.observed_at >= o.detected_at
   WHERE o.kind = 'limit_pair'
   ORDER BY o.session_date, o.symbol, s.symbol,
            date_trunc('minute', s.observed_at), s.observed_at DESC
`);

/*
 * 대조군: 같은 순간에 +10~29%로 달리던 다른 종목들.
 *
 * 1등주와 2등주는 뺍니다. 같은 테마 회원인지는 묻지 않습니다 -- 물으면 그건 짝꿍의
 * 정의를 대조군에 넣는 것이라 비교가 성립하지 않습니다.
 */
const { rows: peers } = await query(config, `
  WITH sig AS (
    SELECT session_date, symbol, leader_symbol, detected_at
      FROM kr_signal_outcomes WHERE kind = 'limit_pair'
  ),
  ticks AS (
    SELECT DISTINCT ON (session_date, symbol, date_trunc('minute', observed_at))
           session_date, symbol, observed_at, change_rate
      FROM market_price_samples
     WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
     ORDER BY session_date, symbol, date_trunc('minute', observed_at), observed_at DESC
  ),
  entered AS (
    SELECT DISTINCT ON (sig.session_date, sig.symbol, t.symbol)
           sig.session_date, sig.symbol AS signal_symbol,
           t.symbol AS peer, t.change_rate AS peer_entry
      FROM sig
      JOIN ticks t ON t.session_date = sig.session_date
       AND t.observed_at BETWEEN sig.detected_at - interval '2 minutes'
                             AND sig.detected_at + interval '2 minutes'
       AND t.change_rate BETWEEN 10 AND 29
       AND t.symbol <> sig.symbol AND t.symbol <> sig.leader_symbol
     ORDER BY sig.session_date, sig.symbol, t.symbol,
              abs(extract(epoch FROM t.observed_at - sig.detected_at))
  ),
  closed AS (
    SELECT DISTINCT ON (session_date, symbol) session_date, symbol, change_rate
      FROM ticks ORDER BY session_date, symbol, observed_at DESC
  )
  SELECT e.session_date::text AS d, e.signal_symbol, e.peer,
         e.peer_entry, c.change_rate AS peer_close
    FROM entered e
    JOIN closed c ON c.session_date = e.session_date AND c.symbol = e.peer
`);

const bySignal = new Map();

for (const row of path) {
  const key = `${row.d}|${row.signal_symbol}`;
  const entry = bySignal.get(key) ?? { leader: [], second: [] };

  entry[row.role === "second" ? "second" : "leader"].push({
    epoch: num(row.epoch), rate: num(row.change_rate), t: row.t
  });
  bySignal.set(key, entry);
}

for (const legs of bySignal.values()) {
  legs.leader.sort((a, b) => a.epoch - b.epoch);
  legs.second.sort((a, b) => a.epoch - b.epoch);
}

const peerBySignal = new Map();

for (const row of peers) {
  const key = `${row.d}|${row.signal_symbol}`;
  const list = peerBySignal.get(key) ?? [];

  list.push(moveFrom(num(row.peer_entry), num(row.peer_close)));
  peerBySignal.set(key, list);
}

/*
 * 신호마다 길을 요약합니다. 여기서 만든 값만 아래 절들이 씁니다.
 */
const events = signals.map((row) => {
  const key = `${row.d}|${row.symbol}`;
  const legs = bySignal.get(key) ?? { leader: [], second: [] };
  const entryRate = num(row.entry_rate);
  const walk = legs.second.map((tick) => ({ ...tick, move: moveFrom(entryRate, tick.rate) }));
  const peerMoves = (peerBySignal.get(key) ?? []).filter((x) => x !== null);
  // 1등주가 상한가에서 처음 풀린 시각. 안 풀렸으면 null입니다.
  const unlock = legs.leader.find((tick) => tick.rate < 29.5) ?? null;

  const at = (seconds) => {
    const target = num(row.entry_epoch) + seconds;
    const hit = walk.find((tick) => tick.epoch >= target);

    return hit ? hit.move : null;
  };
  // 진입보다 이른 시각은 청산 자리가 아닙니다. 막지 않으면 13시에 잡힌 신호가
  // 11시 칸에 진입 그 자체(0%)를 넣어, 늦게 잡힌 신호일수록 이른 칸을 0으로 채웁니다.
  const atClock = (hhmm) => {
    if (row.entry_time >= hhmm) return null;

    const hit = walk.find((tick) => tick.t >= hhmm);

    return hit ? hit.move : null;
  };
  const peakTick = walk.reduce((best, tick) => (best === null || tick.move > best.move ? tick : best), null);

  return {
    close: walk.length > 0 ? walk[walk.length - 1].move : null,
    d: row.d,
    drawdown: walk.length > 0 ? Math.min(...walk.map((tick) => tick.move)) : null,
    entryRate,
    entryTime: row.entry_time,
    gap: 29.9 - entryRate,
    leader: row.leader_symbol,
    // 2등주가 스스로 상한가에 닿으면 거기서 끝입니다 -- 더 못 오르고, 팔 수 있습니다.
    lockedMove: walk.some((tick) => tick.rate >= 29.5) ? moveFrom(entryRate, 29.9) : null,
    nextOpen: num(row.next_open_rate) === null ? null : moveFrom(entryRate, num(row.next_open_rate)),
    // 마감에 사서 익일 시가에 파는 것 -- 캘리브레이션이 재고 있는 그 매매입니다.
    overnight: num(row.next_open_rate) === null || walk.length === 0
      ? null
      : moveFrom(walk[walk.length - 1].rate, num(row.next_open_rate)),
    peak: peakTick ? peakTick.move : null,
    peakAfter: peakTick ? (peakTick.epoch - num(row.entry_epoch)) / 60 : null,
    symbol: row.symbol,
    theme: row.theme,
    ticks: walk.length,
    unlockMove: unlock ? (walk.find((tick) => tick.epoch >= unlock.epoch)?.move ?? null) : null,
    at, atClock
  };
}).filter((event) => event.ticks > 0);

const days = new Set(events.map((event) => event.d));

console.log(`\n짝꿍매매 장중 측정 · ${events.length}건 · ${days.size}개 장 · ` +
  `${[...days].sort()[0]} ~ ${[...days].sort().slice(-1)[0]}`);
console.log("진입은 kr_signal_outcomes에 남은 실제 발동 시각입니다. 값은 전부 진입가 대비 수익률입니다.");

console.log("\n[1] 진입 → 마감 보유");
report("전체", events.map((e) => e.close));
report("  대조군 (그 시각 급등주)", events.flatMap((e) => peerBySignal.get(`${e.d}|${e.symbol}`) ?? []));

console.log("\n[2] 진입 시점 간격 — 화면 등급이 장중에도 맞는가");
console.log("    익일시가 기준으로는 밀착(0~2%p)이 +5.55%p·76%로 최고였습니다\n");

for (const [low, high, label] of [
  [0, 2, "밀착 0~2%p"], [2, 5, "근접 2~5%p"], [5, 10, "여유 5~10%p"],
  [10, 15, "10~15%p"], [15, 100, "15%p 초과"]
]) {
  report(label, events.filter((e) => e.gap >= low && e.gap < high).map((e) => e.close));
}

console.log("\n[3] 청산 시각");

for (const minutes of [5, 10, 15, 30, 60, 120]) {
  report(`  +${minutes}분`, events.map((e) => e.at(minutes * 60)));
}

for (const clock of ["11:00", "13:00", "14:00", "15:00"]) {
  report(`  ${clock}`, events.map((e) => e.atClock(clock)));
}

report("  마감 보유", events.map((e) => e.close));
report("  익일 시가", events.map((e) => e.nextOpen));

console.log("\n  참고 — 마감에 사서 익일 시가에 파는 구간만 (캘리브레이션이 재던 매매)");
report("  마감 → 익일 시가", events.map((e) => e.overnight));

console.log("\n[4] 되돌림 — 견딜 수 있는 매매인가");

const drawdowns = events.map((e) => e.drawdown).filter((x) => x !== null).sort((a, b) => a - b);
const quantile = (q) => drawdowns[Math.min(drawdowns.length - 1, Math.floor(drawdowns.length * q))];

console.log(`  최대 되돌림 분포  최악 ${pct(drawdowns[0])} · 하위10% ${pct(quantile(0.1))}` +
  ` · 중앙 ${pct(quantile(0.5))} · 상위10% ${pct(quantile(0.9))}`);

for (const stop of [-2, -3, -5, -10]) {
  const hit = events.filter((e) => e.drawdown !== null && e.drawdown <= stop);

  console.log(`  ${stop}% 손절선  ${String(hit.length).padStart(3)}건 걸림 (${(hit.length / events.length * 100).toFixed(0)}%)` +
    `  그중 마감까지 들고 있었으면 ${stats(hit.map((e) => e.close))?.mean.toFixed(2) ?? "-"}%`);
}

console.log("\n[5] 최고점과 마감 — 언제 팔 수 있었는가");
report("최고점 (완전예지)", events.map((e) => e.peak));
report("마감", events.map((e) => e.close));

const peakAfter = events.map((e) => e.peakAfter).filter((x) => x !== null).sort((a, b) => a - b);
const within = (minutes) => peakAfter.filter((x) => x <= minutes).length / peakAfter.length * 100;

console.log(`  최고점 도달까지  중앙 ${peakAfter[Math.floor(peakAfter.length / 2)].toFixed(0)}분` +
  ` · 진입 직후 ${within(0).toFixed(0)}% · 15분 안 ${within(15).toFixed(0)}%` +
  ` · 30분 안 ${within(30).toFixed(0)}% · 1시간 안 ${within(60).toFixed(0)}%`);

const locked = events.filter((e) => e.lockedMove !== null);

console.log(`  2등주도 상한가에 닿은 것 ${locked.length}건 (${(locked.length / events.length * 100).toFixed(0)}%)` +
  `  그 자리 평균 ${stats(locked.map((e) => e.lockedMove))?.mean.toFixed(2) ?? "-"}%` +
  `  마감까지 들고 있었으면 ${stats(locked.map((e) => e.close))?.mean.toFixed(2) ?? "-"}%`);

console.log("\n[6] 1등주가 상한가에서 풀리면");

const unlocked = events.filter((e) => e.unlockMove !== null);

report("풀린 신호 · 풀린 순간", unlocked.map((e) => e.unlockMove));
report("풀린 신호 · 마감", unlocked.map((e) => e.close));
report("안 풀린 신호 · 마감", events.filter((e) => e.unlockMove === null).map((e) => e.close));

console.log("\n[7] 진입 시각대");

for (const [from, to] of [["09:00", "10:00"], ["10:00", "11:30"], ["11:30", "13:00"], ["13:00", "15:40"]]) {
  report(`${from}~${to}`, events.filter((e) => e.entryTime >= from && e.entryTime < to).map((e) => e.close));
}

console.log("\n[8] 신호 목록");
console.log("  날짜        시각   2등주      진입    간격    마감     최고     되돌림  테마");

for (const e of events) {
  console.log(`  ${e.d}  ${e.entryTime}  ${e.symbol.padEnd(8)}` +
    `${e.entryRate.toFixed(1).padStart(6)}%${e.gap.toFixed(1).padStart(7)}%p` +
    `${pct(e.close ?? 0).padStart(8)}${pct(e.peak ?? 0).padStart(9)}${pct(e.drawdown ?? 0).padStart(9)}  ${e.theme ?? ""}`);
}

process.exit(0);
