import { readConfig } from "../src/config.mjs";
import { refreshThemes } from "../src/providers/naver-themes.mjs";

/**
 * Refreshes the 네이버 금융 theme dictionary.
 *
 * About 280 themes with their members, which is 287 requests spaced out - a few
 * minutes. Weekly is plenty: membership changes when a human editor changes it.
 *
 *   npm run kr:themes
 */

const config = readConfig();
const result = await refreshThemes(config, { log: (message) => console.log(message) });

console.log(`done · ${result.themes} themes · ${result.saved} rows`);
process.exit(0);
