import { classifyTheme } from "./themes.mjs";
import { formatShareVolume, formatTradingAmount } from "./format.mjs";
import { query } from "../db/client.mjs";
import { usMarketPhase } from "./premarket.mjs";

/**
 * The US session that is actually open, when it is not the regular one.
 *
 * The Yahoo screener answers about the regular session and nothing else, so
 * between 04:00 and 09:30 ET the board was ranking yesterday's close while the
 * premarket ran. Measured 2026-08-19 at 17:53 KST against a broker's list: it
 * showed ZNB +87%, TNON +83%, BIVI +70%, and the board's top riser was AMLX at
 * +64% from the session before.
 *
 * None of that needed a new source. The collector samples every symbol on its
 * watchlist through all three sessions, so the premarket was already recorded -
 * 523 symbols, and its top names are the same ones, within a few points on a
 * different snapshot.
 *
 * These are added to the screener's leaders rather than replacing them. A
 * premarket riser is usually a micro cap with no theme and almost no turnover,
 * which is a riser and not a leader; leadership is still ranked on turnover, so
 * adding them cannot displace the names the board is about.
 */

const maximumMovers = 30;
const minimumChangeRate = 3;

const sourceForPhase = { post: "yahoo:us:post", pre: "yahoo:us:pre", regular: "yahoo:us:regular:seen" };

/*
 * 국면마다 조심할 것이 다릅니다.
 *
 * 이 문구는 프리마켓용 한 줄로 고정돼 있었습니다. label은 국면별로 제대로
 * 고르는데 caution만 안 그래서, 2026-08-31 23:19에 CLGN 행이 `미국 정규장
 * +110.22%`를 달고 "정규장 전 거래라 개장과 함께 되돌리는 경우가 많습니다"라고
 * 말하고 있었습니다. 이미 개장한 뒤인데 개장을 기다리라고 한 셈입니다.
 *
 * 정규장 문구는 그날 밤 실측에서 나왔습니다 -- 급등 알림 다섯 종목이 고점에서
 * 23~61% 되돌렸고 알림가 대비 종가 중앙값이 -47%였습니다.
 */
const cautionForPhase = {
  post: "애프터마켓은 거래가 얇아 다음 날 정규장에서 값이 유지되지 않는 경우가 많습니다",
  pre: "정규장 전 거래라 호가가 얇고 개장과 함께 되돌리는 경우가 많습니다",
  regular: "장중 급등은 고점에서 크게 되돌리는 경우가 많습니다 — 지금 값이 오늘 고점일 수 있습니다"
};

export async function loadUsExtendedLeaders(config, { now = new Date() } = {}) {
  const phase = usMarketPhase(now);
  const source = sourceForPhase[phase];

  if (!source || !config.databaseUrl) return [];

  // The last half hour only. An extended session is thin enough that a print
  // from two hours ago is not a price anyone can trade against now.
  const result = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name, change_rate, turnover, volume, market_cap
    FROM market_price_samples
    WHERE market = 'US' AND source = $1
      AND observed_at > now() - interval '30 minutes'
      AND change_rate IS NOT NULL
    ORDER BY symbol, observed_at DESC
  `, [source]);
  const label = { post: "미국 애프터마켓", pre: "미국 프리마켓", regular: "미국 정규장" }[phase];

  return result.rows
    .map((row) => ({ ...row, changeRate: Number(row.change_rate) }))
    .filter((row) => row.changeRate >= minimumChangeRate)
    .sort((left, right) => right.changeRate - left.changeRate)
    .slice(0, maximumMovers)
    .map((row, index) => {
      const name = row.name ?? row.symbol;
      const theme = classifyTheme(row.symbol, name);
      const turnoverValue = Number(row.turnover ?? 0);
      const volume = Number(row.volume ?? 0);

      return {
        burst: formatShareVolume(volume),
        caution: cautionForPhase[phase],
        changeRateValue: row.changeRate,
        id: `us-extended-${row.symbol}`,
        intraday: `${label} ${row.changeRate > 0 ? "+" : ""}${row.changeRate.toFixed(2)}%`,
        market: "US",
        marketCapValue: Number(row.market_cap ?? 0) || undefined,
        marketLabel: label,
        name,
        rank: index + 1,
        reason: `${theme} · ${label} 상승률 #${index + 1}`,
        source: "premarket",
        symbol: row.symbol,
        theme,
        timestamp: new Date().toISOString(),
        turnover: formatTradingAmount(turnoverValue, "USD"),
        turnoverValue,
        volumeValue: volume
      };
    });
}
