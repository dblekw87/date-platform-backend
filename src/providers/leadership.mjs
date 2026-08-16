import { formatShareVolume, formatTradingAmount } from "./format.mjs";

/**
 * 주도주 — the stocks the day's money actually concentrated on.
 *
 * This is deliberately a different question from 강세 테마. A theme answers
 * "which group is strong", and needs several names moving together to mean
 * anything. A leader answers "where did the money go", and one name is enough:
 * a stock rising alone on a buyback or an earnings beat leads the day without
 * belonging to any group that moved with it.
 *
 * Concentration is measured against the leader pool rather than the whole
 * market, because the providers only rank the top names. The share is therefore
 * "of the money that moved today, how much came here", which is the comparison
 * that matters for spotting a leader, and it stays comparable across markets.
 *
 * Falling stocks are excluded. Heavy turnover on a drop is money leaving, and
 * labelling it leadership would put the day's worst names at the top of a list
 * traders read as candidates.
 */

// Labels describing how a stock surfaced rather than what it belongs to. A
// leader tagged with one of these has no theme to have peers in.
const nonThemeLabels = new Set(["ETF", "미분류", "개별 이슈", "거래대금 급증", "소형주 급등"]);

// Below this share a name is riding the day rather than leading it, and the
// list stops being a short answer to "what moved today".
const minimumTurnoverShare = 0.015;

// One other name rising in the same theme is already a 짝꿍: the whole point of
// the trade is that a 2등주 exists, and requiring a crowd would hide the pairs
// that do form.
const themeLeadPeerFloor = 1;

// A window this much heavier than the stock's own day means the move is
// happening now rather than having already happened.
const burstShareMultiple = 1.4;

const volumeSurgeMultiple = 3;

function positiveNumber(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function themeOf(stock) {
  const theme = stock.theme?.trim();

  return theme && !nonThemeLabels.has(theme) ? theme : undefined;
}

/**
 * Why this name is on the list, in the order a trader would check it.
 * Every entry is a measured figure, so nothing here is a guess.
 */
function buildEvidence(stock, { currency, recentShare, share, volumeRatio }) {
  const evidence = [`거래대금 점유 ${(share * 100).toFixed(1)}% · ${formatTradingAmount(stock.turnoverValue, currency)}`];

  if (recentShare > 0 && stock.recentWindowMinutes) {
    evidence.push(`최근 ${stock.recentWindowMinutes}분 유입 ${formatTradingAmount(stock.recentTurnoverValue, currency)} (구간 점유 ${(recentShare * 100).toFixed(1)}%)`);
  }

  if (volumeRatio > 0) evidence.push(`거래량 ${formatShareVolume(stock.volumeValue)} · 평소 대비 ${volumeRatio.toFixed(1)}배`);
  else if (positiveNumber(stock.volumeValue) > 0) evidence.push(`거래량 ${formatShareVolume(stock.volumeValue)}`);

  return evidence;
}

/**
 * The one-word reason this name concentrated, chosen by which measure stands
 * out most. Ordered so the freshest signal wins: money arriving in the last
 * window says more than money that arrived at the open.
 */
function leadKind(share, recentShare, volumeRatio) {
  if (recentShare >= share * burstShareMultiple) return "순간 쏠림";
  if (volumeRatio >= volumeSurgeMultiple) return "거래량 급증";

  return "거래대금 집중";
}

/**
 * Ranks the day's leaders by concentration.
 *
 * `pairTrade` is the part that feeds 짝꿍매매: a leader with peers moving in the
 * same theme has candidates behind it, and a leader without peers does not.
 * Saying so explicitly keeps the list from implying a 2등주 exists on days when
 * the move belongs to one company.
 */
export function rankDayLeaders(stocks, currency = "KRW", limit = 8) {
  const rising = stocks.filter((stock) => positiveNumber(stock.turnoverValue) > 0 && Number(stock.changeRateValue) > 0);

  if (rising.length === 0) return [];

  const poolTurnover = rising.reduce((total, stock) => total + positiveNumber(stock.turnoverValue), 0);
  const poolRecentTurnover = rising.reduce((total, stock) => total + positiveNumber(stock.recentTurnoverValue), 0);
  const peerCounts = new Map();

  rising.forEach((stock) => {
    const theme = themeOf(stock);

    if (theme) peerCounts.set(theme, (peerCounts.get(theme) ?? 0) + 1);
  });

  const ranked = rising
    .map((stock) => {
      const share = poolTurnover > 0 ? positiveNumber(stock.turnoverValue) / poolTurnover : 0;
      const recentShare = poolRecentTurnover > 0 ? positiveNumber(stock.recentTurnoverValue) / poolRecentTurnover : 0;
      const volumeRatio = positiveNumber(stock.volumeRatioValue);
      const changeRate = Number(stock.changeRateValue);
      const theme = themeOf(stock);
      // Peers exclude the stock itself, so this counts the names that could
      // actually follow it.
      const peerCount = theme ? (peerCounts.get(theme) ?? 1) - 1 : 0;
      // Turnover share leads because it is the measure that holds all day, and
      // the recent window sits just behind it because money arriving now is what
      // a 짝꿍 trade still has time to act on. Volume and the change rate are
      // capped low on purpose: they break ties, and an earlier weighting let a
      // 20% mover outrank a name carrying half again its share, which made the
      // list stop reading as an order of concentration.
      const score = share * 100
        + recentShare * 60
        + Math.min(volumeRatio, 6) * 0.5
        + Math.min(changeRate, 30) * 0.06;

      return {
        id: `day-leader-${stock.market.toLowerCase()}-${stock.symbol}`,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        // `theme` is the curated answer and is what peers are counted on;
        // `industryTheme` is the registered sector, which names the stock
        // without claiming anything moved alongside it. So it shows here and
        // nowhere in the pairing above: 개별 종목 should mean the board knows of
        // no group, not that nobody ever asked what the company does.
        theme: theme ?? stock.industryTheme ?? "개별 종목",
        rank: 0,
        kind: leadKind(share, recentShare, volumeRatio),
        pairTrade: peerCount >= themeLeadPeerFloor ? "테마 주도" : "단독 주도",
        peerCount,
        turnoverShare: share,
        recentTurnoverShare: recentShare,
        changeRateValue: changeRate,
        turnover: formatTradingAmount(stock.turnoverValue, currency),
        intraday: stock.intraday,
        evidence: buildEvidence(stock, { currency, recentShare, share, volumeRatio }),
        caution: peerCount >= themeLeadPeerFloor
          ? "같은 테마 종목의 동반 여부와 거래대금 유지 확인"
          : "테마 동반이 없어 개별 재료일 수 있으니 뉴스·공시 원문 확인",
        timestamp: stock.timestamp,
        source: stock.source,
        score
      };
    })
    .filter((leader) => leader.turnoverShare >= minimumTurnoverShare)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return ranked.map(({ score, ...leader }, index) => ({ ...leader, rank: index + 1 }));
}
