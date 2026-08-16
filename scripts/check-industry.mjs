import { readConfig } from "../src/config.mjs";
import { resolveCompanyNames, resolveIndustryThemes } from "../src/providers/industry.mjs";
import { createRuntimeState } from "../src/providers/runtime-state.mjs";

/**
 * What KSIC a symbol is registered under, for deciding where it belongs in the
 * curated theme map. Ad hoc by design: run it with codes, read the answer.
 */

const symbols = process.argv.slice(2);

if (symbols.length === 0) {
  console.error("usage: node scripts/check-industry.mjs 007810 222800 ...");
  process.exit(1);
}

const config = readConfig();
const [names, themes] = await Promise.all([
  resolveCompanyNames(config, symbols),
  resolveIndustryThemes(config, symbols)
]);

const { bySymbol } = await createRuntimeState("dart-industry-map", () => ({ bySymbol: {} })).read();

symbols.forEach((symbol) => {
  const code = bySymbol[symbol]?.industryCode ?? "-----";

  console.log(`${symbol}  ${(names[symbol] ?? "?").padEnd(14)}  ${code}  ${themes[symbol] ?? "미분류"}`);
});
