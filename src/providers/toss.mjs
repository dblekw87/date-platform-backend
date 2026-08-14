import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";
import { classifyTheme } from "./themes.mjs";
import { readStoredToken, writeStoredToken } from "./token-store.mjs";

const tokenCacheSkewMs = 60_000;
const rankingTypes = {
  turnover: "MARKET_TRADING_AMOUNT",
  volume: "MARKET_TRADING_VOLUME",
  gainers: "TOP_GAINERS"
};

const leaderCacheTtlMs = 60_000;
const rateLimitCooldownMs = 90_000;

let tokenCache;
let tokenRequest;
let cooldownUntil = 0;

// A 429 means the quota is already spent, so retrying on the next page load only
// deepens the hole. Hold off until the window has plausibly reset.
function assertNotCoolingDown() {
  const remainingMs = cooldownUntil - Date.now();

  if (remainingMs > 0) {
    throw new Error(`레이트 리밋 대기 중 · ${Math.ceil(remainingMs / 1000)}초 후 재시도`);
  }
}

function noteFailure(error) {
  if (error?.status === 429) {
    cooldownUntil = Date.now() + rateLimitCooldownMs;
  }

  throw error;
}

function tossUrl(config, path, params = {}) {
  const url = new URL(path, config.toss.baseUrl);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function requestAccessToken(config) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.toss.clientId ?? "",
    client_secret: config.toss.clientSecret ?? ""
  });
  const data = await fetchJson(tossUrl(config, "/oauth2/token"), {
    method: "POST",
    timeoutMs: 5000,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  if (!data?.access_token) {
    throw new Error("Toss token missing");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in ?? 86_400) - 300, 60) * 1000
  };

  await writeStoredToken("toss", tokenCache);

  return tokenCache.accessToken;
}

// The board loads KR leaders, US leaders, and the exchange rate at once. Without
// this guard each of them would request its own token on a cold start, and every
// restart would spend another one against the quota.
async function getAccessToken(config) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + tokenCacheSkewMs) {
    return tokenCache.accessToken;
  }

  if (tokenRequest) return tokenRequest;

  tokenRequest = (async () => {
    const stored = await readStoredToken("toss");

    if (stored) {
      tokenCache = stored;

      return stored.accessToken;
    }

    return requestAccessToken(config);
  })().finally(() => {
    tokenRequest = undefined;
  });

  return tokenRequest;
}

async function tossGet(config, path, params) {
  const token = await getAccessToken(config);

  return fetchJson(tossUrl(config, path, params), {
    timeoutMs: 6500,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
}

function parseDecimal(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : 0;
}

function signedPercentFromRatio(value) {
  const percent = parseDecimal(value) * 100;

  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatAmount(value, currency) {
  const numeric = parseDecimal(value);

  if (!numeric) return "거래대금 확인 중";

  if (currency === "USD") {
    if (numeric >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(1)}B`;
    if (numeric >= 1_000_000) return `$${Math.round(numeric / 1_000_000).toLocaleString("ko-KR")}M`;

    return `$${Math.round(numeric).toLocaleString("ko-KR")}`;
  }

  const eok = numeric / 100_000_000;

  if (eok >= 10_000) return `${(eok / 10_000).toFixed(1)}조`;
  if (eok >= 100) return `${Math.round(eok).toLocaleString("ko-KR")}억`;

  return `${eok.toFixed(1)}억`;
}

function formatVolume(value) {
  const numeric = parseDecimal(value);

  if (!numeric) return "거래량 확인 중";
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M주`;

  return `${Math.round(numeric).toLocaleString("ko-KR")}주`;
}

function normalizeRankingItem(item, rankingType) {
  return {
    ...item,
    rankingType,
    rankingTypes: [rankingType],
    rankingRanks: item.rank ? { [rankingType]: item.rank } : {}
  };
}

function mergeRankingItems(items) {
  const bySymbol = new Map();

  items.forEach((item) => {
    if (!item.symbol) return;

    const current = bySymbol.get(item.symbol);

    if (!current) {
      bySymbol.set(item.symbol, item);
      return;
    }

    bySymbol.set(item.symbol, {
      ...current,
      ...item,
      rankingTypes: [...new Set([...(current.rankingTypes ?? []), ...(item.rankingTypes ?? [])])],
      rankingRanks: {
        ...(current.rankingRanks ?? {}),
        ...(item.rankingRanks ?? {})
      },
      tradingAmount: parseDecimal(item.tradingAmount) > 0 ? item.tradingAmount : current.tradingAmount,
      tradingVolume: parseDecimal(item.tradingVolume) > 0 ? item.tradingVolume : current.tradingVolume,
      price: item.price ?? current.price
    });
  });

  return [...bySymbol.values()];
}

async function loadRanking(config, marketCountry, type, duration) {
  const data = await tossGet(config, "/api/v1/rankings", {
    type,
    marketCountry,
    duration,
    excludeInvestmentCaution: "false",
    count: "40"
  });

  return (data?.result?.rankings ?? []).map((item) => normalizeRankingItem(item, type));
}

async function loadStocks(config, symbols) {
  if (symbols.length === 0) return new Map();

  const data = await tossGet(config, "/api/v1/stocks", {
    symbols: symbols.slice(0, 200).join(",")
  });
  const stocks = new Map();

  (data?.result ?? []).forEach((stock) => {
    if (stock.symbol) stocks.set(stock.symbol, stock);
  });

  return stocks;
}

function rankFor(item, type) {
  return item.rankingRanks?.[type] ?? (item.rankingType === type ? item.rank : undefined);
}

function leaderScore(item) {
  const turnoverRank = rankFor(item, rankingTypes.turnover);
  const gainersRank = rankFor(item, rankingTypes.gainers);
  const volumeRank = rankFor(item, rankingTypes.volume);
  const amountScore = Math.log10(Math.max(parseDecimal(item.tradingAmount), 1)) * 22;
  const volumeScore = Math.log10(Math.max(parseDecimal(item.tradingVolume), 1)) * 4;
  const changeRate = parseDecimal(item.price?.changeRate) * 100;

  return (
    (turnoverRank ? 5_500 - Math.min(turnoverRank, 50) * 35 : 0) +
    (gainersRank ? 1_500 - Math.min(gainersRank, 50) * 18 : 0) +
    (volumeRank ? 1_800 - Math.min(volumeRank, 50) * 16 : 0) +
    amountScore +
    volumeScore +
    Math.max(changeRate, 0) * 5
  );
}

function toLeader(item, market, stock, index) {
  const currency = item.currency ?? (market === "US" ? "USD" : "KRW");
  const symbol = item.symbol;
  const name = stock?.name || stock?.englishName || symbol;
  const changeRate = signedPercentFromRatio(item.price?.changeRate);
  const theme = classifyTheme(symbol, name);

  return {
    id: `toss-${market.toLowerCase()}-leader-${symbol}`,
    symbol,
    name,
    market,
    rank: index + 1,
    marketLabel: market === "US" ? "미국 거래 집중" : "국내 거래 집중",
    theme,
    turnoverValue: parseDecimal(item.tradingAmount),
    burst: `${formatVolume(item.tradingVolume)} · ${changeRate}`,
    turnover: formatAmount(item.tradingAmount, currency),
    intraday: `현재가 ${item.price?.lastPrice ?? "확인 중"} · 전일 대비 ${changeRate}`,
    reason: `${theme} · 토스증권 ${[
      rankFor(item, rankingTypes.turnover) ? `거래대금 #${rankFor(item, rankingTypes.turnover)}` : null,
      rankFor(item, rankingTypes.volume) ? `거래량 #${rankFor(item, rankingTypes.volume)}` : null,
      rankFor(item, rankingTypes.gainers) ? `상승률 #${rankFor(item, rankingTypes.gainers)}` : null
    ].filter(Boolean).join(" · ")}`,
    caution: "뉴스·공시 원문과 장중 거래대금 유지 여부 확인",
    timestamp: new Date().toISOString(),
    source: "toss"
  };
}

export async function loadTossLeaders(config, market) {
  assertNotCoolingDown();

  return readThroughCache(`toss:leaders:${market}`, leaderCacheTtlMs, async () => {
    const [turnover, volume, gainers] = await Promise.all([
      loadRanking(config, market, rankingTypes.turnover, "realtime"),
      loadRanking(config, market, rankingTypes.volume, "realtime"),
      loadRanking(config, market, rankingTypes.gainers, "1d")
    ]);
    const merged = mergeRankingItems([...turnover, ...volume, ...gainers])
      .sort((left, right) => leaderScore(right) - leaderScore(left))
      .slice(0, 30);
    const stocks = await loadStocks(config, merged.flatMap((item) => item.symbol ? [item.symbol] : []));

    return merged.map((item, index) => toLeader(item, market, stocks.get(item.symbol), index));
  }).catch(noteFailure);
}

export async function loadTossExchangeRate(config, baseCurrency = "USD", quoteCurrency = "KRW") {
  assertNotCoolingDown();

  return readThroughCache(`toss:exchange:${baseCurrency}:${quoteCurrency}`, leaderCacheTtlMs, async () => {
    const data = await tossGet(config, "/api/v1/exchange-rate", {
      baseCurrency,
      quoteCurrency
    });

    return {
      baseCurrency,
      quoteCurrency,
      ...data?.result,
      source: "toss",
      timestamp: new Date().toISOString()
    };
  }).catch(noteFailure);
}
