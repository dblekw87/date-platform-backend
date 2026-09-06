import { query } from "../db/client.mjs";
import { classifyDisclosure, classifyHeadline } from "./overnight-classify.mjs";

/**
 * 창 안의 뉴스와 공시를 종목별로 모읍니다.
 *
 * 고르는 규칙은 여기 없습니다 -- 모으기와 고르기를 갈라 둔 것은, 규칙을 고칠 때
 * 무엇을 봤는지가 같이 흔들리면 어제 뽑은 것과 오늘 뽑은 것을 견줄 수 없기
 * 때문입니다.
 */

export async function collectCandidates(config, window) {
  const news = await query(config, `
    SELECT s AS symbol, published_at, headline, source
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND published_at >= $1 AND published_at < $2`,
    [window.from, window.to]);

  const filings = await query(config, `
    SELECT symbol, filed_at, report_name, title
      FROM market_disclosures
     WHERE market = 'KR' AND symbol IS NOT NULL
       AND filed_at >= $1 AND filed_at < $2`,
    [window.from, window.to]);

  const candidates = new Map();
  const of = (symbol) => {
    if (!candidates.has(symbol)) {
      candidates.set(symbol, {
        symbol,
        material: [],
        recap: 0,
        good: [],
        dilution: [],
        bad: [],
        sources: new Set()
      });
    }

    return candidates.get(symbol);
  };

  for (const row of news.rows) {
    const kind = classifyHeadline(row.headline);
    const entry = of(row.symbol);

    if (kind === "recap") entry.recap += 1;

    if (kind === "material") {
      entry.material.push(row);
      entry.sources.add(row.source);
    }
  }

  for (const row of filings.rows) {
    const kind = classifyDisclosure(row.report_name, row.title);

    if (kind) of(row.symbol)[kind].push(row);
  }

  return candidates;
}

/*
 * 살 수 있는 종목인가.
 *
 * 판단 조건이 아니라 모집단 조건입니다 -- 거래정지된 종목이나 거래대금이 없는
 * 종목은 아무리 재료가 좋아도 주문이 안 나가므로 후보에 오르면 안 됩니다.
 * [[leader-pool-filters]]에서 판단 조건을 모집단 층에 걸었다가 화면이 조용히
 * 비었던 것의 반대 방향입니다.
 */
export async function tradableUniverse(config, sessionDate, minTurnover) {
  const { rows } = await query(config, `
    SELECT u.symbol, u.name, u.market, u.close_price::float8, u.change_rate::float8,
           u.turnover::float8, u.market_cap::float8, coalesce(f.halted, false) AS halted,
           coalesce(f.managed, false) AS managed
      FROM kr_daily_universe u
      LEFT JOIN kr_symbol_flags f ON f.symbol = u.symbol AND f.session_date = u.session_date
     WHERE u.session_date = $1 AND coalesce(u.trade_halted, false) = false
       AND u.turnover >= $2`,
    [sessionDate, minTurnover]);

  return new Map(rows.map((row) => [row.symbol, row]));
}
