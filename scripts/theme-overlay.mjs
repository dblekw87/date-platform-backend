import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 사전이 빠뜨린 편입을 손으로 넣는 자리.
 *
 *   npm run theme:overlay -- list
 *   npm run theme:overlay -- add 솔브레인 "반도체 장비" --reason "원익IPS와 3일 동반" --days 3
 *   npm run theme:overlay -- approve 솔브레인 "반도체 장비"
 *   npm run theme:overlay -- remove 솔브레인 "반도체 장비"
 *   npm run theme:overlay -- effect
 *
 * **왜 자동이 아닌가.** 테마 귀속을 규칙으로 판정하려던 시도가 다섯 번 실패했고
 * 전부 멀쩡한 카드를 부쉈습니다. 그래서 발견은 자동(run_persistence.py가 매일
 * 공유 테마 없는 반복 쌍을 셉니다)이고 반영은 사람입니다. `approved`가 그 손잡이라,
 * 넣기만 하면 아무 일도 일어나지 않고 승인해야 화면이 봅니다.
 *
 * **kr_theme_members는 건드리지 않습니다.** 네이버 사전은 매일 다시 받아오므로
 * 고쳐도 덮어써지고, 무엇보다 우리가 넣은 것과 원본을 구분할 수 없게 됩니다.
 * 읽는 쪽은 전부 kr_theme_membership 뷰를 봅니다(032 마이그레이션).
 *
 * `effect`가 있는 이유는, 편입 하나가 짝을 몇 개나 새로 만드는지 넣기 전에는
 * 감이 안 오기 때문입니다. 테마가 큰 곳에 한 종목을 넣으면 그 종목이 회원 전부와
 * 짝이 될 수 있습니다.
 */

const config = readConfig();
const words = process.argv.slice(2);
const command = words.find((word) => !word.startsWith("--")) ?? "list";
const positional = words.filter((word) => !word.startsWith("--")).slice(1);

function flag(name) {
  const at = words.indexOf(`--${name}`);

  return at === -1 ? null : words[at + 1] ?? null;
}

function usage() {
  console.log(`
사용법
  npm run theme:overlay -- list [--all]
  npm run theme:overlay -- add <종목> <테마> --reason "왜" [--days N]
  npm run theme:overlay -- approve <종목> <테마>
  npm run theme:overlay -- remove <종목> <테마>
  npm run theme:overlay -- effect

종목은 코드(6자리)나 이름 둘 다 됩니다. 테마 이름은 사전에 있는 것과 정확히 같아야
하고, 없는 이름이면 새 테마로 만들지 물어봅니다.
`);
}

/** 이름으로도 받습니다 -- 코드를 외우고 있는 사람은 없습니다. */
async function resolveSymbol(term) {
  if (/^\d{6}$/.test(term)) return { name: null, symbol: term };

  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name
      FROM kr_daily_universe
     WHERE name = $1
     ORDER BY symbol, session_date DESC
  `, [term]);

  if (rows.length === 1) return { name: rows[0].name, symbol: rows[0].symbol };

  if (rows.length === 0) {
    const like = await query(config, `
      SELECT DISTINCT ON (symbol) symbol, name
        FROM kr_daily_universe
       WHERE name LIKE '%' || $1 || '%'
       ORDER BY symbol, session_date DESC
       LIMIT 8
    `, [term]);

    console.log(`\n'${term}'을 못 찾았습니다.`);

    if (like.rowCount > 0) {
      console.log("  비슷한 이름:");
      for (const row of like.rows) console.log(`    ${row.symbol}  ${row.name}`);
    }

    return null;
  }

  console.log(`\n'${term}'이 여러 개입니다. 코드로 지정하세요.`);
  for (const row of rows) console.log(`    ${row.symbol}  ${row.name}`);

  return null;
}

async function list() {
  const showAll = words.includes("--all");
  const { rows } = await query(config, `
    SELECT o.symbol, o.theme_name, o.reason, o.evidence_days, o.approved,
           to_char(o.added_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS added,
           (SELECT u.name FROM kr_daily_universe u
             WHERE u.symbol = o.symbol ORDER BY u.session_date DESC LIMIT 1) AS name,
           EXISTS (SELECT 1 FROM kr_theme_members m
                    WHERE m.symbol = o.symbol AND m.theme_name = o.theme_name) AS redundant
      FROM kr_theme_overlay o
     ORDER BY o.approved, o.added_at DESC
  `);

  if (rows.length === 0) {
    console.log("\noverlay가 비어 있습니다.\n");

    return;
  }

  console.log(`\noverlay ${rows.length}행\n`);

  for (const row of rows) {
    const state = row.approved ? "승인" : "대기";
    // 네이버가 나중에 같은 편입을 담으면 이 행은 아무 일도 하지 않습니다. 지워도
    // 되지만 지웠다는 사실 자체가 기록이라 알려만 줍니다.
    const note = row.redundant ? "  (사전이 이미 담음 · 무효)" : "";

    console.log(`  [${state}] ${row.name ?? row.symbol} (${row.symbol}) → ${row.theme_name}${note}`);
    console.log(`         ${row.reason} · ${row.evidence_days}일 · ${row.added}`);
  }

  if (!showAll) console.log("");
}

async function add() {
  const [term, themeName] = positional;
  const reason = flag("reason");

  if (!term || !themeName) return usage();

  if (!reason) {
    console.log("\n--reason이 필요합니다. 근거 없이 들어간 행이 없어야 합니다.\n");

    return;
  }

  const found = await resolveSymbol(term);

  if (!found) return;

  const known = await query(config,
    "SELECT count(*)::int AS members FROM kr_theme_members WHERE theme_name = $1", [themeName]);

  if (known.rows[0].members === 0) {
    console.log(`\n'${themeName}'은 사전에 없는 테마입니다. 새 테마로 만들려면 그대로 진행되지만,`);
    console.log("  이름을 잘못 적은 것이 아닌지 먼저 확인하세요 -- 사전 이름은 정확히 일치해야 합니다.\n");
  }

  await query(config, `
    INSERT INTO kr_theme_overlay (symbol, theme_name, reason, evidence_days)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (symbol, theme_name) DO UPDATE
      SET reason = EXCLUDED.reason, evidence_days = EXCLUDED.evidence_days
  `, [found.symbol, themeName, reason, Number(flag("days") ?? 0)]);

  console.log(`\n넣었습니다 (승인 대기): ${found.name ?? found.symbol} → ${themeName}`);
  console.log(`  회원 ${known.rows[0].members}종목인 테마입니다.`);
  console.log("  화면은 아직 이 행을 보지 않습니다. approve 하면 반영됩니다.\n");
}

async function approve() {
  const [term, themeName] = positional;

  if (!term || !themeName) return usage();

  const found = await resolveSymbol(term);

  if (!found) return;

  const result = await query(config, `
    UPDATE kr_theme_overlay SET approved = true
     WHERE symbol = $1 AND theme_name = $2
  `, [found.symbol, themeName]);

  if (result.rowCount === 0) {
    console.log(`\n그런 행이 없습니다: ${found.symbol} → ${themeName}\n`);

    return;
  }

  console.log(`\n승인했습니다: ${found.name ?? found.symbol} → ${themeName}`);
  // 뷰를 읽는 것은 SQL이지만 그 SQL을 들고 있는 것은 프로세스입니다. 수집기는
  // --watch 없이 돌기 때문에, 032 이전에 기동된 프로세스는 아직 옛 표를 봅니다.
  console.log("  다음 수집 틱부터 화면과 알림이 이 편입을 씁니다.");
  console.log("  (수집기가 032 마이그레이션 전에 켜져 있었다면 재기동해야 합니다:");
  console.log("   scripts\\stop-collector.ps1 → scripts\\start-collector.ps1)\n");
}

async function remove() {
  const [term, themeName] = positional;

  if (!term || !themeName) return usage();

  const found = await resolveSymbol(term);

  if (!found) return;

  const result = await query(config,
    "DELETE FROM kr_theme_overlay WHERE symbol = $1 AND theme_name = $2", [found.symbol, themeName]);

  console.log(result.rowCount === 0
    ? `\n그런 행이 없습니다: ${found.symbol} → ${themeName}\n`
    : `\n지웠습니다: ${found.name ?? found.symbol} → ${themeName}\n`);
}

/**
 * overlay가 실제로 무엇을 바꾸는지.
 *
 * 편입 하나가 만드는 짝의 수는 그 테마의 회원 수만큼입니다. 회원이 마흔인 테마에
 * 한 종목을 넣으면 짝 후보가 마흔 개 늘고, 그것이 짝꿍 패널에 그대로 나타납니다.
 */
async function effect() {
  const { rows } = await query(config, `
    SELECT o.symbol, o.theme_name, o.approved,
           (SELECT u.name FROM kr_daily_universe u
             WHERE u.symbol = o.symbol ORDER BY u.session_date DESC LIMIT 1) AS name,
           (SELECT count(*)::int FROM kr_theme_members m WHERE m.theme_name = o.theme_name) AS members
      FROM kr_theme_overlay o
     ORDER BY o.approved DESC, o.theme_name
  `);

  if (rows.length === 0) {
    console.log("\noverlay가 비어 있어 바뀌는 것이 없습니다.\n");

    return;
  }

  const view = await query(config,
    "SELECT origin, count(*)::int AS rows FROM kr_theme_membership GROUP BY origin ORDER BY origin");

  console.log("\n뷰 구성");
  for (const row of view.rows) console.log(`  ${row.origin.padEnd(8)} ${row.rows.toLocaleString("ko-KR")}행`);

  console.log("\n행마다 늘어나는 짝 후보");

  for (const row of rows) {
    const state = row.approved ? "승인" : "대기";

    console.log(`  [${state}] ${row.name ?? row.symbol} → ${row.theme_name}` +
      `  회원 ${row.members}종목이므로 짝 후보 최대 ${row.members}개`);
  }

  console.log("");
}

const commands = { add, approve, effect, list, remove };

if (!commands[command]) {
  usage();
  process.exit(1);
}

await commands[command]();
process.exit(0);
