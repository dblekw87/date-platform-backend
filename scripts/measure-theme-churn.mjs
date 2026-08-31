/*
 * 테마 라벨이 하루에 몇 번 바뀌는지, 규칙 변형별로 되돌려 잽니다.
 *
 * 사용: node scripts/measure-theme-churn.mjs 2026-08-28
 *
 * relabelMargin과 관성 탈출구 조항을 정할 때 쓴 스크립트입니다. 결과는
 * providers/naver-themes.mjs의 관성 블록 주석에 적혀 있습니다.
 */
import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

const config = readConfig();
const day = process.argv[2];
const PATTERN = /(밸류업|기업인수목적|신규상장|리츠\(REITs\)|국내 상장 중국기업|지주사)/;
const MIN_SAMPLE = 8;

const { rows: members } = await query(config,
  `SELECT symbol, theme_name, theme_no FROM kr_theme_members`);
const business = members.filter((m) => !PATTERN.test(m.theme_name));

const themesOf = new Map();
for (const m of business) {
  if (!themesOf.has(m.symbol)) themesOf.set(m.symbol, []);
  themesOf.get(m.symbol).push({ name: m.theme_name, no: Number(m.theme_no) });
}
const membersOf = new Map();
for (const m of business) {
  if (!membersOf.has(m.theme_name)) membersOf.set(m.theme_name, []);
  membersOf.get(m.theme_name).push(m.symbol);
}

const { rows: samples } = await query(config, `
  SELECT symbol, change_rate, observed_at
    FROM market_price_samples
   WHERE market='KR' AND source LIKE 'kis:krx%' AND session_date = $1::date
     AND change_rate IS NOT NULL
   ORDER BY observed_at`, [day]);

const start = samples[0].observed_at.getTime();
const end = samples[samples.length - 1].observed_at.getTime();
const ticks = [];
for (let t = start; t <= end; t += 10 * 60_000) ticks.push(t);

// latest change_rate per symbol as of each tick
function stateAt(t) {
  const latest = new Map();
  for (const s of samples) {
    if (s.observed_at.getTime() > t) break;
    latest.set(s.symbol, Number(s.change_rate));
  }
  return latest;
}

function themeMoves(latest) {
  const market = [...latest.values()].reduce((a, b) => a + b, 0) / latest.size;
  const moves = new Map();
  for (const [theme, syms] of membersOf) {
    const vals = syms.map((s) => latest.get(s)).filter((v) => v !== undefined);
    if (vals.length < MIN_SAMPLE) continue;
    moves.set(theme, vals.reduce((a, b) => a + b, 0) / vals.length - market);
  }
  return moves;
}

function pick(symbol, moves, held, { escapeHatch, margin }) {
  const cands = themesOf.get(symbol);
  if (!cands) return held ?? null;
  const scored = cands.map((c) => ({ ...c, move: moves.has(c.name) ? moves.get(c.name) : null }));

  scored.sort((a, b) => {
    const ap = (a.move ?? 0) > 0 ? 0 : 1, bp = (b.move ?? 0) > 0 ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const am = a.move === null ? -Infinity : a.move, bm = b.move === null ? -Infinity : b.move;
    if (am !== bm) return bm - am;
    return a.no - b.no;
  });

  const won = scored[0];
  if (!held || held === won.name) return won.name;

  const heldMove = moves.has(held) ? moves.get(held) : null;
  const gateOpen = escapeHatch ? (heldMove !== null && heldMove > 0) : (heldMove !== null);
  if (gateOpen && (won.move === null || won.move - heldMove < margin)) return held;

  return won.name;
}

const variants = [
  { label: "현행 (탈출구 on, margin 1)", escapeHatch: true, margin: 1 },
  { label: "탈출구 off  (margin 1)",      escapeHatch: false, margin: 1 },
  { label: "탈출구 off  (margin 2)",      escapeHatch: false, margin: 2 },
  { label: "탈출구 off  (margin 3)",      escapeHatch: false, margin: 3 },
];

const tickMoves = ticks.map((t) => themeMoves(stateAt(t)));
const universe = [...new Set(samples.map((s) => s.symbol))].filter((s) => themesOf.has(s));

console.log(`${day} · ${universe.length} symbols · ${ticks.length} ticks`);
for (const v of variants) {
  const held = new Map();
  let flips = 0;
  const flipped = new Set();
  for (const moves of tickMoves) {
    for (const sym of universe) {
      const next = pick(sym, moves, held.get(sym) ?? null, v);
      if (held.has(sym) && held.get(sym) !== next) { flips += 1; flipped.add(sym); }
      held.set(sym, next);
    }
  }
  console.log(`  ${v.label.padEnd(28)} 라벨 바뀐 종목 ${String(flipped.size).padStart(3)}/${universe.length}` +
              ` (${(100*flipped.size/universe.length).toFixed(1)}%)  총 전환 ${flips}`);
}


// 마감 시점 라벨 -- 안정만 좋아지고 정확도가 나빠지는 건 아닌지.
const { rows: names } = await query(config,
  `SELECT DISTINCT symbol, name FROM market_price_samples WHERE market='KR' AND session_date=$1::date`, [day]);
const nameOf = new Map(names.map((r) => [r.symbol, r.name]));

const lastMoves = tickMoves[tickMoves.length - 1];
const latest = stateAt(ticks[ticks.length - 1]);
const watch = ["124500", "049470", "417010", "214330"];
const risers = [...latest.entries()].filter(([s]) => themesOf.has(s))
  .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s);

for (const v of variants) {
  const held = new Map();
  for (const moves of tickMoves)
    for (const sym of universe) held.set(sym, pick(sym, moves, held.get(sym) ?? null, v));

  console.log(`\n[${v.label}]`);
  for (const s of [...watch, ...risers]) {
    if (!nameOf.has(s)) continue;
    const lbl = held.get(s) ?? "-";
    const mv = lastMoves.has(lbl) ? lastMoves.get(lbl).toFixed(2) : "  n/a";
    console.log(`  ${(nameOf.get(s) ?? s).padEnd(16)} ${String(latest.get(s)?.toFixed(2) ?? "").padStart(7)}%  ${lbl}  (테마 ${mv}%p)`);
  }
}
process.exit(0);
