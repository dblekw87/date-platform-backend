import { fetchJson, fetchText } from "../http.mjs";
import { query } from "../db/client.mjs";

/**
 * 미국 대통령 발언과 지정학 뉴스를 받아 geo_news에 쌓습니다.
 *
 * 2026-10-24 사용자 요청입니다: "이란 전쟁 및 우크라이나 러시아 전쟁 관련 알래스카
 * 사업 관련 이런 것들". 국내 방산·정유·재건·강관 테마가 이런 소식에 움직이는데,
 * 우리 미국 뉴스는 시장 매체와 보도자료뿐이라 발언 원문이 없었습니다.
 *
 * 출처마다 늦는 정도가 다릅니다. Truth Social 보관본이 가장 빠르고(공식 사이트는
 * Cloudflare 403), 백악관 RSS가 그다음, 연방관보는 서명된 문서라 하루 이틀 늦지만
 * "말"이 아니라 "조치"입니다. 구글 뉴스는 언론이 다룬 것이라 몇십 분 늦습니다.
 */

const userAgent = "Mozilla/5.0 (DATE market collector)";

/*
 * 주제는 시장이 반응하는 묶음으로 나눕니다. 순서는 알림에 찍히는 순서입니다.
 * 영문은 낱말 경계로, 한글은 그대로 찾습니다(한글엔 경계가 없음).
 */
export const geoTopics = [
  { id: "이란·중동", pattern: /\b(iran\w*|tehran|hormuz|israel\w*|hezbollah|houthi\w*)\b|이란|호르무즈|이스라엘|중동|후티/i },
  { id: "러·우 전쟁", pattern: /\b(ukrain\w*|russia\w*|putin|zelensk\w*|kremlin|kyiv|moscow)\b|우크라|러시아|푸틴|젤렌스키|종전|휴전/i },
  // 알래스카는 선거 유세 글에도 나옵니다(10/23 Truth 두 건). 사용자가 말한 것은
  // 알래스카 사업이라 영문은 에너지 낱말이 가까이 있을 때만 붙입니다.
  { id: "알래스카", pattern: /\balaska\w*\b[\s\S]{0,120}\b(lng|gas|pipeline|oil|drill\w*|energy|arctic|anwr)\b|\b(lng|gas|pipeline|oil|drill\w*|energy|arctic|anwr)\b[\s\S]{0,120}\balaska|알래스카/i },
  { id: "관세·무역", pattern: /\b(tariff\w*|trade deal|trade war|section 232|section 301)\b|관세|무역협상/i },
  { id: "반도체·중국", pattern: /\b(semiconductor\w*|chips?|nvidia|china|chinese|beijing|xi jinping|taiwan)\b|반도체|중국|시진핑|대만/i },
  { id: "금리·연준", pattern: /\b(federal reserve|the fed|interest rates?|powell|rate cut)\b|금리|연준/i },
  { id: "한국", pattern: /\b(korea\w*|seoul|pyongyang|kim jong)\b|한국|북한/i }
];

export function topicsOf(text) {
  return geoTopics.filter((topic) => topic.pattern.test(text)).map((topic) => topic.id);
}

/*
 * 주제 검색은 영문·국문을 같이 둡니다. 국문 검색은 국내 언론이 "국내 수혜주"로
 * 엮어 쓴 기사를 잡고, 영문은 원래 사건을 먼저 잡습니다.
 */
const googleQueries = [
  { language: "en", q: "Iran war" },
  { language: "en", q: "Strait of Hormuz" },
  { language: "en", q: "Russia Ukraine ceasefire" },
  { language: "en", q: "Ukraine peace talks" },
  { language: "en", q: "Alaska LNG" },
  { language: "ko", q: "이란 전쟁" },
  { language: "ko", q: "러시아 우크라이나 종전" },
  { language: "ko", q: "알래스카 LNG" }
];

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));

  return match ? decodeXml(match[1]) : null;
}

function rssItems(xml) {
  return [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
}

function plain(text) {
  return String(text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function dateOf(text) {
  const parsed = Date.parse(text ?? "");

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function truthPosts() {
  const xml = await fetchText("https://trumpstruth.org/feed", { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });

  return rssItems(xml).map((item) => {
    // 이미지만 올린 글은 제목이 비어 있습니다. 본문 첫 단락으로 메우고, 그래도
    // 없으면 버립니다 -- 텍스트 없는 글은 주제를 붙일 수 없습니다.
    const title = plain(xmlValue(item, "title")) || plain(xmlValue(item, "description"));
    const id = xmlValue(item, "truth:originalId") ?? xmlValue(item, "guid");

    return {
      key: `truth:${id}`,
      publishedAt: dateOf(xmlValue(item, "pubDate")),
      source: "트럼프 Truth",
      title,
      url: xmlValue(item, "truth:originalUrl") ?? xmlValue(item, "link")
    };
  });
}

async function whiteHouseNews() {
  const xml = await fetchText("https://www.whitehouse.gov/news/feed/", { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });

  return rssItems(xml).map((item) => ({
    key: `wh:${xmlValue(item, "guid") ?? xmlValue(item, "link")}`,
    publishedAt: dateOf(xmlValue(item, "pubDate")),
    source: "백악관",
    // 제목만으로는 주제가 안 보이는 성명이 많아(예: "Presidential Message") 요약
    // 첫 문장까지 붙여 주제를 찾습니다.
    summary: plain(xmlValue(item, "description")).slice(0, 300),
    title: plain(xmlValue(item, "title")),
    url: xmlValue(item, "link")
  }));
}

async function presidentialDocuments() {
  const url = "https://www.federalregister.gov/api/v1/documents.json?conditions%5Btype%5D%5B%5D=PRESDOCU&order=newest&per_page=20";
  const data = await fetchJson(url, { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });

  return (data?.results ?? []).map((row) => ({
    key: `fr:${row.document_number}`,
    // 게재일만 있습니다. 한국 시각 아침에 보이도록 미국 동부 08:45(게재 공개 시각)로 둡니다.
    publishedAt: row.publication_date ? new Date(`${row.publication_date}T12:45:00Z`).toISOString() : null,
    source: "연방관보",
    summary: plain(row.abstract).slice(0, 300),
    title: plain(row.title),
    url: row.html_url
  }));
}

async function googleTopicNews({ language, q }) {
  const region = language === "ko" ? "KR" : "US";
  const url = new URL("https://news.google.com/rss/search");

  url.searchParams.set("q", `${q} when:1d`);
  url.searchParams.set("hl", language);
  url.searchParams.set("gl", region);
  url.searchParams.set("ceid", `${region}:${language}`);

  const xml = await fetchText(url, { timeoutMs: 8000 });

  return rssItems(xml).slice(0, 15).map((item) => {
    const link = xmlValue(item, "link");

    return {
      key: `gn:${xmlValue(item, "guid") ?? link}`,
      publishedAt: dateOf(xmlValue(item, "pubDate")),
      source: xmlValue(item, "source") ?? "Google News",
      title: plain(xmlValue(item, "title")),
      url: link
    };
  });
}

export async function collectGeoNews(config) {
  const loaders = [truthPosts, whiteHouseNews, presidentialDocuments, ...googleQueries.map((entry) => () => googleTopicNews(entry))];
  const settled = await Promise.allSettled(loaders.map((load) => load()));
  const failed = settled.filter((result) => result.status === "rejected").length;
  const items = settled
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((item) => item.title && item.key && !item.key.endsWith(":null"))
    .map((item) => ({ ...item, topics: topicsOf(`${item.title} ${item.summary ?? ""}`) }));

  if (items.length === 0) return { failed, saved: 0 };

  const result = await query(config, `
    INSERT INTO geo_news (key, source, title, url, published_at, topics)
    SELECT DISTINCT ON (key) key, source, title, url, published_at, topics
      FROM jsonb_to_recordset($1::jsonb)
        AS t(key text, source text, title text, url text, published_at timestamptz, topics text[])
    ON CONFLICT (key) DO NOTHING
  `, [JSON.stringify(items.map((item) => ({
    key: item.key,
    published_at: item.publishedAt,
    source: item.source,
    title: item.title.slice(0, 2000),
    topics: item.topics,
    url: item.url
  })))]);

  return { failed, saved: result.rowCount };
}
