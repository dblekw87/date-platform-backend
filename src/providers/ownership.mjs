import { fetchJson } from "../http.mjs";
import { query } from "../db/client.mjs";

/**
 * 지분 그래프 — the equity stakes a listed company holds, read from DART.
 *
 * This answers a question no other provider can. The board explains a move from
 * price, from theme membership, and from headlines that name the stock; none of
 * those can see that SK텔레콤 rose because a private American company it owns
 * 0.3% of was revalued. The reason is a fact about ownership, and 타법인 출자현황
 * in the annual report is where that fact lives.
 *
 * Names are all DART gives for the investee — no code, no ticker, spelled
 * however the filer typed it. So the graph is keyed on names and matching them
 * back to listed symbols is deliberately separate and best effort: the valuable
 * half is the unlisted half, which no symbol will ever match.
 */

const holdingsUrl = "https://opendart.fss.or.kr/api/otrCprInvstmntSttus.json";

// 사업보고서. The half-year and quarterly codes carry the same table, but the
// annual one is the only filing every company makes.
const annualReportCode = "11011";

// DART reports its own errors in the body with a 200 status. 013 means the
// filer has no such table — a holding company with nothing else to disclose, or
// a company that has not filed for the year asked about — which is an answer,
// not a failure.
const noDataStatus = "013";

/**
 * DART formats every figure as a thousands-separated string and writes "-" for
 * an empty cell. A negative revaluation arrives as "-1,234" — the same leading
 * character — so the dash is only an empty value when it stands alone.
 */
function toNumber(value) {
  const text = String(value ?? "").trim().replace(/,/g, "");

  if (!text || text === "-") return null;

  const numeric = Number(text);

  return Number.isFinite(numeric) ? numeric : null;
}

/** Acquisition dates arrive as 2023.08.14, and sometimes blank. */
function toDate(value) {
  const match = String(value ?? "").match(/(\d{4})\.(\d{2})\.(\d{2})/);

  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * The last row of the table is a 합계 line with no investee behind it, and the
 * filers who write it out spell it several ways.
 */
function isTotalRow(name) {
  return /^(합\s*계|소\s*계|계|total)$/i.test(String(name ?? "").trim());
}

/**
 * Every stake one company disclosed for one business year.
 * Returns an empty array when the filer has no such table.
 */
export async function loadOwnershipEdges(config, { businessYear, corpCode, holderSymbol }) {
  const url = new URL(holdingsUrl);

  url.searchParams.set("crtfc_key", config.dart.apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(businessYear));
  url.searchParams.set("reprt_code", annualReportCode);

  const response = await fetchJson(url.toString(), { timeoutMs: 8000 });

  if (response?.status === noDataStatus) return [];

  if (response?.status !== "000" || !Array.isArray(response.list)) {
    throw new Error(`DART otrCprInvstmntSttus ${response?.status ?? "unknown"} ${response?.message ?? ""}`.trim());
  }

  return response.list
    .filter((row) => row.inv_prm && !isTotalRow(row.inv_prm))
    .map((row) => ({
      bookValue: toNumber(row.trmend_blce_acntbk_amount),
      businessYear,
      firstAcquiredOn: toDate(row.frst_acqs_de),
      holderCorpCode: corpCode,
      holderSymbol,
      investeeName: String(row.inv_prm).trim(),
      investeeNetProfit: toNumber(row.recent_bsns_year_fnnr_sttus_thstrm_ntpf),
      investeeTotalAssets: toNumber(row.recent_bsns_year_fnnr_sttus_tot_assets),
      purpose: String(row.invstmnt_purps ?? "").trim() || null,
      receiptNo: row.rcept_no ?? null,
      stakePct: toNumber(row.trmend_blce_qota_rt),
      valuationChange: toNumber(row.incrs_dcrs_evl_lstmn)
    }));
}

/**
 * Writes one filer's stakes. Re-running a year overwrites it, because a filing
 * can be amended and the amended figures are the ones worth keeping.
 */
export async function saveOwnershipEdges(config, edges) {
  let saved = 0;

  for (const edge of edges) {
    const result = await query(
      config,
      `INSERT INTO kr_ownership_edges (
              holder_symbol, business_year, investee_name, holder_corp_code,
              first_acquired_on, purpose, stake_pct, book_value, valuation_change,
              investee_total_assets, investee_net_profit, receipt_no, checked_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (holder_symbol, business_year, investee_name) DO UPDATE
              SET holder_corp_code = EXCLUDED.holder_corp_code,
                  first_acquired_on = EXCLUDED.first_acquired_on,
                  purpose = EXCLUDED.purpose,
                  stake_pct = EXCLUDED.stake_pct,
                  book_value = EXCLUDED.book_value,
                  valuation_change = EXCLUDED.valuation_change,
                  investee_total_assets = EXCLUDED.investee_total_assets,
                  investee_net_profit = EXCLUDED.investee_net_profit,
                  receipt_no = EXCLUDED.receipt_no,
                  checked_at = now()`,
      [
        edge.holderSymbol,
        edge.businessYear,
        edge.investeeName,
        edge.holderCorpCode,
        edge.firstAcquiredOn,
        edge.purpose,
        edge.stakePct,
        edge.bookValue,
        edge.valuationChange,
        edge.investeeTotalAssets,
        edge.investeeNetProfit,
        edge.receiptNo
      ]
    );

    saved += result.rowCount;
  }

  return saved;
}

/**
 * The stakes behind one stock, largest revaluation first — the order that puts
 * the reason it moved at the top.
 */
export async function readOwnershipEdges(config, holderSymbol, businessYear) {
  const result = await query(
    config,
    `SELECT investee_name, investee_symbol, stake_pct, book_value, valuation_change, purpose, first_acquired_on
       FROM kr_ownership_edges
      WHERE holder_symbol = $1 AND business_year = $2
      ORDER BY valuation_change DESC NULLS LAST`,
    [holderSymbol, businessYear]
  );

  return result.rows;
}

/**
 * The other direction: which listed companies hold a piece of something named
 * in the news. Matched on the disclosed name, which is all DART gives, so this
 * takes a pattern rather than an identifier — "앤트로픽" and "Anthropic" are the
 * same company to a reader and two unrelated strings to a database.
 */
export async function readHoldersOf(config, namePattern, businessYear) {
  const result = await query(
    config,
    `SELECT holder_symbol, investee_name, stake_pct, book_value, valuation_change
       FROM kr_ownership_edges
      WHERE business_year = $1 AND investee_name ILIKE $2
      ORDER BY book_value DESC NULLS LAST`,
    [businessYear, `%${namePattern}%`]
  );

  return result.rows;
}
