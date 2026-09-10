import { loadCorpIndex } from "../src/providers/industry.mjs";
import { aliasAppears, aliasFromEnglishName } from "../src/providers/symbol-alias.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 영문 상호를 별칭으로 만들어 저장합니다.
 *
 *   npm run kr:aliases            -- 재보기만 하고 쓰지 않음
 *   npm run kr:aliases -- --apply -- 저장
 *
 * DART corpCode의 `corp_eng_name`에서 법인 접미사를 떼고, **우리 뉴스 코퍼스에서
 * 실제로 몇 건에 걸리는지 세어** 너무 흔한 것은 버립니다. 모양만 보고 거르면
 * "GREEN"은 잡아도 "NICE"는 놓치고, 빈도만 보면 이번 달에 우연히 조용했던
 * 평범한 낱말이 통과합니다. 두 겹 다 통과해야 별칭이 됩니다.
 *
 * 왜 필요한지는 `src/providers/symbol-alias.mjs`와 마이그레이션 034에 적었습니다 --
 * 짧게는, S2W로만 쓴 기사 다섯 건 때문에 에스투더블유가 재료 없는 종목이 됐습니다.
 *
 * 한 달에 한 번쯤 다시 돌리면 됩니다. 신규 상장이 들어오는 것 말고는 변하지
 * 않습니다. `source='dart-eng'`인 행만 갱신하므로 손으로 넣은 별칭은 남습니다.
 */

// 이 이상 걸리면 회사 이름이 아니라 낱말입니다. 2026-09-11 한 달치 4.4만 건에서
// 가장 많이 걸린 것이 S-Oil 43건(진짜 종목)이었으니, 이 문턱은 오늘 아무것도
// 거르지 않습니다 -- 다음 갱신 때 평범한 낱말이 들어오는 것을 막는 그물입니다.
const maximumCorpusHits = 300;

const config = readConfig();
const apply = process.argv.includes("--apply");

const corpIndex = await loadCorpIndex(config);
const candidates = [];

for (const [symbol, entry] of Object.entries(corpIndex)) {
  const alias = aliasFromEnglishName(entry?.englishName);

  if (alias) candidates.push({ alias, englishName: entry.englishName, symbol });
}

console.log("");
console.log(`DART 상장 ${Object.keys(corpIndex).length}종목 · 모양을 통과한 별칭 ${candidates.length}개`);

// 같은 별칭이 두 종목에 붙으면 어느 쪽인지 알 수 없습니다. 둘 다 버립니다 --
// 하나를 고르는 규칙이 있어야 하는데, 그 규칙을 세울 근거가 없습니다.
const byAlias = new Map();

for (const row of candidates) {
  const key = row.alias.toLowerCase();

  byAlias.set(key, [...(byAlias.get(key) ?? []), row]);
}

const shared = [...byAlias.values()].filter((rows) => rows.length > 1);
const unique = [...byAlias.values()].filter((rows) => rows.length === 1).map((rows) => rows[0]);

if (shared.length > 0) {
  console.log(`  겹쳐서 버림 ${shared.length}개 · ${shared.slice(0, 5).map((rows) => `${rows[0].alias}(${rows.map((row) => row.symbol).join(",")})`).join(" · ")}`);
}

/*
 * 코퍼스에서 몇 건에 걸리는가.
 *
 * 별칭마다 6.7만 건을 훑으면 4천 × 6.7만입니다. 대신 라틴 낱말만 뽑아 역색인을
 * 만들고, 별칭의 낱말이 든 기사만 확인합니다. 한글 기사에 섞인 영문 낱말은
 * 드물어서 목록이 짧습니다.
 */
const { rows: headlines } = await query(config, `
  SELECT DISTINCT headline FROM market_news_items WHERE region = 'KR'
`);

console.log(`  코퍼스 ${headlines.length}건으로 빈도 측정`);

const postings = new Map();

headlines.forEach((row, index) => {
  const seen = new Set(String(row.headline).toLowerCase().match(/[a-z0-9&\-]+/g) ?? []);

  for (const token of seen) {
    if (token.length < 2) continue;

    const held = postings.get(token);

    if (held) held.push(index);
    else postings.set(token, [index]);
  }
});

const lowerHeadlines = headlines.map((row) => String(row.headline).toLowerCase());
const measured = [];

for (const row of unique) {
  const alias = row.alias.toLowerCase();
  const tokens = alias.match(/[a-z0-9&\-]+/g) ?? [];
  // 가장 드문 낱말이 든 기사만 확인하면 됩니다. 나머지는 그 안에 있습니다.
  const rarest = tokens
    .map((token) => postings.get(token) ?? [])
    .sort((left, right) => left.length - right.length)[0] ?? [];
  let hits = 0;

  for (const index of rarest) {
    if (aliasAppears(lowerHeadlines[index], alias)) hits += 1;
  }

  measured.push({ ...row, hits });
}

const tooCommon = measured.filter((row) => row.hits > maximumCorpusHits).sort((left, right) => right.hits - left.hits);
const keep = measured.filter((row) => row.hits <= maximumCorpusHits);

console.log("");
console.log(`흔해서 버림 ${tooCommon.length}개 (${maximumCorpusHits}건 초과)`);
tooCommon.slice(0, 15).forEach((row) => console.log(`  ${String(row.hits).padStart(5)}건  ${row.alias}  (${row.symbol})`));

console.log("");
console.log(`남긴 별칭 ${keep.length}개 · 그중 코퍼스에 실제로 나온 것 ${keep.filter((row) => row.hits > 0).length}개`);
keep.filter((row) => row.hits > 0).sort((left, right) => right.hits - left.hits).slice(0, 20)
  .forEach((row) => console.log(`  ${String(row.hits).padStart(5)}건  ${row.alias}  (${row.symbol})`));

if (!apply) {
  console.log("");
  console.log("재보기만 했습니다. 저장하려면 --apply를 붙이세요.");
  process.exit(0);
}

const result = await query(config, `
  INSERT INTO kr_symbol_aliases (symbol, alias, source, corpus_hits)
  SELECT symbol, alias, 'dart-eng', hits
    FROM unnest($1::text[], $2::text[], $3::int[]) AS t(symbol, alias, hits)
  ON CONFLICT (symbol, alias) DO UPDATE SET corpus_hits = EXCLUDED.corpus_hits
`, [keep.map((row) => row.symbol), keep.map((row) => row.alias), keep.map((row) => row.hits)]);

// 이번에 빠진 것은 지웁니다 -- 규칙이 바뀌었거나 흔해진 별칭이 남아 계속
// 오태깅하면 안 됩니다. 손으로 넣은 별칭(source가 다른 것)은 건드리지 않습니다.
const removed = await query(config, `
  DELETE FROM kr_symbol_aliases
   WHERE source = 'dart-eng' AND NOT (alias = ANY($1::text[]))
`, [keep.map((row) => row.alias)]);

console.log("");
console.log(`저장 ${result.rowCount}개 · 지운 것 ${removed.rowCount}개`);

process.exit(0);
