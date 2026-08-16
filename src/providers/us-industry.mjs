import { query } from "../db/client.mjs";
import { fetchJson } from "../http.mjs";

/**
 * Registered industry for US companies, used as the floor beneath the curated
 * theme map — the same job industry.mjs does for domestic names via DART.
 *
 * An industry is not a theme. Sandisk registers as "Computer Storage Devices"
 * and trades as memory; the curated map has to keep winning, exactly as it does
 * against KSIC for 한화솔루션. This only answers where the map stayed silent.
 *
 * What it answers is worth having. Applied Optoelectronics is SIC 3674, the same
 * code Micron carries, and was showing as 개별 종목 on a day semiconductors led.
 *
 * SEC serves this without an API key — a User-Agent is the whole requirement —
 * and us_tickers already stores the CIK, so nothing new has to be fetched to
 * know who to ask about.
 */

const submissionsUrl = "https://data.sec.gov/submissions";

// SEC asks for no more than ten requests a second. This is well inside it and
// only matters on a cold cache; once backfilled, board builds ask for nothing.
const requestSpacingMs = 130;

// A cold cache must not hold up a board build. The backfill script fills the
// table in bulk; this is only here so the first request after a new listing
// resolves eventually rather than all at once.
const maxLookupsPerCall = 25;

/**
 * SIC prefix to the vocabulary the curated themes already use, longest prefix
 * first so a four digit rule beats the major group above it.
 *
 * The hazard is the same one KSIC divisions have: a two digit prefix swallows
 * everything beneath it, and SIC majors are drawn along regulatory lines rather
 * than the lines a trader groups stocks by. Major 28 is "Chemicals & Allied
 * Products" and contains both Dow and Moderna, so it is split at 283 — every
 * drug and biologic sits there, and mapping the major alone would have filed
 * half the biotech market under 화학·에너지.
 *
 * Major 87 has the same shape: 8731 is commercial physical and biological
 * research, which is where a large part of clinical-stage biotech registers,
 * while the rest of 87 is engineering and accounting firms.
 */
const sicThemes = [
  // Split out of major 35, which is otherwise industrial machinery.
  ["3559", "반도체"],
  ["3576", "통신장비"],
  // Split out of major 36, electronic equipment.
  ["3672", "전자부품·전장"],
  ["3674", "반도체"],
  ["3675", "MLCC·전자부품"],
  ["3691", "2차전지"],
  // Split out of major 38, instruments: optical and photographic goods are not
  // the same trade as the measuring instruments the major is named for.
  ["3826", "의료기기"],
  ["3827", "광학·카메라"],
  ["3861", "광학·카메라"],
  // Majors 50 and 51 are wholesale, which is mostly consumer goods and is
  // mapped that way. These four are distributors of things the board already
  // has a better word for, and reading Arrow Electronics as 소비재 would be
  // the same mistake as reading a fabless chip designer as one.
  ["5045", "전자부품·전장"],
  ["5047", "바이오"],
  ["5065", "전자부품·전장"],
  ["5122", "바이오"],
  // Catalog and mail-order houses, which is where the large e-commerce names
  // register.
  ["5961", "AI 커머스"],
  // A catch-all inside major 61 that reads closer to fintech than to lending.
  ["6199", "핀테크 결제"],
  // Blank check companies. Left unmapped on purpose: a SPAC has no business to
  // put in a sector, and themes.mjs already screens them out by name.
  ["6770", undefined],
  ["7375", "AI 검색"],
  ["8731", "바이오"],
  ["283", "바이오"],
  // Transmission and distribution equipment — transformers and switchgear. The
  // major above it is electronics broadly, which is not the same trade, and
  // this is the one theme the domestic map had that this one could not say.
  ["361", "전력기기"],
  ["357", "전자부품·전장"],
  ["366", "통신장비"],
  ["371", "자동차·전장"],
  ["372", "항공우주"],
  ["373", "조선"],
  ["376", "방산"],
  ["384", "의료기기"],
  ["483", "게임·엔터"],
  ["484", "게임·엔터"],
  ["737", "AI·소프트웨어"],
  ["871", "인프라 투자"],
  ["01", "소비재"],
  ["02", "소비재"],
  ["07", "소비재"],
  ["08", "원자재"],
  ["09", "소비재"],
  ["10", "원자재"],
  ["12", "화학·에너지"],
  ["13", "화학·에너지"],
  ["14", "원자재"],
  ["15", "인프라 투자"],
  ["16", "인프라 투자"],
  ["17", "인프라 투자"],
  ["20", "소비재"],
  ["21", "소비재"],
  ["22", "소비재"],
  ["23", "소비재"],
  ["24", "원자재"],
  ["25", "소비재"],
  ["26", "원자재"],
  ["27", "게임·엔터"],
  ["28", "화학·에너지"],
  ["29", "화학·에너지"],
  ["30", "원자재"],
  ["31", "소비재"],
  ["32", "원자재"],
  ["33", "원자재"],
  ["34", "기계·장비"],
  ["35", "기계·장비"],
  ["36", "전자부품·전장"],
  ["37", "기계·장비"],
  ["38", "정밀기기"],
  ["39", "소비재"],
  // Split the way the domestic map splits it, and for its reason: 운임 반등 is a
  // shipping-rate theme, so it stays on water transport. Railroads and truckers
  // were riding a name that describes neither, and an airline is its own trade.
  ["40", "물류·운송"],
  ["41", "물류·운송"],
  ["42", "물류·운송"],
  ["44", "운임 반등"],
  ["45", "항공운송"],
  ["46", "화학·에너지"],
  ["47", "물류·운송"],
  ["48", "통신서비스"],
  // Supplying power is not making the equipment — the same line KSIC 35 draws
  // against KSIC 28.
  ["49", "전력·유틸리티"],
  ["50", "소비재"],
  ["51", "소비재"],
  ["52", "소비재"],
  ["53", "소비재"],
  ["54", "소비재"],
  ["55", "소비재"],
  ["56", "소비재"],
  ["57", "소비재"],
  ["58", "소비재"],
  ["59", "소비재"],
  ["60", "금리 수혜"],
  ["61", "금리 수혜"],
  ["62", "금리 수혜"],
  ["63", "금리 수혜"],
  ["64", "금리 수혜"],
  ["65", "인프라 투자"],
  ["67", "금리 수혜"],
  ["70", "소비재"],
  ["72", "소비재"],
  ["73", "AI·소프트웨어"],
  ["75", "자동차·전장"],
  ["78", "게임·엔터"],
  ["79", "게임·엔터"],
  ["80", "바이오"],
  ["82", "소비재"],
  ["83", "소비재"],
  ["87", "AI·소프트웨어"]
];

export function themeForSicCode(code) {
  const normalized = String(code ?? "").trim();

  if (!normalized) return undefined;

  return sicThemes.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

/** Latest known CIK for each symbol, which is what SEC is keyed by. */
async function readCiks(config, symbols) {
  const result = await query(
    config,
    `SELECT DISTINCT ON (symbol) symbol, cik
       FROM us_tickers
      WHERE symbol = ANY($1) AND cik IS NOT NULL
      ORDER BY symbol, as_of DESC`,
    [symbols]
  );

  return new Map(result.rows.map((row) => [row.symbol, Number(row.cik)]));
}

async function readStoredIndustries(config, ciks) {
  if (ciks.length === 0) return new Map();

  const result = await query(config, "SELECT cik, sic FROM us_company_industry WHERE cik = ANY($1)", [ciks]);

  return new Map(result.rows.map((row) => [Number(row.cik), row.sic]));
}

/**
 * Asks SEC what business one company is in and records the answer.
 *
 * A company that answers without an SIC is still written, with a null code, so
 * the miss is remembered — otherwise every board build would ask again about
 * the same trusts and shells that will never have one.
 */
export async function recordCompanyIndustry(config, cik) {
  const padded = String(cik).padStart(10, "0");
  const submission = await fetchJson(`${submissionsUrl}/CIK${padded}.json`, {
    headers: { "User-Agent": config.sec.userAgent },
    timeoutMs: 8000
  });
  const sic = String(submission?.sic ?? "").trim() || null;

  await query(
    config,
    `INSERT INTO us_company_industry (cik, sic, sic_description, checked_at)
          VALUES ($1, $2, $3, now())
     ON CONFLICT (cik) DO UPDATE
            SET sic = EXCLUDED.sic,
                sic_description = EXCLUDED.sic_description,
                checked_at = now()`,
    [cik, sic, String(submission?.sicDescription ?? "").trim() || null]
  );

  return sic;
}

/**
 * Fills in a theme for US symbols the curated map does not cover.
 *
 * Returns only the symbols an industry could actually be found for, so a caller
 * can treat a missing key the same way it treats a symbol it never asked about.
 */
export async function resolveUsIndustryThemes(config, symbols) {
  if (symbols.length === 0) return {};

  const ciks = await readCiks(config, symbols);
  const stored = await readStoredIndustries(config, [...new Set(ciks.values())]);
  const missing = [...new Set(ciks.values())].filter((cik) => !stored.has(cik)).slice(0, maxLookupsPerCall);

  for (const cik of missing) {
    try {
      stored.set(cik, await recordCompanyIndustry(config, cik));
    } catch {
      // Left unstored so a transient failure is retried on the next build.
    }

    await new Promise((resolve) => setTimeout(resolve, requestSpacingMs));
  }

  return Object.fromEntries(
    symbols.flatMap((symbol) => {
      const cik = ciks.get(symbol);
      const theme = cik === undefined ? undefined : themeForSicCode(stored.get(cik));

      return theme ? [[symbol, theme]] : [];
    })
  );
}
