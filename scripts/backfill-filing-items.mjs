import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 8-K 항목 코드를 채웁니다.
 *
 *   node scripts/backfill-filing-items.mjs [--limit 500]
 *
 * `us_filings`는 서식 종류까지만 갖고 있어서 실적 발표(2.02)와 임원 변경(5.02)이
 * 같은 "8-K"로 뭉갭니다. 2026-08-26 측정에서 8-K가 전 회전율 구간에서 1.0x였던
 * 것이 그 때문일 수 있습니다 -- 종류를 나눈 424B4는 같은 조건에서 20배였습니다.
 *
 * SEC submissions API는 회사 하나당 한 번 물으면 최근 신고 전체를 항목 코드와 함께
 * 줍니다. 5,470개 CIK, 초당 8건으로 11분입니다.
 *
 * 진행 상황을 표에 적습니다. 중간에 끊겨도 이어서 하고, 이미 훑은 CIK는 건너뜁니다.
 *
 * 왜 이걸 하냐면 -- 뉴스가 초소형주에 안 닿기 때문입니다. 2026-08-12 이후 급등한
 * 123종목 중 우리 뉴스 피드가 다룬 것은 2개(AMLX, MRNA)뿐이었습니다. SEC는 신고
 * 의무라 전 종목이 빠짐없이 들어옵니다. 커버리지를 뉴스가 아니라 여기서 얻습니다.
 */

const config = readConfig();
const args = process.argv.slice(2);
const at = args.indexOf("--limit");
const limit = at >= 0 && args[at + 1] ? Number(args[at + 1]) : 6000;
// SEC 공표 한도는 초당 10건입니다. 8로 둡니다 -- 한도에 붙여 놓으면 한 번의
// 지연이 곧 차단이고, 차단되면 IP 단위라 다른 수집까지 같이 멈춥니다.
const perSecond = 8;

const { rows: targets } = await query(config, `
  SELECT DISTINCT f.cik
    FROM us_filings f
    JOIN us_tickers t ON t.cik = f.cik AND t.active
   WHERE f.form_type LIKE '8-K%' AND f.filed_date >= '2024-08-01'
     AND NOT EXISTS (SELECT 1 FROM us_filing_item_progress p WHERE p.cik = f.cik)
   ORDER BY f.cik
   LIMIT $1
`, [limit]);

console.log(`\n남은 CIK ${targets.length.toLocaleString("ko-KR")}개 · 초당 ${perSecond}건 · 예상 ${Math.round(targets.length / perSecond / 60)}분\n`);

let done = 0, filled = 0, failed = 0;
const started = Date.now();

async function fetchOne(cik) {
  const padded = String(cik).padStart(10, "0");
  const res = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate", "User-Agent": config.sec.userAgent }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const recent = (await res.json())?.filings?.recent;

  if (!recent?.accessionNumber) return { seen: 0, updated: 0 };

  const accessions = [];
  const items = [];

  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    // 항목 코드는 8-K에만 붙습니다. 나머지는 빈 문자열이라 넣을 것이 없습니다.
    if (!String(recent.form[i] ?? "").startsWith("8-K")) continue;
    if (!recent.items?.[i]) continue;

    accessions.push(recent.accessionNumber[i]);
    items.push(recent.items[i]);
  }

  if (accessions.length === 0) return { seen: 0, updated: 0 };

  const result = await query(config, `
    UPDATE us_filings f
       SET items = v.items
      FROM unnest($1::text[], $2::text[]) AS v(accession, items)
     WHERE f.accession = v.accession AND f.items IS DISTINCT FROM v.items
  `, [accessions, items]);

  return { seen: accessions.length, updated: result.rowCount ?? 0 };
}

// 창 단위로 흘립니다. 매 요청마다 재우면 응답 시간만큼 느려지고, 한꺼번에 던지면
// 한도를 넘습니다.
for (let i = 0; i < targets.length; i += perSecond) {
  const slice = targets.slice(i, i + perSecond);
  const tick = Date.now();

  await Promise.all(slice.map(async ({ cik }) => {
    try {
      const { seen, updated } = await fetchOne(cik);

      filled += updated;
      await query(config, `
        INSERT INTO us_filing_item_progress (cik, filings_seen, items_filled)
        VALUES ($1, $2, $3)
        ON CONFLICT (cik) DO UPDATE SET checked_at = now(),
          filings_seen = EXCLUDED.filings_seen, items_filled = EXCLUDED.items_filled
      `, [cik, seen, updated]);
    } catch (error) {
      failed += 1;
      // 실패한 CIK는 진행 표에 안 적습니다 -- 다음 실행에서 다시 시도합니다.
      if (failed <= 5) console.warn(`  CIK ${cik} 실패: ${error instanceof Error ? error.message : error}`);
    }

    done += 1;
  }));

  if (done % 400 < perSecond) {
    const rate = done / ((Date.now() - started) / 1000);

    console.log(`  ${done.toLocaleString("ko-KR")}/${targets.length.toLocaleString("ko-KR")} · 채움 ${filled.toLocaleString("ko-KR")}건 · 실패 ${failed} · ${rate.toFixed(1)}/초`);
  }

  const spent = Date.now() - tick;

  if (spent < 1000) await new Promise((r) => setTimeout(r, 1000 - spent));
}

console.log(`\n끝 · CIK ${done.toLocaleString("ko-KR")}개 · 항목 채운 신고 ${filled.toLocaleString("ko-KR")}건 · 실패 ${failed}개\n`);
process.exit(0);
