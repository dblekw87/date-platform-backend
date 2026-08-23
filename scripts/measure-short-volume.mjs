import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * FINRA 일별 공매도 비중이 급등을 앞서 알려주는가.
 *
 *   node scripts/measure-short-volume.mjs
 *
 * 가설은 원지(YJ) 한 건에서 나왔습니다. 죽어 있던 종목이 8/7에 거래량 4자릿수로
 * 터지고, 그 뒤 공매도 비중이 50%대에 고정됐고, 8/19에 프리마켓 +203%였습니다.
 * **8거래일 전에 보였던 신호**입니다. 다만 n=1이라 그때는 가설이었습니다.
 *
 * 검정 기준은 [[us-surge-findings]]가 정해 놓은 것을 그대로 씁니다 --
 * **회전율·시총·급등이력을 통제한 뒤에도 배수가 남는가.** 뉴스·차트·SEC 공시가
 * 이 검정에서 탈락했고, 통제 없이 재면 셋 다 통과했을 것입니다.
 *
 * 라벨(`us_surge_events`)과 모집단은 `pipeline/us-calibration.mjs`와 같습니다.
 * 새로 정의하면 여기서 나온 숫자가 화면의 숫자와 다른 것을 재게 됩니다.
 *
 * ## 이 데이터에 대해 알아야 할 것
 *
 * FINRA 파일은 **장외(off-exchange) 거래분**입니다. 전체 시장이 아니라 ATS·비ATS
 * 체결분이라, 공매도 비중이 40~60%로 나오는 것이 정상입니다 -- 절대 수준 50%는
 * 신호가 아닙니다. YJ도 7~20%에서 55%로 **올라가 고정된 것**이 눈에 띈 것이지
 * 55%라는 값 자체가 아닙니다. 그래서 수준과 함께 **자기 기준선 대비 변화**와
 * **지속**을 같이 잽니다.
 */

const config = readConfig();
const started = Date.now();

// 기준선은 D-25~D-6입니다. 최근 5일을 빼는 것은, 신호로 쓰려는 그 5일이 기준선에
// 섞이면 변화량이 스스로를 상쇄하기 때문입니다.
const measurement = `
WITH sampled AS (
  SELECT session_date FROM (
    SELECT session_date, row_number() OVER (ORDER BY session_date) AS rn
      FROM us_backfill_progress WHERE bar_count > 0
  ) t WHERE rn % 3 = 0
),
short AS (
  SELECT symbol, session_date,
         short_volume / nullif(total_volume, 0) AS ratio,
         count(*) OVER w AS history,
         avg(short_volume / nullif(total_volume, 0)) OVER w5 AS ratio5,
         count(*) FILTER (WHERE short_volume / nullif(total_volume, 0) >= 0.5) OVER w5 AS persist5,
         avg(short_volume / nullif(total_volume, 0)) OVER wbase AS baseline,
         avg(total_volume) OVER w5 AS vol5,
         avg(total_volume) OVER wbase AS vol_baseline
    FROM us_short_volume
   WHERE total_volume > 0
  WINDOW w AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 25 PRECEDING AND CURRENT ROW),
         w5 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
         wbase AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 25 PRECEDING AND 6 PRECEDING)
),
pool AS (
  SELECT b.symbol, b.session_date,
         b.volume / s.shares AS turnover,
         b.close * s.shares AS market_cap,
         sv.ratio, sv.ratio5, sv.persist5, sv.baseline,
         sv.vol5 / nullif(sv.vol_baseline, 0) AS vol_trend,
         (SELECT max(e.session_date) FROM us_surge_events e
           WHERE e.symbol = b.symbol AND e.session_date <= b.session_date) AS last_run
    FROM us_daily_bars b
    JOIN sampled ss ON ss.session_date = b.session_date
    JOIN short sv ON sv.symbol = b.symbol AND sv.session_date = b.session_date
                 AND sv.history >= 26 AND sv.baseline > 0
    JOIN LATERAL (
      SELECT u.cik FROM us_tickers u
       WHERE u.symbol = b.symbol AND u.as_of <= b.session_date AND u.cik IS NOT NULL
         AND u.type IN ('CS', 'ADRC')
       ORDER BY u.as_of DESC LIMIT 1
    ) tk ON true
    LEFT JOIN LATERAL (
      SELECT ls.shares, ls.as_of FROM us_listed_shares ls
       WHERE ls.symbol = b.symbol AND ls.shares >= 100000
       ORDER BY ls.as_of DESC LIMIT 1
    ) cur ON true
    LEFT JOIN LATERAL (
      SELECT exp(sum(ln(sp.split_from / sp.split_to))) AS factor
        FROM us_splits sp
       WHERE sp.symbol = b.symbol AND sp.execution_date > b.session_date
         AND sp.execution_date <= cur.as_of AND sp.split_from > 0 AND sp.split_to > 0
    ) adj ON true
    JOIN LATERAL (
      SELECT coalesce(
        cur.shares * coalesce(adj.factor, 1),
        (SELECT sc.shares FROM us_share_counts sc
          WHERE sc.cik = tk.cik AND sc.period_end <= b.session_date AND sc.shares >= 100000
          ORDER BY sc.period_end DESC LIMIT 1)
      ) AS shares
    ) s ON s.shares IS NOT NULL
   WHERE b.close >= 0.1 AND b.close * b.volume >= 100000
),
bucketed AS (
  SELECT p.*,
    CASE WHEN turnover >= 1.0 THEN 'F 100%+'
         WHEN turnover >= 0.5 THEN 'E 50-100%'
         WHEN turnover >= 0.2 THEN 'D 20-50%'
         WHEN turnover >= 0.05 THEN 'C 5-20%'
         WHEN turnover >= 0.01 THEN 'B 1-5%'
         ELSE 'A <1%' END AS turnover_bucket,
    CASE WHEN market_cap < 25e6 THEN 'A <25M'
         WHEN market_cap < 100e6 THEN 'B 25-100M'
         WHEN market_cap < 500e6 THEN 'C 100-500M'
         WHEN market_cap < 2e9 THEN 'D 0.5-2B'
         ELSE 'E 2B+' END AS market_cap_bucket,
    CASE WHEN last_run IS NULL THEN 'Z 이력없음'
         WHEN session_date - last_run = 0 THEN 'A 당일'
         WHEN session_date - last_run <= 5 THEN 'B 1-5일'
         WHEN session_date - last_run <= 20 THEN 'C 6-20일'
         WHEN session_date - last_run <= 90 THEN 'D 21-90일'
         ELSE 'E 90일초과' END AS recency_bucket,
    -- 수준. 장외 비중이라 50%가 보통이므로 이것만으로는 신호가 아닐 것입니다.
    CASE WHEN ratio5 >= 0.6 THEN 'D 60%+'
         WHEN ratio5 >= 0.5 THEN 'C 50-60%'
         WHEN ratio5 >= 0.4 THEN 'B 40-50%'
         ELSE 'A <40%' END AS level_bucket,
    -- 자기 기준선 대비 변화. YJ에서 눈에 띈 것이 이쪽입니다.
    CASE WHEN ratio5 - baseline >= 0.15 THEN 'D +15%p↑'
         WHEN ratio5 - baseline >= 0.05 THEN 'C +5~15%p'
         WHEN ratio5 - baseline >= -0.05 THEN 'B ±5%p'
         ELSE 'A -5%p↓' END AS shift_bucket,
    -- 지속. 최근 5일 중 몇 번이나 절반을 넘겼는가.
    CASE WHEN persist5 >= 5 THEN 'C 5/5'
         WHEN persist5 >= 3 THEN 'B 3-4/5'
         ELSE 'A 0-2/5' END AS persist_bucket,
    -- 거래량 자체가 늘고 있는가. 공매도 비중이 오르는 것과 거래가 늘어나는 것은
    -- 같이 가기 쉬우므로, 이걸 통제하지 않으면 회전율을 세 번째로 다시 재게 됩니다.
    CASE WHEN vol_trend >= 3 THEN 'D 3배↑'
         WHEN vol_trend >= 1.5 THEN 'C 1.5-3배'
         WHEN vol_trend >= 0.7 THEN 'B 0.7-1.5배'
         ELSE 'A 0.7배↓' END AS volshift_bucket
    FROM pool p
),
outcome AS (
  SELECT b.*,
         EXISTS (SELECT 1 FROM us_surge_events e
                  WHERE e.symbol = b.symbol AND e.session_date > b.session_date
                    AND e.session_date <= b.session_date + 10) AS surged
    FROM bucketed b
)
SELECT * FROM outcome
`;

const { rows } = await query(config, `${measurement}`);

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-일 · ${new Set(rows.map((r) => r.session_date.toISOString().slice(0, 10))).size}개 세션 · 10거래일 내 급등 라벨`);

const rate = (list) => (list.length === 0 ? null : list.filter((r) => r.surged).length / list.length);
const base = rate(rows);

console.log(`전체 급등 발생률 ${(base * 100).toFixed(2)}%\n`);

function report(title, key) {
  const groups = [...new Set(rows.map((r) => r[key]))].sort();

  console.log(title);
  groups.forEach((g) => {
    const list = rows.filter((r) => r[key] === g);
    const value = rate(list);

    console.log(`  ${g.padEnd(12)} ${String(list.length).padStart(8)}건 · ${(value * 100).toFixed(2)}% · 배수 ${(value / base).toFixed(2)}`);
  });
  console.log("");
}

console.log("=== [1] 통제 없이 ===\n");
report("공매도 비중 수준 (5일 평균)", "level_bucket");
report("자기 기준선 대비 변화", "shift_bucket");
report("지속 (5일 중 50% 넘긴 날)", "persist_bucket");
report("참고 — 회전율 (이미 아는 신호)", "turnover_bucket");

/**
 * 통제한 뒤에도 남는가.
 *
 * 회전율×시총×이력 칸 안에서 공매도 축이 갈라지는지 봅니다. 갈라지지 않으면
 * 위 [1]의 배수는 공매도가 아니라 회전율을 다시 본 것입니다 -- 뉴스와 SEC 공시가
 * 정확히 그렇게 탈락했습니다.
 */
console.log("=== [2] 회전율·시총·이력을 통제한 뒤 ===\n");

for (const key of ["level_bucket", "shift_bucket", "persist_bucket"]) {
  const cells = new Map();

  rows.forEach((row) => {
    const cell = `${row.turnover_bucket}|${row.market_cap_bucket}|${row.recency_bucket}`;
    const list = cells.get(cell) ?? new Map();

    list.set(row[key], [...(list.get(row[key]) ?? []), row]);
    cells.set(cell, list);
  });

  // 칸 안에서 최고 등급과 최저 등급의 발생률 차이를, 표본으로 가중해 평균냅니다.
  let weighted = 0;
  let weight = 0;
  let usable = 0;

  for (const byBucket of cells.values()) {
    const parts = [...byBucket.entries()]
      .filter(([, list]) => list.length >= 200)
      .sort(([a], [b]) => a.localeCompare(b));

    if (parts.length < 2) continue;

    const low = rate(parts[0][1]);
    const high = rate(parts[parts.length - 1][1]);
    const n = parts.reduce((sum, [, list]) => sum + list.length, 0);

    weighted += (high - low) * n;
    weight += n;
    usable += 1;
  }

  const spread = weight > 0 ? weighted / weight : 0;

  console.log(`${key.padEnd(16)} 칸 ${usable}개 · 표본 ${weight.toLocaleString("ko-KR")} · 칸 안 최고−최저 발생률 차이 ${(spread * 100).toFixed(2)}%p`);
}

/**
 * [2]는 저회전율 칸이 지배합니다.
 *
 * 표본의 94%가 회전율 A·B에 있고 거기는 급등이 원래 거의 없습니다. 정작 궁금한 것은
 * **급등이 실제로 일어나는 구간 안에서** 공매도가 갈라주는가입니다 -- 회전율 5% 위쪽은
 * 표본이 얇아 칸 단위로 자르면 전부 문턱에 걸려 사라집니다. 그래서 회전율 등급별로
 * 한 번 더 봅니다.
 */
console.log("=== [3] 회전율 등급 안에서 (급등이 실제로 나는 구간) ===\n");

const turnoverGroups = [...new Set(rows.map((r) => r.turnover_bucket))].sort();

for (const key of ["level_bucket", "shift_bucket", "persist_bucket"]) {
  console.log(key);
  turnoverGroups.forEach((group) => {
    const inGroup = rows.filter((r) => r.turnover_bucket === group);
    const groupRate = rate(inGroup);
    const parts = [...new Set(inGroup.map((r) => r[key]))].sort()
      .map((bucket) => {
        const list = inGroup.filter((r) => r[key] === bucket);

        return { bucket, n: list.length, value: rate(list) };
      })
      .filter((part) => part.n >= 100);

    if (parts.length < 2) {
      console.log(`  ${group.padEnd(11)} 표본 부족`);

      return;
    }

    const line = parts.map((part) => `${part.bucket.slice(2)} ${(part.value * 100).toFixed(1)}%(${part.n})`).join(" · ");

    console.log(`  ${group.padEnd(11)} 기준 ${(groupRate * 100).toFixed(2)}%  |  ${line}`);
  });
  console.log("");
}

/**
 * 진짜 물어야 할 것 — 거래량이 아니라 공매도인가.
 *
 * 공매도 비중이 오르는 날은 거래가 늘어나는 날이기 쉽습니다. 그러면 [3]의 사다리는
 * 회전율을 세 번째로 다시 잰 것에 불과합니다. 거래량 증가배수를 고정해 놓고도
 * 공매도 변화가 갈라주는지 봅니다.
 *
 * 회전율은 5~20% 구간만 봅니다 -- 급등이 실제로 나면서(4.9%) 표본도 충분한
 * 유일한 구간입니다. 그 위는 칸을 두 번 나누면 백 건 밑으로 떨어집니다.
 */
console.log("=== [4] 거래량 증가까지 고정하면 (회전율 5~20% 구간) ===\n");

const zone = rows.filter((r) => r.turnover_bucket === "C 5-20%");
const volGroups = [...new Set(zone.map((r) => r.volshift_bucket))].sort();

console.log(`구간 표본 ${zone.length.toLocaleString("ko-KR")} · 기준 ${(rate(zone) * 100).toFixed(2)}%\n`);
volGroups.forEach((group) => {
  const inGroup = zone.filter((r) => r.volshift_bucket === group);
  const parts = [...new Set(inGroup.map((r) => r.shift_bucket))].sort()
    .map((bucket) => {
      const list = inGroup.filter((r) => r.shift_bucket === bucket);

      return { bucket, n: list.length, value: rate(list) };
    })
    .filter((part) => part.n >= 100);

  if (parts.length < 2) {
    console.log(`  거래량 ${group.padEnd(12)} 표본 부족 (${inGroup.length}건)`);

    return;
  }

  const line = parts.map((part) => `${part.bucket.slice(2)} ${(part.value * 100).toFixed(1)}%(${part.n})`).join(" · ");

  console.log(`  거래량 ${group.padEnd(12)} 기준 ${(rate(inGroup) * 100).toFixed(2)}%  |  ${line}`);
});

/**
 * 가장 좋은 칸이 우연인가.
 *
 * 이항 검정입니다. 같은 구간의 기준 발생률이 참일 때 관측된 급등 수가 나올 확률을
 * 정규근사로 잽니다. z가 2를 넘으면 우연으로 보기 어렵습니다.
 */
console.log("\n=== [5] 유의성 ===\n");

["C 5-20%", "D 20-50%", "E 50-100%", "F 100%+"].forEach((group) => {
  const inGroup = rows.filter((r) => r.turnover_bucket === group);
  const hits = inGroup.filter((r) => r.shift_bucket === "D +15%p↑");

  if (hits.length < 50) {
    console.log(`  ${group.padEnd(11)} 표본 ${hits.length}건 — 판단 보류`);

    return;
  }

  const p = rate(inGroup);
  const observed = hits.filter((r) => r.surged).length;
  const expected = p * hits.length;
  const z = (observed - expected) / Math.sqrt(hits.length * p * (1 - p));

  console.log(`  ${group.padEnd(11)} +15%p↑ ${hits.length}건 · 급등 ${observed}건(기대 ${expected.toFixed(1)}) · 배수 ${(rate(hits) / p).toFixed(2)} · z ${z.toFixed(2)}`);
});

console.log(`\n${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
