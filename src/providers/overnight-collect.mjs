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
    SELECT s AS symbol, published_at, headline, source, original_url
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND published_at >= $1 AND published_at < $2`,
    [window.from, window.to]);

  const filings = await query(config, `
    SELECT symbol, filed_at, report_name, title, original_url
      FROM market_disclosures
     WHERE market = 'KR' AND symbol IS NOT NULL
       AND filed_at >= $1 AND filed_at < $2`,
    [window.from, window.to]);

  /*
   * 직전 장중에 이미 다뤄진 종목.
   *
   * 창 안의 기사와 따로 셉니다. 같은 종목에 마감 뒤 기사가 붙었더라도, 낮에 이미
   * 열 건이 돌던 종목이면 그것은 새로 나온 사실이 아니라 하던 얘기의 연장입니다.
   * 그 둘이 다음 장에서 반대로 움직입니다 -- measure-overnight-news.mjs 참고.
   */
  const covered = await query(config, `
    SELECT s AS symbol, headline
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND published_at >= $1 AND published_at < $2`,
    [window.sessionFrom, window.sessionTo]);

  /*
   * 낮에 무엇이 다뤄졌는지를 **낱말로** 남깁니다. 종목 단위 참/거짓이었는데, 그러면
   * 2026-09-08 한화오션이 막힙니다 -- 낮 기사는 VLGC 수주·소송이었고 18:55 기사는
   * 태국 호위함 확정이라 다른 재료인데, 같은 종목이라 "이어진 것"으로 묶였습니다.
   * 그날 밤 그 기사가 그 주의 가장 큰 재료였습니다. 낱말을 들고 있으면 rank 쪽이
   * "같은 얘기인가"를 물을 수 있습니다.
   */
  const coveredInSession = new Set(covered.rows.map((row) => row.symbol));
  const coveredTokens = new Map();

  for (const row of covered.rows) {
    if (!coveredTokens.has(row.symbol)) coveredTokens.set(row.symbol, new Set());
    for (const token of storyTokens(row.headline)) coveredTokens.get(row.symbol).add(token);
  }
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
        coveredInSession: coveredInSession.has(symbol),
        coveredTokens: coveredTokens.get(symbol) ?? new Set(),
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

/*
 * 기사 제목의 낱말. 두 글자 이상, 한글·영숫자만. "같은 얘기인가"를 재는 데 쓰므로
 * 숫자나 단위 같은 것은 빼고, 회사 이름은 부르는 쪽에서 뺍니다.
 */
export function storyTokens(headline) {
  return new Set(
    String(headline ?? "")
      .split(/[^가-힣A-Za-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !/^\d+$/.test(token))
  );
}
