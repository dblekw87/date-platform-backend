import { query } from "../db/client.mjs";

/**
 * 8-K 항목 코드(items) 채우기.
 *
 * `us_filings`는 접수 목록에서 오므로 서식 종류까지만 알고, "어떤 8-K인가"(2.02 실적,
 * 5.02 임원, **3.01 상장유지요건 미달**)는 SEC submissions API를 회사(CIK)마다 한 번
 * 물어야 나옵니다. 그 응답은 그 회사의 최근 신고 전체를 항목 코드와 함께 줍니다.
 *
 * 처음엔 스크립트 하나가 CIK를 한 번씩 훑고 끝이었습니다 -- 진행표에 적힌 CIK는 다시
 * 안 봤습니다. 그래서 2026-09-09에 접수는 09-08까지 있는데 items는 08-26까지였고,
 * 최근 14일 8-K 1,585건이 비어 있었습니다. 3.01 통지가 급등의 8배 신호라는 걸 재놓고
 * ([[us-delist-risk-finding]]) 정작 새 통지를 못 보는 상태였습니다.
 *
 * 그래서 둘로 나눕니다. `recentItemTargets`는 **최근에 8-K를 냈는데 items가 빈 CIK**를
 * 최신순으로 고르고, `fillFilingItems`는 그것을 초당 8건으로 채웁니다. 스케줄러가
 * 매시 최근 3일치를 부르므로 새 통지는 한 시간 안에 보입니다.
 *
 * SEC 공표 한도는 초당 10건입니다. 8로 둡니다 -- 한도에 붙여 놓으면 한 번의 지연이
 * 곧 차단이고, 차단되면 IP 단위라 다른 수집까지 같이 멈춥니다.
 */

const perSecond = 8;

export async function recentItemTargets(config, { days = 3, limit = 400 } = {}) {
  const { rows } = await query(config, `
    SELECT f.cik, max(f.filed_date) AS latest
      FROM us_filings f
      JOIN us_tickers t ON t.cik = f.cik AND t.active
     WHERE f.form_type LIKE '8-K%' AND f.items IS NULL
       AND f.filed_date >= current_date - $1::int
     GROUP BY f.cik
     ORDER BY max(f.filed_date) DESC
     LIMIT $2`, [days, limit]);

  return rows.map((row) => row.cik);
}

export async function fetchItemsForCik(config, cik) {
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
     WHERE f.accession = v.accession AND f.items IS DISTINCT FROM v.items`,
    [accessions, items]);

  return { seen: accessions.length, updated: result.rowCount ?? 0 };
}

/** 창 단위로 흘립니다. 매 요청마다 재우면 응답 시간만큼 느려지고, 한꺼번에 던지면 한도를 넘습니다. */
export async function fillFilingItems(config, ciks, { log = () => {} } = {}) {
  let done = 0;
  let filled = 0;
  let failed = 0;
  const started = Date.now();

  for (let i = 0; i < ciks.length; i += perSecond) {
    const slice = ciks.slice(i, i + perSecond);
    const tick = Date.now();

    await Promise.all(slice.map(async (cik) => {
      try {
        const { seen, updated } = await fetchItemsForCik(config, cik);

        filled += updated;
        await query(config, `
          INSERT INTO us_filing_item_progress (cik, filings_seen, items_filled)
          VALUES ($1, $2, $3)
          ON CONFLICT (cik) DO UPDATE SET checked_at = now(),
            filings_seen = EXCLUDED.filings_seen, items_filled = EXCLUDED.items_filled`,
          [cik, seen, updated]);
      } catch (error) {
        failed += 1;
        // 실패한 CIK는 진행 표에 안 적습니다 -- 다음 실행에서 다시 시도합니다.
        if (failed <= 5) log(`CIK ${cik} 실패: ${error instanceof Error ? error.message : error}`);
      }

      done += 1;
    }));

    if (done % 400 < perSecond) {
      const rate = done / ((Date.now() - started) / 1000);

      log(`${done.toLocaleString("ko-KR")}/${ciks.length.toLocaleString("ko-KR")} · 채움 ${filled.toLocaleString("ko-KR")} · 실패 ${failed} · 초당 ${rate.toFixed(1)}`);
    }

    const spent = Date.now() - tick;

    if (spent < 1000) await new Promise((resolve) => setTimeout(resolve, 1000 - spent));
  }

  return { done, failed, filled };
}
