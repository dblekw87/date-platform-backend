import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 미국 프리마켓 급등 알림 채점, 이유 종류별.
 *
 * 2026-11-12 사용자: "미국 급등주 분석은 어떻게 하는 거려나, 뉴스나 재료 같은 게 있을 때도
 * 있을 것 같은데". 그날 밤 관찰(ICMB 합병가에 묶임 · PLCE 파산 개장 뒤 밀림 · POAS 이유 없이
 * +522% → 3분에 −32%)을 표본으로 확인합니다.
 *
 * 알림가는 alert_sent.note의 "@가격 prev 가격"에서 읽습니다(us-premarket-alert.mjs).
 * 그날 정규장 시가·고가·종가는 us_daily_bars에서. 알림가 대비로 잽니다 -- 알림을 받고 산
 * 사람이 얻는 것이 그것이기 때문입니다. 표본이 쌓이기 전에는 칸당 건수부터 보세요.
 *
 *   node --env-file=.env scripts/measure-us-premarket.mjs
 */

const config = readConfig();
const { rows } = await query(config, `
  SELECT a.session_date::text AS day, a.key AS symbol, a.note,
         b.open::float8 AS open, b.high::float8 AS high, b.close::float8 AS close
    FROM alert_sent a
    LEFT JOIN us_daily_bars b ON b.symbol = a.key AND b.session_date = a.session_date
   WHERE a.kind = 'us_premarket_surge'
   ORDER BY a.session_date, a.key`);

const parsed = rows.map((row) => {
  const price = Number(row.note?.match(/@([\d.]+)/)?.[1]);
  const kind = row.note?.split("·")[1]?.trim() ?? "?";
  const turns = Number(row.note?.match(/회전 ([\d.]+)/)?.[1]);
  const pct = (value) => (Number.isFinite(value) && price > 0 ? (value / price - 1) * 100 : null);

  return { ...row, closeVsAlert: pct(row.close), highVsAlert: pct(row.high), kind, openVsAlert: pct(row.open), price, turns };
});

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const fmt = (value) => (value === null ? "   -" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`);

console.log("일자       종목   유형            알림가    시가    고가    종가(알림가 대비 %)");

for (const row of parsed) {
  console.log(`${row.day} ${row.symbol.padEnd(6)} ${row.kind.padEnd(12)} ${String(row.price).padStart(8)} ${fmt(row.openVsAlert).padStart(7)} ${fmt(row.highVsAlert).padStart(7)} ${fmt(row.closeVsAlert).padStart(7)}`);
}

const kinds = [...new Set(parsed.map((row) => row.kind))];

console.log("\n유형별(채점된 것만) · 건수 · 종가 중앙 · 종가가 알림가 위 비율");

for (const kind of kinds) {
  const scored = parsed.filter((row) => row.kind === kind && Number.isFinite(row.closeVsAlert));

  if (!scored.length) continue;

  const above = scored.filter((row) => row.closeVsAlert > 0).length;

  console.log(`  ${kind.padEnd(12)} ${String(scored.length).padStart(3)}건 · 종가 ${fmt(median(scored.map((row) => row.closeVsAlert)))}% · 위 ${Math.round(above / scored.length * 100)}%`);
}

process.exit(0);
