import { query } from "../db/client.mjs";

/**
 * 지분으로 이어진 상장사.
 *
 * DART 사업보고서의 타법인 출자 현황(kr_ownership_edges, 36,936 엣지)은 투자처를
 * **이름**으로만 적습니다 -- investee_symbol은 비어 있습니다. 그래서 이름을 상장
 * 목록에 대 봅니다: ㈜·주식회사·괄호 뒤를 떼고 kr_listings.name과 같으면 그 종목입니다.
 * 이름이 다르게 적힌 것(영문·옛 상호)은 놓치는데, 그건 놓치는 쪽이 낫습니다 --
 * 잘못 이은 관계사가 근거로 붙으면 다음부터 근거 줄을 안 읽게 됩니다.
 *
 * 양방향입니다. 모회사의 재료가 자회사를 움직이고(2026-09-14 위메이드 → 위메이드맥스),
 * 자회사의 재료가 모회사를 움직입니다(지분 가치). 10% 아래는 뺍니다 -- 단순 투자는
 * 뉴스가 옮겨 가지 않습니다.
 */

const minimumStakePct = 10;

/** symbols 각각에 대해 [{ symbol, name, stake_pct, role }] -- role은 상대가 나에게 무엇인가. */
export async function loadListedRelatives(config, symbols) {
  if (!symbols.length) return new Map();

  const { rows } = await query(config, `
    WITH clean AS (
      SELECT holder_symbol, stake_pct,
             trim(regexp_replace(split_part(investee_name, '(', 1), '[㈜㈔]|주식회사', '', 'g')) AS investee
        FROM kr_ownership_edges WHERE stake_pct >= $2
    )
    -- 내가 투자처인 행: 상대(holder)는 나의 모회사
    SELECT me.symbol AS of, c.holder_symbol AS symbol, l.name, c.stake_pct::float8, '모회사' AS role
      FROM kr_listings me
      JOIN clean c ON c.investee = me.name
      JOIN kr_listings l ON l.symbol = c.holder_symbol
     WHERE me.symbol = ANY($1)
    UNION
    -- 내가 보유자인 행: 상대(investee)는 나의 자회사
    SELECT c.holder_symbol AS of, l.symbol, l.name, c.stake_pct::float8, '자회사' AS role
      FROM clean c JOIN kr_listings l ON l.name = c.investee
     WHERE c.holder_symbol = ANY($1)`, [symbols, minimumStakePct]);
  const byOwner = new Map();

  for (const row of rows) {
    if (row.symbol === row.of) continue;
    if (!byOwner.has(row.of)) byOwner.set(row.of, []);
    byOwner.get(row.of).push({ name: row.name, role: row.role, stake_pct: row.stake_pct, symbol: row.symbol });
  }

  for (const list of byOwner.values()) list.sort((a, b) => b.stake_pct - a.stake_pct);

  return byOwner;
}
