import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { dedupeNews, normalizeNewsFeed } from "./news-normalizer.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { classifyTheme } from "./themes.mjs";

/**
 * Headline flow assembled from every configured news source, plus the Finnhub
 * earnings calendar. Each source is optional: whichever keys are present get
 * used, the rest are skipped, and a single failing feed drops only its own
 * items.
 */

const cacheTtlMs = 30_000;

// Diplomacy sits in this list next to the industries because on 2026-08-18 the
// top three domestic leaders by turnover were 아난티, 대아티아이 and 좋은사람들,
// all limit-up or near it on remarks about the North, and thirty hours of the
// feed held three headlines matching 북한·남북·경협·트럼프 - none of them the
// catalyst. Sixteen queries and not one of them political: the event that moved
// the board could not enter the corpus at all.
//
// Not on NewsAPI: a developer key allows a hundred requests a day and this file
// already spends twenty-seven per sample, so those queries are answering 429 by
// mid-morning. Naver and the Google feed are the ones that actually deliver.
const naverQueries = ["국내 증시", "코스피 코스닥", "미국 증시", "금리 환율", "원달러 환율", "반도체 2차전지", "AI 데이터센터", "전력 설비", "바이오 제약", "조선 방산", "방산 수출", "로봇 원전", "우주 항공", "자동차 은행", "정책 수혜", "인수합병 공시", "남북 경협", "대북 정책"];
const koreanNewsApiQueries = ["국내 증시", "미국 증시", "금리 환율", "반도체 2차전지", "AI 데이터센터", "바이오 제약", "조선 방산", "정책 수혜"];
const koreanRssQueries = ["국내 증시", "코스피 코스닥", "미국 증시", "반도체 주식", "AI 데이터센터 주식", "전력 설비 주식", "2차전지 주식", "바이오 제약 주식", "조선 방산 주식", "방산 수출 주식", "로봇 원전 주식", "우주 항공 주식", "수소 연료전지 주식", "재생에너지 태양광 풍력 주식", "정책 수혜주", "국내 공시 인수합병", "남북 경협주", "대북 정책 수혜주"];
const globalNewsApiQueries = ["stock market", "earnings", "interest rates", "fed rate cuts", "inflation data", "semiconductor stocks", "ai stocks", "data center power", "energy oil", "nuclear energy stocks", "hydrogen fuel cell stocks", "renewable energy solar wind stocks", "defense stocks", "aerospace stocks", "banks", "biotech stocks", "small cap stocks", "tariff stocks", "merger acquisition"];

const usCompanySearchNames = {
  AMD: "Advanced Micro Devices",
  INTC: "Intel",
  MU: "Micron Technology",
  NVDA: "Nvidia",
  SNDK: "Sandisk",
  SPCX: "SPACEX"
};

const themeSearchTerms = {
  "2차전지": { ko: "2차전지 배터리 주식", en: "battery stocks" },
  "AI·방산": { ko: "AI 방산 주식", en: "AI defense stocks" },
  "AI·소프트웨어": { ko: "AI 소프트웨어 주식", en: "AI software stocks" },
  "MLCC·전자부품": { ko: "MLCC 전자부품 주식", en: "MLCC electronic components stocks" },
  "광통신·네트워크": { ko: "광통신 네트워크 장비 주식", en: "optical networking photonics stocks" },
  "바이오": { ko: "바이오 제약 주식", en: "biotech stocks" },
  "반도체": { ko: "반도체 주식", en: "semiconductor stocks" },
  "방산": { ko: "방산 수출 주식", en: "defense stocks" },
  "수소·연료전지": { ko: "수소 연료전지 주식", en: "hydrogen fuel cell stocks" },
  "원전": { ko: "원전 원자력 주식", en: "nuclear energy stocks" },
  "자동차·전장": { ko: "자동차 전장 주식", en: "auto parts stocks" },
  "재생에너지": { ko: "재생에너지 태양광 풍력 주식", en: "renewable energy solar wind stocks" },
  "전력기기": { ko: "전력기기 변압기 주식", en: "power equipment grid stocks" },
  "전자부품·전장": { ko: "전자부품 전장 카메라모듈 주식", en: "electronics components auto parts stocks" },
  "조선": { ko: "조선 수주 주식", en: "shipbuilding stocks" },
  "패키지기판·PCB": { ko: "패키지기판 PCB 주식", en: "package substrate PCB stocks" },
  "플랫폼 AI": { ko: "플랫폼 AI 주식", en: "internet platform stocks" },
  "항공우주": { ko: "항공우주 위성 주식", en: "aerospace space satellite stocks" }
};

const marketRelevancePattern = /주식|증시|시장|코스피|코스닥|환율|금리|국채|선물|외국인|기관|거래량|거래대금|반도체|패키지기판|기판|2차전지|배터리|바이오|제약|항공우주|우주|위성|로켓|조선|방산|로봇|원전|mlcc|콘덴서|커패시터|광통신|광모듈|광부품|네트워크|자동차|은행|금융|증권|에너지|유가|가상자산|비트코인|전력|수소|연료전지|신재생|재생에너지|태양광|풍력|AI|데이터센터|인수|합병|매각|공시|실적|가이던스|정책|규제|남북|대북|경협|개성공단|금강산|종전선언|판문점|김정은|stock|stocks|market|shares|nasdaq|nyse|dow|s&p|russell|futures|etf|fed|fomc|cpi|ppi|yield|treasury|rate|rates|inflation|dollar|currency|oil|crude|fuel|gold|energy|renewable|hydrogen|fuel cell|solar|wind|earnings|guidance|merger|acquisition|m&a|sale|sec|fda|semiconductor|chip|chips|battery|biotech|pharma|aerospace|space|satellite|rocket|launch|capacitor|optical|photonics|coherent|networking|bank|banks|brokerage|defense|shipbuilding|robot|nuclear|crypto|bitcoin|ai|data center|tariff|regulation/i;

const signalLabels = new Set(["매크로", "실적", "2차전지", "반도체", "AI 인프라", "AI·방산", "바이오", "항공우주", "조선·방산", "로봇·원전", "MLCC·전자부품", "광통신·네트워크", "수소·연료전지", "재생에너지", "자동차", "금융", "에너지", "암호화폐", "M&A", "정책", "남북경협"]);

const state = createRuntimeState("market-board-news-state", () => ({
  events: [],
  seenHeadlineIds: []
}));

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function firstXmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));

  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });

  return url.toString();
}

function todaySeoulDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(new Date());
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+09:00`);

  date.setUTCDate(date.getUTCDate() + days);

  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(date);
}

function dayLabel(dateText) {
  const date = new Date(`${dateText}T00:00:00+09:00`);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "Asia/Seoul" })
    .format(date)
    .replace(".", "");
}

// Blogs and cafes surface in RSS results but are not reportable sources.
function isArticleLikeSource(source, title) {
  return !/blog|블로그|cafe|카페|tistory|티스토리|brunch|브런치/i.test(`${source ?? ""} ${title ?? ""}`);
}

function isMarketRelevant(item) {
  return marketRelevancePattern.test(`${signalLabels.has(item.label) ? item.label : ""} ${item.text}`);
}

async function settleFeeds(loaders) {
  const results = await Promise.allSettled(loaders.map((loader) => loader()));

  return results.flatMap((result) => result.status === "fulfilled" ? normalizeNewsFeed(result.value) : []);
}

function naverApiHubFeed(config, query) {
  return async () => {
    if (!config.news.naverApiHubKeyId || !config.news.naverApiHubKey) return [];

    const response = await fetchJson(buildUrl("https://naverapihub.apigw.ntruss.com/search/v1/news", {
      query,
      display: 15,
      start: 1,
      sort: "date",
      format: "json"
    }), {
      timeoutMs: 2500,
      headers: {
        "X-NCP-APIGW-API-KEY-ID": config.news.naverApiHubKeyId,
        "X-NCP-APIGW-API-KEY": config.news.naverApiHubKey
      }
    });

    return {
      items: (response?.items ?? []).map((item) => ({
        ...item,
        source: item.source ?? "NAVER",
        provider: "NAVER",
        region: "KR",
        category: query,
        originalUrl: item.originallink || item.link,
        text: item.title || item.description
      }))
    };
  };
}

function naverDevelopersFeed(config, query) {
  return async () => {
    if (!config.news.naverSearchClientId || !config.news.naverSearchClientSecret) return [];

    const response = await fetchJson(buildUrl("https://openapi.naver.com/v1/search/news.json", {
      query,
      display: 15,
      start: 1,
      sort: "date"
    }), {
      timeoutMs: 3000,
      headers: {
        "X-Naver-Client-Id": config.news.naverSearchClientId,
        "X-Naver-Client-Secret": config.news.naverSearchClientSecret
      }
    });

    return {
      items: (response?.items ?? []).map((item) => ({
        ...item,
        source: item.source ?? "NAVER",
        provider: "NAVER",
        region: "KR",
        category: query,
        originalUrl: item.originallink || item.link,
        text: item.title || item.description
      }))
    };
  };
}

function googleNewsRssFeed(query, options = {}) {
  return async () => {
    const region = options.region ?? "KR";
    const language = options.language ?? "ko";
    const xml = await fetchText(buildUrl("https://news.google.com/rss/search", {
      q: `${query} when:2d`,
      hl: language,
      gl: region,
      ceid: `${region}:${language}`
    }), { timeoutMs: 4000 });
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .slice(0, 16)
      .map((match) => ({
        title: firstXmlValue(match[1], "title")?.replace(/<[^>]+>/g, "").trim(),
        source: firstXmlValue(match[1], "source") || "Google News",
        provider: "Google News",
        region,
        category: query,
        label: options.label,
        pubDate: firstXmlValue(match[1], "pubDate"),
        originalUrl: firstXmlValue(match[1], "link")
      }))
      .filter((item) => isArticleLikeSource(item.source, item.title));

    return { items };
  };
}

function newsApiFeed(config, query, options) {
  return async () => {
    if (!config.news.newsApiKey) return [];

    const response = await fetchJson(buildUrl("https://newsapi.org/v2/everything", {
      q: query,
      language: options.language,
      sortBy: "publishedAt",
      pageSize: 16,
      apiKey: config.news.newsApiKey
    }), { timeoutMs: 2500 });

    if (Array.isArray(response)) return response.map((item) => ({ ...item, region: options.region }));

    return {
      ...response,
      articles: response?.articles?.map((item) => ({ ...item, provider: "NewsAPI", region: options.region, category: query }))
    };
  };
}

function finnhubFeed(config, category) {
  return async () => {
    if (!config.news.finnhubApiKey) return [];

    const response = await fetchJson(buildUrl("https://finnhub.io/api/v1/news", {
      category,
      token: config.news.finnhubApiKey
    }), { timeoutMs: 2500 });

    return (response ?? []).map((item) => ({ ...item, provider: "Finnhub", region: "US", category }));
  };
}

function benzingaFeed(config) {
  return async () => {
    if (!config.news.benzingaApiKey) return [];

    const response = await fetchJson(buildUrl("https://api.benzinga.com/api/v2/news", {
      pageSize: 60,
      displayOutput: "headline"
    }), {
      timeoutMs: 2500,
      headers: {
        Authorization: `token ${config.news.benzingaApiKey}`,
        Accept: "application/json"
      }
    });

    return (response ?? []).map((item) => ({
      ...item,
      provider: "Benzinga",
      region: "US",
      source: item.source ?? item.author ?? "Benzinga",
      publishedAt: item.publishedAt ?? item.created ?? item.updated,
      originalUrl: item.originalUrl ?? item.url
    }));
  };
}

async function translateHeadline(config, text) {
  const response = await fetchJson("https://openapi.naver.com/v1/papago/n2mt", {
    method: "POST",
    timeoutMs: 3000,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Naver-Client-Id": config.news.papagoClientId,
      "X-Naver-Client-Secret": config.news.papagoClientSecret
    },
    body: new URLSearchParams({ source: "en", target: "ko", text })
  });

  return response?.message?.result?.translatedText;
}

async function translateUsHeadlines(config, items) {
  if (!config.news.papagoClientId || !config.news.papagoClientSecret) return items;

  const translated = await Promise.allSettled(items.map(async (item) => {
    if (item.region !== "US" || /[가-힣]/.test(item.text)) return item;

    const translatedText = await translateHeadline(config, item.text);

    return translatedText ? { ...item, originalText: item.text, text: translatedText } : item;
  }));

  return translated.map((result, index) => result.status === "fulfilled" ? result.value : items[index]);
}

// Without a cap one busy region or label crowds out everything else.
function balanceByRegion(items) {
  const sorted = [...items].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

  return [
    ...sorted.filter((item) => item.region === "KR").slice(0, 45),
    ...sorted.filter((item) => item.region === "US").slice(0, 55),
    ...sorted.filter((item) => item.region === "GLOBAL").slice(0, 15)
  ].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

function limitDominantLabels(items) {
  const counts = new Map();

  return [...items]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .filter((item) => {
      const key = `${item.region}:${item.label}`;
      const nextCount = (counts.get(key) ?? 0) + 1;
      const limit = item.label === "헤드라인" || item.label === "general" ? 10 : 16;

      if (nextCount > limit) return false;

      counts.set(key, nextCount);

      return true;
    });
}

async function recordHeadlines(headlineIds) {
  const current = await state.read();

  if (current.seenHeadlineIds.length === 0) {
    current.seenHeadlineIds = headlineIds.slice(0, 500);
    await state.save(current);

    return new Set();
  }

  const seen = new Set(current.seenHeadlineIds);
  const newHeadlineIds = new Set(headlineIds.filter((headlineId) => !seen.has(headlineId)));

  current.seenHeadlineIds = [...new Set([...headlineIds, ...current.seenHeadlineIds])].slice(0, 500);
  await state.save(current);

  return newHeadlineIds;
}

async function recordHeadlineEvents(events) {
  if (events.length === 0) return;

  const current = await state.read();
  const existingIds = new Set(current.events.map((event) => event.id));

  current.events = [...events.filter((event) => !existingIds.has(event.id)), ...current.events].slice(0, 300);
  await state.save(current);
}

export async function readNewsHeadlineEvents() {
  return (await state.read()).events;
}

async function loadEarningsCalendar(config) {
  if (!config.news.finnhubApiKey) return [];

  const from = todaySeoulDate();
  const response = await fetchJson(buildUrl("https://finnhub.io/api/v1/calendar/earnings", {
    from,
    to: addDays(from, 21),
    token: config.news.finnhubApiKey
  }), { timeoutMs: 3000 });

  return (response?.earningsCalendar ?? [])
    .flatMap((item) => {
      if (!item.date || !item.symbol) return [];

      return [{
        id: `finnhub-earnings-${item.symbol}-${item.date}`,
        date: item.date,
        day: dayLabel(item.date),
        type: "실적",
        title: `${item.symbol} 실적 발표`,
        market: "미국",
        check: "미국 현지일과 한국 확인 시간을 분리해 EPS·매출 컨센서스와 시간외 반응 확인",
        detail: [
          item.year && item.quarter ? `${item.year} Q${item.quarter}` : null,
          item.hour ? `발표 ${item.hour}` : null,
          typeof item.epsEstimate === "number" ? `EPS 예상 ${item.epsEstimate}` : null,
          typeof item.revenueEstimate === "number" ? `매출 예상 ${Math.round(item.revenueEstimate).toLocaleString("ko-KR")}` : null
        ].filter(Boolean).join(" · ") || "발표 후 지수선물, 업종 ETF, 관련 주도주 반응을 확인합니다.",
        source: "Finnhub",
        originalUrl: `https://www.nasdaq.com/market-activity/stocks/${item.symbol.toLowerCase()}/earnings`
      }];
    })
    .slice(0, 40);
}

function leaderSearchName(leader) {
  return leader.name.replace(/\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|PLC|Co\.?)$/i, "").trim();
}

function leaderCompanySearchName(leader) {
  return usCompanySearchNames[leader.symbol.toUpperCase()] ?? leaderSearchName(leader);
}

function leaderTheme(leader) {
  const theme = leader.theme ?? classifyTheme(leader.symbol, leader.name);

  return theme && theme !== "미분류" && theme !== "ETF" ? theme : undefined;
}

function uniqueBy(items, keyOf) {
  const seen = new Set();

  return items.filter((item) => {
    const key = keyOf(item);

    if (!key || seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function textIncludesSymbol(text, symbol) {
  if (/^\d+$/.test(symbol)) return text.includes(symbol);

  return new RegExp(`(^|[^A-Za-z0-9])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(text);
}

export function attachLeaderNewsTags(headlines, leaders) {
  const candidates = leaders
    .map((leader) => ({
      companyName: leaderCompanySearchName(leader),
      market: leader.market,
      name: leaderSearchName(leader),
      symbol: leader.symbol,
      theme: leaderTheme(leader)
    }))
    .filter((leader) => leader.name || leader.symbol);

  return headlines.map((headline) => {
    const text = `${headline.source} ${headline.label} ${headline.text} ${headline.originalText ?? ""}`;
    const lowerText = text.toLowerCase();
    // The theme match reads the story itself — not who published it, and not
    // the label this pipeline assigned upstream. Both produced false matches by
    // substring: a Reuters report on Houthi missiles in Yemen carries the label
    // 조선·방산, which contains 조선, so it came back as a 조선 reason for
    // 한화오션. Reading a theme out of our own coarse bucket is inferring from
    // an inference, and 조선일보 in the source field is the same error with a
    // publisher's name.
    const storyText = `${headline.text} ${headline.originalText ?? ""}`;
    const relatedSymbols = uniqueBy(
      candidates
        .filter((leader) => headline.region === leader.market
          && ((leader.name && lowerText.includes(leader.name.toLowerCase()))
            || (leader.companyName && lowerText.includes(leader.companyName.toLowerCase()))
            || textIncludesSymbol(text, leader.symbol)))
        .map((leader) => leader.symbol),
      (symbol) => symbol
    ).slice(0, 4);
    const relatedThemes = uniqueBy(
      candidates.filter((leader) => leader.theme && storyText.includes(leader.theme)).map((leader) => leader.theme),
      (theme) => theme
    ).slice(0, 4);

    if (relatedSymbols.length === 0 && relatedThemes.length === 0) return headline;

    return {
      ...headline,
      ...(relatedSymbols.length > 0 ? { relatedSymbols } : {}),
      ...(relatedThemes.length > 0 ? { relatedThemes } : {})
    };
  });
}

export async function loadLeaderNewsHeadlines(leaders) {
  // Taken per market, not off the front of the combined list. The domestic
  // leaders arrive first and there are sixty of them, so slicing the whole list
  // spent every query on KR and left US company news out of the feed entirely.
  const leadersFor = (market) => leaders.filter((leader) => leader.market === market).slice(0, 8);
  const leaderQueries = uniqueBy(
    [...leadersFor("KR"), ...leadersFor("US")].map((leader) => (leader.market === "KR"
      ? { query: `${leaderSearchName(leader)} 주식`, region: "KR", language: "ko", label: "종목 뉴스" }
      : { query: `${leaderCompanySearchName(leader)} stock news`, region: "US", language: "en", label: "종목 뉴스" })),
    (item) => `${item.region}:${item.query}`
  ).slice(0, 16);
  const themeQueries = uniqueBy(
    leaders.flatMap((leader) => {
      const theme = leaderTheme(leader);

      if (!theme) return [];

      const terms = themeSearchTerms[theme];

      return [{
        query: leader.market === "KR" ? terms?.ko ?? `${theme} 주식` : terms?.en ?? `${theme} stocks`,
        region: leader.market,
        language: leader.market === "KR" ? "ko" : "en",
        label: `${theme} 테마`
      }];
    }),
    (item) => `${item.region}:${item.query}`
  ).slice(0, 4);
  const loaders = [...leaderQueries, ...themeQueries].map((item) =>
    googleNewsRssFeed(item.query, { region: item.region, language: item.language, label: item.label })
  );
  const headlines = dedupeNews((await settleFeeds(loaders)).filter(isMarketRelevant)).slice(0, 30);
  const tagged = attachLeaderNewsTags(headlines, leaders);
  const newHeadlineIds = await recordHeadlines(tagged.map((item) => item.id));

  return tagged.map((item) => ({ ...item, isNew: newHeadlineIds.has(item.id) }));
}

export async function loadNewsHeadlines(config) {
  return readThroughCache("news:headlines", cacheTtlMs, async () => {
    const loaders = [];

    if (config.news.feedUrl) {
      loaders.push(() => fetchJson(config.news.feedUrl, { timeoutMs: 2500 }));
    }

    naverQueries.forEach((query) => loaders.push(naverApiHubFeed(config, query)));
    naverQueries.forEach((query) => loaders.push(naverDevelopersFeed(config, query)));
    koreanNewsApiQueries.forEach((query) => loaders.push(newsApiFeed(config, query, { language: "ko", region: "KR" })));
    koreanRssQueries.forEach((query) => loaders.push(googleNewsRssFeed(query)));
    globalNewsApiQueries.forEach((query) => loaders.push(newsApiFeed(config, query, { language: "en", region: "US" })));
    loaders.push(finnhubFeed(config, "general"));
    loaders.push(finnhubFeed(config, "forex"));
    loaders.push(benzingaFeed(config));

    const relevant = (await settleFeeds(loaders)).filter(isMarketRelevant);
    const headlineFlow = await translateUsHeadlines(config, balanceByRegion(limitDominantLabels(dedupeNews(relevant))));
    const newHeadlineIds = await recordHeadlines(headlineFlow.map((item) => item.id));
    const detectedAt = new Date().toISOString();
    const withState = headlineFlow.map((item) => ({ ...item, isNew: newHeadlineIds.has(item.id) }));

    await recordHeadlineEvents(withState.filter((item) => item.isNew).map((item) => ({
      id: item.id,
      source: item.source,
      label: item.label,
      text: item.text,
      publishedAt: item.publishedAt,
      originalUrl: item.originalUrl,
      detectedAt
    })));

    const calendarItems = await loadEarningsCalendar(config).catch(() => []);

    return {
      ...(withState.length > 0 ? { headlineFlow: withState } : {}),
      ...(calendarItems.length > 0 ? { calendarItems } : {})
    };
  });
}
