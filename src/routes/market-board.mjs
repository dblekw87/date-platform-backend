import { hasKisCredentials, hasTossCredentials } from "../config.mjs";
import { getLatestMarketBoardSnapshot, pruneMarketBoardSnapshots, saveMarketBoardSnapshot } from "../db/repositories.mjs";
import { hasDartCredentials, loadDartDisclosures } from "../providers/dart.mjs";
import { loadKisMarketBoard } from "../providers/kis.mjs";
import { loadKrxCalendar } from "../providers/krx.mjs";
import { attachLeaderNewsTags, loadLeaderNewsHeadlines, loadNewsHeadlines } from "../providers/news.mjs";
import { loadMarketData } from "../providers/market.mjs";
import { loadSecDisclosures } from "../providers/sec.mjs";
import { buildThemeBrief } from "../providers/themes.mjs";
import { loadTossExchangeRate, loadTossLeaders } from "../providers/toss.mjs";

const focusCalendarItems = [
  {
    id: "focus-earnings-amd-2026-08-04",
    date: "2026-08-04",
    day: "화",
    type: "실적",
    title: "AMD 실적 발표",
    market: "미국",
    check: "미국 8월 4일 장마감 후 발표 · 한국은 8월 5일 새벽 확인",
    detail: "AMD IR 기준 fiscal Q2 2026 실적 발표입니다. 발표 후 시간외 반응, 반도체 ETF, 관련 AI 인프라 종목 반응을 함께 확인합니다.",
    source: "AMD IR",
    originalUrl: "https://ir.amd.com/news-events/press-releases/detail/1289/amd-to-report-fiscal-second-quarter-2026-financial-results",
    publishedAt: "2026-08-05T05:15:00+09:00"
  },
  {
    id: "focus-earnings-sndk-2026-08-06-kst",
    date: "2026-08-06",
    day: "목",
    type: "실적",
    title: "SanDisk 실적 발표",
    market: "미국",
    check: "미국 8월 5일 13:30 PT 컨퍼런스콜 · 한국은 8월 6일 05:30 확인",
    detail: "Sandisk IR 기준 fiscal Q4/FY 2026 실적 발표입니다. NAND/스토리지 가격, Western Digital 동반 반응, 반도체 수급을 함께 확인합니다.",
    source: "Sandisk IR",
    originalUrl: "https://www.sandisk.com/company/newsroom/press-releases/2026/2026-07-09-sandisk-report-fiscal-fourth-quarter-fiscal-year-2026-results-august-5",
    publishedAt: "2026-08-06T05:30:00+09:00"
  }
];

function baseMarketBoardData(providerStatuses) {
  return {
    tabs: [
      { id: "market", label: "시황", description: "미국 매크로와 국내 개장 기준점을 먼저 확인합니다." },
      { id: "news", label: "뉴스", description: "미국 뉴스, 국내 뉴스, 테마 흐름, 헤드라인 흐름을 확인합니다." },
      { id: "calendar", label: "일정", description: "공모주, 실적발표, FOMC, CPI처럼 날짜가 정해진 이벤트를 캘린더로 봅니다." },
      { id: "breaking", label: "속보·공시", description: "SEC, 인수합병, 매각, 금리, 정책 이벤트처럼 즉시 확인할 항목을 모읍니다." },
      { id: "flow", label: "수급·차트", description: "시황과 뉴스를 본 뒤 수급과 기술적 위치를 확인합니다." }
    ],
    disclosureTabs: [
      { id: "us", label: "미국 SEC", description: "SEC 공시, 인수합병, 지분 변동, 매각, 금리 이벤트를 미국장 기준으로 봅니다." },
      { id: "kr", label: "국내 DART", description: "DART 공시, 공급계약, 최대주주 변경, CB/BW, 유상증자, 테마주 재료를 국내장 기준으로 봅니다." }
    ],
    leaderTabs: [
      { id: "us", label: "미국 주도주" },
      { id: "kr", label: "국내 주도주" }
    ],
    adSlots: [
      { id: "top", label: "상단 광고 영역", reserved: true },
      { id: "middle", label: "중단 광고 영역", reserved: true },
      { id: "bottom", label: "하단 광고 영역", reserved: true }
    ],
    providerStatuses,
    macroSnapshot: [],
    marketBrief: [],
    headlineFlow: [],
    calendarItems: focusCalendarItems,
    usDisclosures: [],
    krDisclosures: [],
    flowItems: [],
    usLeadingStocks: [],
    krLeadingStocks: [],
    smallCapScanner: []
  };
}

function mergeById(baseItems, payloadItems = []) {
  const byId = new Map(baseItems.map((item) => [item.id, item]));

  payloadItems.forEach((item) => byId.set(item.id, item));

  return [...byId.values()];
}

function mergeMarketBoardData(base, payload) {
  return {
    ...base,
    ...payload,
    tabs: base.tabs,
    disclosureTabs: base.disclosureTabs,
    leaderTabs: base.leaderTabs,
    adSlots: base.adSlots,
    providerStatuses: base.providerStatuses,
    macroSnapshot: mergeById(base.macroSnapshot, payload.macroSnapshot),
    marketBrief: mergeById(base.marketBrief, payload.marketBrief),
    headlineFlow: payload.headlineFlow ?? base.headlineFlow,
    calendarItems: mergeById(base.calendarItems, payload.calendarItems)
      .sort((left, right) => left.date.localeCompare(right.date) || left.type.localeCompare(right.type) || left.title.localeCompare(right.title)),
    usDisclosures: payload.usDisclosures ?? base.usDisclosures,
    krDisclosures: payload.krDisclosures ?? base.krDisclosures,
    flowItems: mergeById(base.flowItems, payload.flowItems),
    usLeadingStocks: payload.usLeadingStocks ?? base.usLeadingStocks,
    krLeadingStocks: payload.krLeadingStocks ?? base.krLeadingStocks,
    smallCapScanner: payload.smallCapScanner ?? base.smallCapScanner
  };
}

function providerStatus(id, label, status, message, checkedAt) {
  return { id, label, status, message, checkedAt };
}

// The board must render even when the database is absent or unreachable, so a
// snapshot lookup failure degrades to live/base data instead of failing the request.
async function readSnapshot(config) {
  if (!config.databaseUrl) return null;

  try {
    return await getLatestMarketBoardSnapshot(config, "licensed-live");
  } catch (error) {
    console.warn("market-board snapshot read failed", error instanceof Error ? error.message : error);

    return null;
  }
}

async function writeSnapshot(config, board) {
  if (!config.databaseUrl) return;

  try {
    await saveMarketBoardSnapshot(config, {
      mode: "licensed-live",
      payload: board,
      ttlSeconds: 60
    });
    await pruneMarketBoardSnapshots(config);
  } catch (error) {
    console.warn("market-board snapshot write failed", error instanceof Error ? error.message : error);
  }
}

async function loadTossMarketBoard(config) {
  const [krLeadingStocks, usLeadingStocks, usdKrw] = await Promise.all([
    loadTossLeaders(config, "KR"),
    loadTossLeaders(config, "US"),
    loadTossExchangeRate(config, "USD", "KRW").catch(() => null)
  ]);

  return {
    krLeadingStocks,
    usLeadingStocks,
    macroSnapshot: usdKrw ? [
      {
        id: "usd-krw",
        label: "원/달러 환율",
        market: "KR",
        instrumentType: "fx",
        symbol: "USD/KRW",
        value: usdKrw.rate ?? usdKrw.midRate ?? "확인 중",
        tone: "flat",
        note: "토스증권 참고 환율",
        timestamp: usdKrw.validFrom ?? usdKrw.timestamp,
        source: "toss"
      }
    ] : []
  };
}

/**
 * `licensed` marks providers whose live data may only be displayed once display
 * rights are cleared, so MARKET_DATA_MODE gates them. Public providers are not
 * gated. Providers still served by the frontend have no `load` yet.
 */
const providerAdapters = [
  {
    id: "kis",
    label: "한국투자증권 Open API",
    licensed: true,
    missingMessage: "KIS_APP_KEY, KIS_APP_SECRET 없음 · provider 비활성",
    hasCredentials: hasKisCredentials,
    load: loadKisMarketBoard,
    timeoutMs: 8000
  },
  {
    id: "toss",
    label: "토스증권 Open API",
    licensed: true,
    missingMessage: "TOSS_INVEST_CLIENT_ID, TOSS_INVEST_CLIENT_SECRET 없음 · provider 비활성",
    hasCredentials: hasTossCredentials,
    load: loadTossMarketBoard,
    // Requests are spaced out to stay under the rate limit, so this provider
    // takes longer than the others on a cold cache.
    timeoutMs: 20_000
  },
  {
    id: "market",
    label: "시장 데이터",
    hasCredentials: () => true,
    load: loadMarketData,
    timeoutMs: 6000
  },
  {
    id: "sec",
    label: "SEC EDGAR",
    hasCredentials: () => true,
    load: loadSecDisclosures,
    timeoutMs: 9000
  },
  {
    id: "dart",
    label: "DART Open API",
    missingMessage: "DART_API_KEY 없음 · provider 비활성",
    hasCredentials: hasDartCredentials,
    load: loadDartDisclosures,
    timeoutMs: 7000
  },
  {
    id: "krx",
    label: "KRX Open API / KIND",
    hasCredentials: () => true,
    load: loadKrxCalendar,
    timeoutMs: 9000
  },
  {
    id: "news",
    label: "뉴스 공급자",
    // Google News RSS needs no key, so this provider always has something to load.
    hasCredentials: () => true,
    load: loadNewsHeadlines,
    timeoutMs: 12_000
  }
];

async function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${timeoutMs}ms 초과`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runAdapter(adapter, config, checkedAt, canUseLicensedLiveData) {
  const empty = { payload: {} };

  if (!adapter.load) {
    return { ...empty, status: providerStatus(adapter.id, adapter.label, "mock", "backend 이관 대기 · provider 비활성", checkedAt) };
  }

  if (adapter.licensed && !canUseLicensedLiveData) {
    return { ...empty, status: providerStatus(adapter.id, adapter.label, "mock", "MARKET_DATA_MODE=demo · 공개 live 데이터 차단", checkedAt) };
  }

  if (!adapter.hasCredentials(config)) {
    return { ...empty, status: providerStatus(adapter.id, adapter.label, "mock", adapter.missingMessage ?? "provider 비활성", checkedAt) };
  }

  try {
    return {
      payload: await withTimeout(adapter.load(config), adapter.timeoutMs ?? 6000),
      status: providerStatus(adapter.id, adapter.label, "ready", "backend adapter 활성화 · live 데이터 수신", checkedAt)
    };
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` · ${error.message}` : "";

    return { ...empty, status: providerStatus(adapter.id, adapter.label, "error", `backend adapter 오류${reason}`, checkedAt) };
  }
}

function mergeHeadlines(baseItems, extraItems) {
  const byId = new Map(baseItems.map((item) => [item.id, item]));

  extraItems.forEach((item) => byId.set(item.id, item));

  return [...byId.values()].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

/**
 * Runs after the provider merge so leaders from any provider get their symbols
 * and themes tagged onto headlines, plus a targeted news search per leader.
 * A failure here leaves the untagged headlines in place.
 */
async function attachLeaderNews(board) {
  const leaders = [...board.krLeadingStocks, ...board.usLeadingStocks];

  if (leaders.length === 0) return board;

  const tagged = attachLeaderNewsTags(board.headlineFlow, leaders);

  try {
    return {
      ...board,
      headlineFlow: mergeHeadlines(tagged, await withTimeout(loadLeaderNewsHeadlines(leaders), 6000))
    };
  } catch (error) {
    console.warn("leader news lookup failed", error instanceof Error ? error.message : error);

    return { ...board, headlineFlow: tagged };
  }
}

export async function getMarketBoard(config) {
  const checkedAt = new Date().toISOString();
  const canUseLicensedLiveData = config.marketDataMode === "licensed-live";

  if (!canUseLicensedLiveData) {
    const snapshot = await readSnapshot(config);

    if (snapshot) {
      return {
        ...snapshot,
        providerStatuses: (snapshot.providerStatuses ?? []).map((status) => ({
          ...status,
          status: status.status === "ready" ? "mock" : status.status,
          message: `DB snapshot · ${status.message}`
        }))
      };
    }
  }

  const results = await Promise.all(
    providerAdapters.map((adapter) => runAdapter(adapter, config, checkedAt, canUseLicensedLiveData))
  );
  const statuses = results.map((result) => result.status);
  const payloads = results.map((result) => result.payload);
  const merged = payloads.reduce(mergeMarketBoardData, baseMarketBoardData(statuses));
  // Themes are scored after the merge so every provider's leaders count toward
  // the same turnover ranking.
  const themeBriefs = [
    buildThemeBrief("derived-kr-theme-leadership", "시황 · 국내 강세 테마", merged.krLeadingStocks, "KRW", checkedAt),
    buildThemeBrief("derived-us-theme-leadership", "시황 · 미국 강세 테마", merged.usLeadingStocks, "USD", checkedAt)
  ].filter(Boolean);
  const withThemes = themeBriefs.length > 0
    ? { ...merged, marketBrief: mergeById(merged.marketBrief, themeBriefs) }
    : merged;
  const board = await attachLeaderNews(withThemes);

  if (canUseLicensedLiveData) {
    await writeSnapshot(config, board);
  }

  return board;
}
