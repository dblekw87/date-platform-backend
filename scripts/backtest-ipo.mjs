import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 신규상장 종목을 언제 사서 언제 팔면 되는가 -- 되재기.
 *
 *   node scripts/backtest-ipo.mjs
 *
 * 2026-09-29 아침에 사용자가 상장 당일 종목에 시가단일가 주문을 넣을지 묻다가
 * 넣지 않기로 하고 되재기를 요청했습니다. 그래서 **살 수 있는 자리마다** 재 봅니다.
 *
 * **공모주 청약은 여기 없습니다.** 배정받아 파는 것은 다른 게임이고(공모가를 우리가
 * 들고 있지도 않습니다), 사용자가 묻는 것은 시장에서 사는 자리입니다.
 *
 * 규칙 셋을 지킵니다.
 *
 *   앞을 안 봅니다   진입 조건은 그 시점까지의 값만 씁니다. "저가에 산다"는 전략은
 *                    사후값이라 뺐습니다. 대신 "시초가 -N%에 지정가를 걸어 둔다"로
 *                    바꿉니다 -- 그날 저가가 거기 닿았으면 체결됐다고 봅니다.
 *   시장을 뺍니다     그날 시장 평균 수익률을 뺀 초과분을 같이 적습니다. 상장일이
 *                    지수가 오른 날에 몰려 있으면 전략의 공이 아닙니다.
 *   분포를 봅니다     평균은 스카이랩스 하나(첫날 +176%)가 만들 수 있습니다.
 *                    중앙값과 승률을 같이 읽어야 합니다.
 *
 * 상장일은 **일봉에 처음 나타난 날**로 잡습니다(kr_listings.listed_on은 2026-08-21
 * 부터라 표본이 모자랍니다). 스팩·ETF·ETN은 사업 회사가 아니라 상장 형태라 뺍니다.
 */
const config = readConfig();
const horizon = 10;

const { rows } = await query(config, `
  WITH first AS (
    SELECT symbol, min(session_date) AS listed FROM kr_daily_bars GROUP BY symbol
  ),
  seq AS (
    SELECT symbol, session_date, open::float8, high::float8, low::float8, close::float8,
           row_number() OVER (PARTITION BY symbol ORDER BY session_date) AS n
      FROM kr_daily_bars WHERE open > 0 AND close > 0
  ),
  market AS (
    SELECT s.session_date, avg((s.close / p.close - 1) * 100) AS move
      FROM seq s
      JOIN seq p ON p.symbol = s.symbol AND p.n = s.n - 1
     GROUP BY s.session_date HAVING count(*) >= 50
  )
  SELECT d.symbol, l.name, d.session_date::text AS d,
         d.open, d.high, d.low, d.close,
         m.move AS market_move,
         (SELECT json_agg(json_build_object('n', f.n - d.n, 'open', f.open, 'high', f.high,
                                            'low', f.low, 'close', f.close, 'd', f.session_date)
                          ORDER BY f.n)
            FROM seq f WHERE f.symbol = d.symbol AND f.n > d.n AND f.n <= d.n + ${horizon}) AS after
    FROM seq d
    JOIN first t ON t.symbol = d.symbol AND t.listed = d.session_date
    LEFT JOIN kr_listings l ON l.symbol = d.symbol
    LEFT JOIN market m ON m.session_date = d.session_date
   WHERE d.session_date >= '2025-03-01' AND l.name IS NOT NULL
     AND l.name !~ '스팩|ETN|TIGER|KODEX|RISE|PLUS|ACE|SOL |TIMEFOLIO|KIWOOM|히어로즈|파워 |마이티|WON |BNK|UNICORN|프리미어|액티브'
`);

const num = (value) => Number(value);
const after = (row, day) => (row.after ?? []).find((bar) => bar.n === day) ?? null;
const results = new Map();

/* 한 전략의 한 건. 못 들어간 날(조건 미충족)은 기록하지 않습니다 -- 0%로 세면
   "기회가 없던 날"이 "본전인 날"이 되어 승률이 올라갑니다. */
function record(name, row, entry, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return;

  if (!results.has(name)) results.set(name, []);

  results.get(name).push({
    excess: (exit / entry - 1) * 100 - num(row.market_move ?? 0),
    name: row.name,
    raw: (exit / entry - 1) * 100
  });
}

for (const row of rows) {
  const open = num(row.open);
  const close = num(row.close);
  const low = num(row.low);
  const d1 = after(row, 1);
  const d5 = after(row, 5);
  const d10 = after(row, 10);

  /* 1) 시초가에 사는 자리들. */
  record("시초가 → 첫날 종가", row, open, close);
  if (d1) record("시초가 → 익일 시가", row, open, num(d1.open));
  if (d1) record("시초가 → 익일 종가", row, open, num(d1.close));

  /* 2) 손절을 걸면. 장중에 그 선을 닿았으면 거기서 끊고, 아니면 종가까지. */
  for (const stop of [5, 10]) {
    const line = open * (1 - stop / 100);

    record(`시초가 매수 · -${stop}% 손절`, row, open, low <= line ? line : close);
  }

  /* 3) 첫날 종가에 사는 자리. 시초가의 열기가 빠진 뒤입니다. */
  if (d1) record("첫날 종가 → 익일 시가", row, close, num(d1.open));
  if (d1) record("첫날 종가 → 익일 종가", row, close, num(d1.close));
  if (d5) record("첫날 종가 → D+5 종가", row, close, num(d5.close));
  if (d10) record("첫날 종가 → D+10 종가", row, close, num(d10.close));

  /* 4) 첫날 시초가 아래로 내려오면 사는 지정가. 앞을 안 보는 조건입니다. */
  for (const dip of [5, 10, 20]) {
    const line = open * (1 - dip / 100);

    if (low > line) continue;

    record(`시초가 -${dip}% 지정가 → 첫날 종가`, row, line, close);
    if (d1) record(`시초가 -${dip}% 지정가 → 익일 종가`, row, line, num(d1.close));
  }

  /* 5) 며칠 지나 사는 자리. 상장 소음이 가라앉은 뒤. */
  if (d1 && d5) record("D+1 종가 → D+5 종가", row, num(d1.close), num(d5.close));
  if (d5 && d10) record("D+5 종가 → D+10 종가", row, num(d5.close), num(d10.close));
}

const order = [...results.entries()].sort((a, b) => b[1].length - a[1].length);

console.log(`\n신규상장 되재기 · ${rows.length}종목 (2025-03 이후, 스팩·ETF·ETN 제외)`);
console.log("초과 = 그날 시장 평균을 뺀 값. 중앙값과 승률을 같이 보세요 -- 평균은 한 건이 만듭니다.\n");
console.log("전략                               N    평균raw    중앙raw     평균초과   승률");

for (const [name, list] of order) {
  const raws = list.map((row) => row.raw).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const median = raws[Math.floor(raws.length / 2)];
  const excess = mean(list.map((row) => row.excess));
  const win = list.filter((row) => row.raw > 0).length / list.length;

  console.log(
    name.padEnd(32),
    String(list.length).padStart(4),
    `${mean(raws) >= 0 ? "+" : ""}${mean(raws).toFixed(2)}%`.padStart(9),
    `${median >= 0 ? "+" : ""}${median.toFixed(2)}%`.padStart(9),
    `${excess >= 0 ? "+" : ""}${excess.toFixed(2)}%p`.padStart(10),
    `${Math.round(100 * win)}%`.padStart(6)
  );
}

process.exit(0);
