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
  { id: "금리·연준", pattern: /\b(federal reserve|the fed|interest rates?|powell|rate cut|fomc|federal open market committee)\b|금리|연준|금융통화위원회|통화정책/i },
  { id: "한국", pattern: /\b(korea\w*|seoul|pyongyang|kim jong)\b|한국|북한/i },
  // SEC는 하루 수십 건이 절차 성명·제재라 시장이 보는 것(코인·ETF·상장·토큰화)만 붙입니다(11/01).
  // 다른 출처에서 'ETF'가 잡히면 소음이라 SEC 출처에만 씁니다.
  { id: "SEC·코인·상장", pattern: /\b(crypto\w*|digital assets?|bitcoin|ether(eum)?|stablecoins?|tokeni[sz]\w*|tokens?|etfs?|etps?|exchange-traded|listing standards?|ipos?)\b/i, secOnly: true }
];

export function topicsOf(text, { sec = false } = {}) {
  return geoTopics.filter((topic) => (sec || !topic.secOnly) && topic.pattern.test(text)).map((topic) => topic.id);
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

/*
 * 연준 통화정책 보도자료(2026-10-25). 성명·의사록·경제전망만 받습니다 -- 같은 피드의
 * 재할인율 회의록은 시장이 반응하지 않습니다.
 *
 * 성명 제목은 늘 "Federal Reserve issues FOMC statement"라 결정이 안 보입니다. 처음
 * 보는 성명만 본문을 열어 "decided to raise/lower/maintain the target range ..."
 * 문장을 제목에 붙입니다. 한 번 저장한 것은 다시 열지 않습니다.
 */
async function fedPress(config) {
  const xml = await fetchText("https://www.federalreserve.gov/feeds/press_monetary.xml", { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });
  const items = rssItems(xml)
    .map((item) => ({
      key: `fed:${xmlValue(item, "guid") ?? xmlValue(item, "link")}`,
      publishedAt: dateOf(xmlValue(item, "pubDate")),
      source: "연준",
      title: plain(xmlValue(item, "title")),
      url: xmlValue(item, "link")
    }))
    .filter((item) => /FOMC statement|Minutes of the Federal Open Market Committee|economic projections/i.test(item.title));
  const statements = items.filter((item) => /FOMC statement/i.test(item.title) && item.url);
  const { rows } = statements.length
    ? await query(config, "SELECT key FROM geo_news WHERE key = ANY($1::text[])", [statements.map((item) => item.key)])
    : { rows: [] };
  const known = new Set(rows.map((row) => row.key));

  for (const item of statements.filter((statement) => !known.has(statement.key))) {
    const html = await fetchText(item.url, { headers: { "User-Agent": userAgent }, timeoutMs: 10000 }).catch(() => "");
    // "by 1/4 percentage point to 3-3/4 to 4 percent," -- 끝은 쉼표·마침표 앞의 percent입니다.
    const match = plain(html).match(/decided to (raise|lower|maintain) the target range for the federal funds rate[^.]*?percent(?=[,.])/i);

    if (match) item.title = `FOMC 금리 ${{ lower: "인하", maintain: "동결", raise: "인상" }[match[1].toLowerCase()]} — ${match[0]}`;
  }

  return items;
}

/*
 * 한국은행 보도자료(통화정책) RSS. 통화정책방향과 금통위 의사록만 받습니다. 통화정책방향은
 * 설명란 첫 단락이 결정 문장이라("기준금리를 현재의 3.00% 수준에서 유지하여 … 하였다")
 * 그 문장을 제목에 붙입니다.
 */
async function bokPress() {
  const xml = await fetchText("https://www.bok.or.kr/portal/bbs/P0000559/news.rss?menuNo=200690", { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });

  return rssItems(xml)
    .map((item) => {
      const title = plain(xmlValue(item, "title"));
      const decision = plain(decodeXml(xmlValue(item, "description") ?? "")).replace(/&nbsp;/g, " ").replace(/\s+/g, " ")
        // 문장 안에 "3.00%"가 있어 마침표로 자르면 안 됩니다.
        .match(/금융통화위원회는[\s\S]{0,120}?기준금리를[\s\S]{0,120}?하였다/)?.[0];

      return {
        key: `bok:${xmlValue(item, "link")}`,
        publishedAt: dateOf(xmlValue(item, "pubDate")),
        source: "한국은행",
        title: decision ? `${title} — ${decision}` : title,
        url: xmlValue(item, "link")
      };
    })
    .filter((item) => /통화정책방향|금융통화위원회 의사록/.test(item.title));
}

/*
 * 2026-11-01 사용자 요청으로 넓힌 출처: SEC, 연준 연설, 재무부, 외국 정상.
 *
 * SEC는 위원장·위원 성명과 보도자료 RSS를 받습니다. SEC는 연락처가 든 User-Agent를
 * 요구합니다(공시 파이프라인과 같은 값).
 */
async function secFeed(config, feed, label) {
  const xml = await fetchText(`https://www.sec.gov/news/${feed}.rss`, { headers: { "User-Agent": config.sec?.userAgent ?? userAgent }, timeoutMs: 10000 });

  return rssItems(xml).map((item) => ({
    key: `sec:${xmlValue(item, "guid") ?? xmlValue(item, "link")}`,
    publishedAt: dateOf(xmlValue(item, "pubDate")),
    source: label,
    summary: plain(xmlValue(item, "description")).slice(0, 300),
    title: plain(xmlValue(item, "title")),
    url: xmlValue(item, "link")
  }));
}

/*
 * 연준 연설. 감독·규제 연설이 절반이라 의장 연설과 경기·물가·통화정책을 말하는 것만
 * '금리·연준'으로 붙입니다. 제목이 "Waller, The Signaling Value of ..." 꼴입니다.
 */
async function fedSpeeches() {
  const xml = await fetchText("https://www.federalreserve.gov/feeds/speeches.xml", { headers: { "User-Agent": userAgent }, timeoutMs: 10000 });

  return rssItems(xml).map((item) => {
    const title = plain(xmlValue(item, "title"));
    const policy = /^powell\b/i.test(title) || /\b(outlook|inflation|monetary|economy|economic|rates?|labor|projections?|policy)\b/i.test(title);

    return {
      forcedTopics: policy ? ["금리·연준"] : [],
      key: `fedsp:${xmlValue(item, "guid") ?? xmlValue(item, "link")}`,
      publishedAt: dateOf(xmlValue(item, "pubDate")),
      source: "연준 연설",
      title,
      url: xmlValue(item, "link")
    };
  });
}

/*
 * 외국 정상과 재무장관은 공식 RSS가 없거나 들쭉날쭉해서 영문 구글 뉴스로 받습니다.
 * 언론 보도라 같은 발언이 매체마다 여러 번 잡히므로, 알림은 인물당 최신 1건만 하루 두 번
 * 요약으로 보냅니다(geo-news-alert). source에 인물 이름을 넣어 그 묶음을 만듭니다.
 * 재무부 보도자료 RSS는 404라(11/01 확인) 재무장관도 이 경로입니다.
 */
export const leaderQueries = [
  { label: "시진핑", name: /\bXi\b/, q: "\"Xi Jinping\" says" },
  { label: "푸틴", name: /\bPutin\b|\bKremlin\b/, q: "Putin says" },
  { label: "젤렌스키", name: /\bZelensk/, q: "Zelensky says" },
  { label: "네타냐후", name: /\bNetanyahu\b/, q: "Netanyahu says" },
  { label: "이란 지도부", name: /\bKhamenei\b|\bPezeshkian\b|\bAraghchi\b/, q: "Khamenei OR Pezeshkian OR Araghchi says" },
  { label: "일본 총리", name: /\bTakaichi\b|\bJapan(ese)? (PM|prime minister)\b/i, q: "Takaichi says" },
  { label: "미 재무장관", name: /\bBessent\b/, q: "Bessent says" }
];

/*
 * 11/01 첫 수집에서 검색어만으로는 엉뚱한 기사가 섞였습니다("시진핑" 검색에 멜라니아
 * 순방 기사, "일본 총리"에 메르츠 기사, "재무장관"에 루비오 발언). 그래서 제목에 그 인물
 * 이름과 발언 동사(또는 "…: 푸틴" 꼴 인용)가 같이 있을 때만 받습니다.
 */
const speechVerb = /\b(says?|said|warns?|vows?|tells?|urges?|calls? for|threatens?|signals?|rejects?|claims?|insists?)\b/i;
// 집계 사이트가 붙이는 꼬리(": 11 outlets compared", ": how 6 outlets framed it").
const aggregatorTail = /:\s*(how\s+)?\d+\s+outlets?\b.*$/i;

function spokenBy(title, name) {
  const match = title.match(name);

  if (!match) return false;

  // 인물 이름 뒤 80자 안에 발언 동사가 오거나, "…: 크렘린"처럼 콜론 뒤 인용 출처가 그 인물.
  const after = title.slice(match.index, match.index + match[0].length + 80);
  const attribution = title.match(/:\s*([^:]{2,40})$/)?.[1] ?? "";

  return speechVerb.test(after) || name.test(attribution);
}

async function leaderNews({ label, name, q }) {
  const rows = await googleTopicNews({ language: "en", q });

  return rows
    .map((row) => ({ ...row, title: row.title.replace(/\s+-\s+[^-]{2,60}$/, "").replace(aggregatorTail, "").trim() }))
    .filter((row) => spokenBy(row.title, name))
    .slice(0, 5)
    .map((row) => ({ ...row, forcedTopics: ["발언"], key: `ld:${row.key}`, source: `외국 정상 · ${label}` }));
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
  const loaders = [
    truthPosts, whiteHouseNews, presidentialDocuments, fedPress, bokPress, fedSpeeches,
    () => secFeed(config, "statements", "SEC 성명"),
    () => secFeed(config, "pressreleases", "SEC 보도자료"),
    ...googleQueries.map((entry) => () => googleTopicNews(entry)),
    ...leaderQueries.map((entry) => () => leaderNews(entry))
  ];
  const settled = await Promise.allSettled(loaders.map((load) => load(config)));
  const failed = settled.filter((result) => result.status === "rejected").length;
  const items = settled
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((item) => item.title && item.key && !item.key.endsWith(":null"))
    .map((item) => ({
      ...item,
      topics: [...new Set([...(item.forcedTopics ?? []), ...topicsOf(`${item.title} ${item.summary ?? ""}`, { sec: item.key.startsWith("sec:") })])]
    }));

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
