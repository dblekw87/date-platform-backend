import { query } from "../db/client.mjs";

/**
 * 상장폐지 위험 표식 -- 미국.
 *
 * 사용자의 관찰("상폐될 위험이 있는 것들이 보통 급등하더라")을 2026-09-09에 쟀습니다.
 * 급등 6,893건(2024-08~2026-09)과 전체 종목-일 302,892건 표본:
 *
 *                        전체    급등 중    배수
 *   8-K Item 3.01 (120일)  3.0%   24.3%     8배    나스닥·NYSE 상장유지요건 미달 통지
 *   역분할 (180일)          2.5%   23.2%     9배    $1 규정을 맞추려는 감자
 *   종가 $1 미만            6.1%   38.5%     6배
 *
 *   3.01 통지 뒤 60일 안 급등  13.3% (3,686건, 중앙값 24일)
 *   아무 종목 아무 날         3.0%                    → 4.4배
 *
 * 미국 급등 측정에서 뉴스·차트·공시가 다 떨어지고 회전율만 남았는데([[us-surge-findings]]),
 * 이것은 그와 독립적인 두 번째 신호입니다. **탐지기이지 매수 신호가 아닙니다** --
 * 급등한 뒤 어떻게 되는지는 다른 질문이고([[us-nanocap-blindspot]]: 첫날 5건 전부
 * 고점 대비 -23~-61%), 여기서는 "왜 튀는가"의 표식만 답니다.
 *
 * 3.01은 us_filings.items에 있고 symbol이 없어 us_tickers의 cik로 잇습니다.
 */

const noticeWindowDays = 120;
const reverseSplitWindowDays = 180;

/** 주어진 종목들의 위험 표식. 없는 종목은 Map에 없습니다. */
export async function loadDelistRisk(config, symbols) {
  if (!symbols.length) return new Map();

  const { rows } = await query(config, `
    WITH tick AS (
      SELECT DISTINCT ON (symbol) symbol, cik FROM us_tickers
       WHERE symbol = ANY($1) AND cik IS NOT NULL ORDER BY symbol, as_of DESC
    ),
    notice AS (
      SELECT k.symbol, max(f.filed_date) AS filed
        FROM tick k JOIN us_filings f ON f.cik = k.cik
       WHERE f.items ILIKE '%3.01%' AND f.filed_date >= current_date - $2::int
       GROUP BY k.symbol
    ),
    rsplit AS (
      SELECT symbol, max(execution_date) AS executed, max(split_from) AS split_from, max(split_to) AS split_to
        FROM us_splits
       WHERE symbol = ANY($1) AND split_to < split_from AND execution_date >= current_date - $3::int
       GROUP BY symbol
    ),
    last AS (
      SELECT DISTINCT ON (symbol) symbol, close::float8 AS close FROM us_daily_bars
       WHERE symbol = ANY($1) ORDER BY symbol, session_date DESC
    )
    SELECT s AS symbol, n.filed::text AS notice_on, r.executed::text AS reverse_split_on,
           r.split_from, r.split_to, l.close
      FROM unnest($1::text[]) s
      LEFT JOIN notice n ON n.symbol = s
      LEFT JOIN rsplit r ON r.symbol = s
      LEFT JOIN last l ON l.symbol = s
     WHERE n.filed IS NOT NULL OR r.executed IS NOT NULL OR l.close < 1`,
    [symbols, noticeWindowDays, reverseSplitWindowDays]);

  return new Map(rows.map((row) => [row.symbol, {
    close: row.close,
    noticeOn: row.notice_on,
    reverseSplitOn: row.reverse_split_on,
    splitFrom: row.split_from,
    splitTo: row.split_to,
    under1: row.close !== null && row.close < 1
  }]));
}

/** 어제~오늘 새로 접수된 3.01 통지. 아침에 한 번 보내는 목록입니다. */
export async function loadNewDelistNotices(config, { sinceDays = 2, limit = 12 } = {}) {
  const { rows } = await query(config, `
    WITH tick AS (
      SELECT DISTINCT ON (cik) cik, symbol, name FROM us_tickers
       WHERE cik IS NOT NULL AND coalesce(active, true) ORDER BY cik, as_of DESC
    ),
    fresh AS (
      SELECT DISTINCT ON (f.cik) f.cik, f.filed_date, f.company_name
        FROM us_filings f
       WHERE f.items ILIKE '%3.01%' AND f.filed_date >= current_date - $1::int
       ORDER BY f.cik, f.filed_date DESC
    ),
    last AS (
      SELECT DISTINCT ON (symbol) symbol, close::float8 AS close, session_date FROM us_daily_bars
       ORDER BY symbol, session_date DESC
    )
    SELECT k.symbol, coalesce(k.name, x.company_name) AS name, x.filed_date::text AS filed_on, l.close,
           EXISTS (SELECT 1 FROM us_surge_events s WHERE s.symbol = k.symbol AND s.session_date >= x.filed_date) AS surged_already
      FROM fresh x JOIN tick k ON k.cik = x.cik
      LEFT JOIN last l ON l.symbol = k.symbol
     ORDER BY x.filed_date DESC, l.close ASC NULLS LAST
     LIMIT $2`, [sinceDays, limit]);

  return rows;
}

/** 알림에 붙는 한 줄. 표식이 없으면 빈 문자열입니다. */
export function riskLine(risk) {
  if (!risk) return "";

  const parts = [];

  if (risk.noticeOn) parts.push(`상장유지 미달 통지 ${risk.noticeOn.slice(5).replace("-", "/")}`);
  if (risk.reverseSplitOn) parts.push(`역분할 ${risk.splitFrom}:${risk.splitTo} ${risk.reverseSplitOn.slice(5).replace("-", "/")}`);
  if (risk.under1) parts.push(`$1 미만`);

  return parts.length ? `⚠ 상폐위험 · ${parts.join(" · ")}` : "";
}
