import { fetchJson } from "../http.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { readZipEntry } from "./zip.mjs";

/**
 * Registered industry, used as the floor beneath the curated theme map.
 *
 * An industry is not a theme: 한화솔루션 is registered as chemicals but trades
 * on solar, and 두산 is a holding company that trades on nuclear power. So the
 * curated map always wins — this only answers for stocks it does not cover,
 * where a real sector beats "미분류".
 *
 * Lookups are per symbol and cached permanently: a company's registered
 * industry effectively never changes, and fetching all 2,700 listed names would
 * spend the daily quota to answer questions nobody asked.
 */

const corpCodeUrl = "https://opendart.fss.or.kr/api/corpCode.xml";
const companyUrl = "https://opendart.fss.or.kr/api/company.json";
const corpIndexTtlMs = 30 * 24 * 60 * 60 * 1000;

// Korean Standard Industrial Classification, longest prefix first. Mapped onto
// the same vocabulary the curated themes use so both layers read alike.
const industryThemes = [
  ["261", "반도체"],
  ["262", "전자부품·전장"],
  ["263", "전자부품·전장"],
  ["264", "통신장비"],
  ["265", "전자부품·전장"],
  ["266", "전자부품·전장"],
  ["311", "조선"],
  ["313", "항공우주"],
  ["10", "소비재"],
  ["11", "소비재"],
  ["13", "소비재"],
  ["14", "소비재"],
  ["15", "소비재"],
  ["17", "원자재"],
  ["19", "화학·에너지"],
  ["20", "화학·에너지"],
  ["21", "바이오"],
  ["22", "원자재"],
  ["23", "인프라 투자"],
  ["24", "원자재"],
  ["25", "원자재"],
  ["27", "바이오"],
  ["28", "전력기기"],
  ["29", "기계·장비"],
  ["30", "자동차·전장"],
  ["31", "조선"],
  ["32", "소비재"],
  ["33", "소비재"],
  ["35", "전력기기"],
  ["41", "인프라 투자"],
  ["42", "인프라 투자"],
  ["46", "소비재"],
  ["47", "소비재"],
  ["49", "운임 반등"],
  ["50", "운임 반등"],
  ["51", "운임 반등"],
  ["52", "운임 반등"],
  ["58", "게임·엔터"],
  ["59", "게임·엔터"],
  ["61", "통신장비"],
  ["62", "AI·소프트웨어"],
  ["63", "AI·소프트웨어"],
  ["64", "금리 수혜"],
  ["65", "금리 수혜"],
  ["66", "금리 수혜"],
  ["68", "인프라 투자"],
  ["70", "바이오"],
  ["71", "AI·소프트웨어"],
  ["72", "AI·소프트웨어"],
  ["73", "AI·소프트웨어"]
];

const corpIndex = createRuntimeState("dart-corp-index", () => ({ fetchedAt: 0, byStockCode: {} }));
const industries = createRuntimeState("dart-industry-map", () => ({ bySymbol: {} }));

export function themeForIndustryCode(code) {
  const normalized = String(code ?? "").trim();

  if (!normalized) return undefined;

  return industryThemes.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

async function loadCorpIndex(config) {
  const cached = await corpIndex.read();

  if (Object.keys(cached.byStockCode).length > 0 && Date.now() - cached.fetchedAt < corpIndexTtlMs) {
    return cached.byStockCode;
  }

  const response = await fetch(`${corpCodeUrl}?crtfc_key=${config.dart.apiKey}`);

  if (!response.ok) throw new Error(`DART corpCode ${response.status}`);

  const xml = readZipEntry(Buffer.from(await response.arrayBuffer()), (name) => name.toUpperCase().endsWith(".XML"));

  if (!xml) throw new Error("DART corpCode archive has no XML entry");

  const byStockCode = {};

  for (const match of xml.toString("utf8").matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const entry = match[1];
    const stockCode = entry.match(/<stock_code>\s*([^<\s]+)\s*<\/stock_code>/)?.[1];
    const corpCode = entry.match(/<corp_code>\s*([^<\s]+)\s*<\/corp_code>/)?.[1];

    // Most rows are unlisted companies, which carry no stock code.
    if (stockCode && corpCode) byStockCode[stockCode] = corpCode;
  }

  await corpIndex.save({ fetchedAt: Date.now(), byStockCode });

  return byStockCode;
}

/**
 * Fills in a theme for symbols the curated map does not cover.
 * Unknown symbols are remembered as such so they are not looked up again.
 */
export async function resolveIndustryThemes(config, symbols) {
  if (!config.dart.apiKey || symbols.length === 0) return {};

  const cached = await industries.read();
  const missing = symbols.filter((symbol) => cached.bySymbol[symbol] === undefined);
  const resolved = { ...cached.bySymbol };

  if (missing.length > 0) {
    const byStockCode = await loadCorpIndex(config);

    for (const symbol of missing) {
      const corpCode = byStockCode[symbol];

      if (!corpCode) {
        resolved[symbol] = null;
        continue;
      }

      try {
        const company = await fetchJson(`${companyUrl}?crtfc_key=${config.dart.apiKey}&corp_code=${corpCode}`, { timeoutMs: 5000 });

        resolved[symbol] = company?.status === "000" && company.induty_code
          ? { industryCode: company.induty_code, theme: themeForIndustryCode(company.induty_code) ?? null }
          : null;
      } catch {
        // Leave it unresolved so a transient failure is retried next time.
      }
    }

    await industries.save({ bySymbol: resolved });
  }

  return Object.fromEntries(
    symbols.flatMap((symbol) => resolved[symbol]?.theme ? [[symbol, resolved[symbol].theme]] : [])
  );
}
