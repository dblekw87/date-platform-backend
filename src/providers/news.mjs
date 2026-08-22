import { readThroughCache } from "../cache.mjs";
import { query } from "../db/client.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { dedupeNews, normalizeNewsFeed } from "./news-normalizer.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { classifyTheme } from "./themes.mjs";
import { loadActiveThemes, themeQueryTerm } from "./active-themes.mjs";
import { sessionDate } from "./market-session.mjs";

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
// On Naver and the Google feed, not NewsAPI. Those two carry the Korean side
// and neither is metered the way NewsAPI is.
const activeThemeQueryLimit = 12;
const naverQueries = ["국내 증시", "코스피 코스닥", "미국 증시", "금리 환율", "원달러 환율", "반도체 2차전지", "AI 데이터센터", "전력 설비", "바이오 제약", "조선 방산", "방산 수출", "로봇 원전", "우주 항공", "자동차 은행", "정책 수혜", "인수합병 공시", "남북 경협", "대북 정책"];
// Six queries at two-hour spacing, which is the whole NewsAPI budget.
//
// A developer key allows a hundred requests a day and this file was asking for
// twenty-seven per sample - about 1,800 a day against that hundred, so the key
// was exhausted within minutes of the first morning sample and answered 429 for
// the rest of the day. Measured 2026-08-18, mid-afternoon: rateLimited.
//
// Kept rather than dropped because of what it uniquely carries. Of the 51
// outlets it supplied, 47 appear in no other feed - 120 articles Google News
// and Naver never produced. It is 20% of the corpus by volume and most of its
// breadth.
//
// Korean queries are gone: Naver and the Google feed cover that side far
// better, and the budget buys more where NewsAPI is actually unique.
const newsApiQueries = ["stock market", "earnings", "semiconductor stocks", "ai stocks", "biotech stocks", "tariff stocks"];
const newsApiIntervalMs = 2 * 60 * 60_000;

let lastNewsApiAt = 0;
const koreanRssQueries = ["국내 증시", "코스피 코스닥", "미국 증시", "반도체 주식", "AI 데이터센터 주식", "전력 설비 주식", "2차전지 주식", "바이오 제약 주식", "조선 방산 주식", "방산 수출 주식", "로봇 원전 주식", "우주 항공 주식", "수소 연료전지 주식", "재생에너지 태양광 풍력 주식", "정책 수혜주", "국내 공시 인수합병", "남북 경협주", "대북 정책 수혜주"];

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

const marketRelevancePattern = /주식|증시|시장|코스피|코스닥|환율|금리|국채|선물|외국인|기관|거래량|거래대금|반도체|패키지기판|기판|2차전지|배터리|바이오|제약|항공우주|우주|위성|로켓|조선|방산|로봇|원전|mlcc|콘덴서|커패시터|광통신|광모듈|광부품|네트워크|자동차|은행|금융|증권|에너지|유가|가상자산|비트코인|전력|수소|연료전지|신재생|재생에너지|태양광|풍력|AI|데이터센터|인수|합병|매각|공시|실적|가이던스|정책|규제|남북|대북|경협|개성공단|금강산|종전선언|판문점|김정은|주가|주주|자사주|순매수|순매도|수급|공매도|배당|증자|상장|수혜주|관련주|테마주|목표주가|시가총액|시총|밸류업|개미|투자자|펀드|채권|회사채|메자닌|전환사채|관세|무역|수출|어닝|매출|영업이익|적자|흑자|증권가|애널리스트|리포트|반등|급등|급락|강세|약세|임상|항암|신약|stock|stocks|market|shares|nasdaq|nyse|dow|s&p|russell|futures|etf|fed|fomc|cpi|ppi|yield|treasury|rate|rates|inflation|dollar|currency|oil|crude|fuel|gold|energy|renewable|hydrogen|fuel cell|solar|wind|earnings|guidance|merger|acquisition|m&a|sale|sec|fda|semiconductor|chip|chips|battery|biotech|pharma|aerospace|space|satellite|rocket|launch|capacitor|optical|photonics|coherent|networking|bank|banks|brokerage|defense|shipbuilding|robot|nuclear|crypto|bitcoin|ai|data center|tariff|regulation|dividend|revenue|profit|buyback|analyst|valuation|ipo|price target/i;

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

const listedNamesTtlMs = 6 * 60 * 60_000;

/**
 * Every listed name the collector has seen, as a relevance signal of its own.
 *
 * A headline naming a listed company is market news whether or not it uses any
 * of the words above — "LG화학, 차세대 면역항암제 개발 속도" and "40兆 소각하는
 * SK하이닉스" both failed the keyword rule. Measured over 2,684 domestic items:
 * keywords alone left 8% unmatched, the widened vocabulary 3.5%, and adding the
 * names 2.2% — and what remains at 2.2% is spam and clickbait.
 */
async function loadListedNames(config) {
  return readThroughCache("kr-listed-names", listedNamesTtlMs, async () => {
    const result = await query(
      config,
      `SELECT DISTINCT ON (name) name, theme
         FROM market_price_samples
        WHERE market = 'KR' AND name IS NOT NULL AND length(name) >= 3
        ORDER BY name, observed_at DESC`
    );

    // Longest first, so 한화오션 is read before 한화. Korean has no word
    // boundary, so the shorter name is always a substring of the longer one and
    // whichever is tested first wins.
    return result.rows
      .map((row) => ({ name: row.name, theme: row.theme }))
      .sort((left, right) => right.name.length - left.name.length);
  }).catch(() => []);
}

/**
 * Whether a story belongs in the corpus.
 *
 * The label used to vouch for the item, which was circular: the label came from
 * the search that found it, so a lottery result fetched by a "2차전지 주식"
 * query passed the gate on the strength of the query that fetched it. Only the
 * article speaks for the article now.
 */
function isMarketRelevant(item, listed = []) {
  if (marketRelevancePattern.test(item.text)) return true;

  return listed.some((entry) => item.text.includes(entry.name));
}

/**
 * The theme of the company a headline names, for the stories the word rules
 * cannot place.
 *
 * "에코프로비엠, 양극재 신규 수주" and "40兆 소각하는 SK하이닉스" carry no theme
 * vocabulary at all, and the search query used to supply one — which is the
 * same mechanism that filed a lottery result under 2차전지. The company the
 * story is about is a better answer than the query that found it, and the
 * collector already knows what theme every name it has seen belongs to.
 */
function themeLabelFor(item, listed) {
  if (item.label !== "헤드라인" || item.region !== "KR") return item.label;

  const named = listed.find((entry) => entry.theme && entry.theme !== "미분류" && item.text.includes(entry.name));

  return named ? named.theme : item.label;
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

const maximumEarnings = 90;
const maximumEarningsPerDay = 6;

async function loadEarningsCalendar(config) {
  if (!config.news.finnhubApiKey) return [];

  const from = todaySeoulDate();
  const response = await fetchJson(buildUrl("https://finnhub.io/api/v1/calendar/earnings", {
    from,
    to: addDays(from, 21),
    token: config.news.finnhubApiKey
  }), { timeoutMs: 3000 });

  // Finnhub answers newest date first. Slicing that took the far end of the
  // window and threw away everything near — on 2026-08-19 the calendar showed
  // nothing until 09-07 while 72 companies reported that same day.
  //
  // Sorted forward, and then thinned, because the raw list is not a calendar
  // anybody can read: 495 rows over three weeks, 72 of them on one date. The
  // ones kept are the largest by expected revenue, which is the closest thing
  // the feed carries to "a name that moves the tape".
  const ordered = [...(response?.earningsCalendar ?? [])].sort((left, right) =>
    String(left.date).localeCompare(String(right.date))
      || (right.revenueEstimate ?? -1) - (left.revenueEstimate ?? -1));
  const perDay = new Map();

  return ordered
    .filter((item) => {
      const seen = perDay.get(item.date) ?? 0;

      if (seen >= maximumEarningsPerDay) return false;

      perDay.set(item.date, seen + 1);

      return true;
    })
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
    .slice(0, maximumEarnings);
}

function leaderSearchName(leader) {
  // The comma is part of the suffix. "Moderna, Inc." was becoming "Moderna,"
  // and then never matching a headline, because headlines write "Moderna and
  // Merck", not "Moderna,". Every US name in this shape was affected.
  return leader.name.replace(/[,\s]+(Inc\.?|Corporation|Corp\.?|Ltd\.?|PLC|Co\.?)$/i, "").replace(/[,\s]+$/, "").trim();
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

// Word boundaries, because the things being looked for are short enough to
// live inside ordinary words: the ticker MRNA inside "mRNA", a one-word name
// like Gap inside "the gap between". Tickers are matched case-sensitively for
// the same reason - lowercased, MRNA is the molecule, and a Tempus AI story
// about an mRNA melanoma trial was being tagged as Moderna and shown on
// Moderna's row. Names stay case-insensitive; headlines are inconsistent
// about those. Korean has no boundaries to find, so it is matched whole.
function textIncludesTerm(text, term, { matchCase = false } = {}) {
  if (/^\d+$/.test(term)) return text.includes(term);
  if (!/[A-Za-z]/.test(term)) return text.includes(term);

  return new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, matchCase ? "" : "i").test(text);
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
          && ((leader.name && textIncludesTerm(text, leader.name))
            || (leader.companyName && textIncludesTerm(text, leader.companyName))
            || textIncludesTerm(text, leader.symbol, { matchCase: true })))
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
  const listed = await loadListedNames(config);
  const headlines = dedupeNews((await settleFeeds(loaders))
    .filter((item) => isMarketRelevant(item, listed))
    .map((item) => ({ ...item, label: themeLabelFor(item, listed) }))).slice(0, 30);
  const tagged = attachLeaderNewsTags(headlines, leaders);
  const newHeadlineIds = await recordHeadlines(tagged.map((item) => item.id));

  return tagged.map((item) => ({ ...item, isNew: newHeadlineIds.has(item.id) }));
}

/** Today's moving themes, and never a failure that costs the whole news pull. */
async function activeThemeQueries(config) {
  try {
    return await loadActiveThemes(config, sessionDate("KR"), { limit: activeThemeQueryLimit });
  } catch (error) {
    console.warn("active theme queries unavailable", error instanceof Error ? error.message : error);

    return [];
  }
}

export async function loadNewsHeadlines(config) {
  return readThroughCache("news:headlines", cacheTtlMs, async () => {
    const loaders = [];

    if (config.news.feedUrl) {
      loaders.push(() => fetchJson(config.news.feedUrl, { timeoutMs: 2500 }));
    }

    naverQueries.forEach((query) => loaders.push(naverApiHubFeed(config, query)));
    naverQueries.forEach((query) => loaders.push(naverDevelopersFeed(config, query)));
    koreanRssQueries.forEach((query) => loaders.push(googleNewsRssFeed(query)));

    // The fixed queries above name eighteen themes because somebody thought of
    // them. These are the themes carrying money today, whatever they are, so
    // 탈모 치료 and 페라이트 get searched on the day they run rather than never.
    // The Google feed only: Naver's search has a quota and the fixed list
    // already spends it.
    for (const { theme } of await activeThemeQueries(config)) {
      const terms = themeSearchTerms[theme];

      loaders.push(googleNewsRssFeed(terms?.ko ?? themeQueryTerm(theme), { label: `${theme} 테마` }));
    }

    if (Date.now() - lastNewsApiAt >= newsApiIntervalMs) {
      lastNewsApiAt = Date.now();
      newsApiQueries.forEach((query) => loaders.push(newsApiFeed(config, query, { language: "en", region: "US" })));
    }

    loaders.push(finnhubFeed(config, "general"));
    loaders.push(finnhubFeed(config, "forex"));
    loaders.push(benzingaFeed(config));

    const listed = await loadListedNames(config);
    const relevant = (await settleFeeds(loaders))
      .filter((item) => isMarketRelevant(item, listed))
      .map((item) => ({ ...item, label: themeLabelFor(item, listed) }));
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
