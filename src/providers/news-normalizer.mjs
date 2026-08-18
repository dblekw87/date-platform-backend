/**
 * Normalizes headlines from providers with incompatible shapes (NewsAPI,
 * Finnhub, Benzinga, Naver, Google News RSS) into one headline DTO, then
 * removes duplicates that arrive through more than one of them.
 */

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function rawItemsFromFeed(feed) {
  if (Array.isArray(feed)) return feed;

  return feed?.items ?? feed?.articles ?? feed?.news ?? feed?.data ?? [];
}

function sourceName(source, fallback) {
  if (typeof source === "string" && source.trim()) return source.trim();
  if (source && typeof source === "object" && source.name?.trim()) return source.name.trim();

  return fallback?.trim() || "뉴스";
}

function publishedAtFromRaw(item) {
  const dateText = item.publishedAt || item.pubDate || item.created || item.updated;

  if (dateText) {
    const date = new Date(dateText);

    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  if (typeof item.datetime === "number") return new Date(item.datetime * 1000).toISOString();

  return new Date().toISOString();
}

function timeFromPublishedAt(publishedAt) {
  const date = new Date(publishedAt);

  if (Number.isNaN(date.getTime())) return "--:--";

  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(date);
}

function labelFromRaw(item) {
  const text = `${item.category ?? ""} ${item.label ?? ""} ${item.title ?? ""} ${item.headline ?? ""}`.toLowerCase();

  if (/rate|yield|fed|fomc|cpi|ppi|금리|환율|달러|물가/.test(text)) return "매크로";
  if (/earnings|guidance|실적|가이던스|컨센서스/.test(text)) return "실적";
  if (/battery|secondary battery|2차전지|배터리/.test(text)) return "2차전지";
  if (/semiconductor|\bchips?\b|hbm|반도체/.test(text)) return "반도체";
  if (/ai defense|defense ai|military ai|국방 ai|방산 ai|팔란티어|palantir/.test(text)) return "AI·방산";
  if (/\bai\b|artificial intelligence|data center|데이터센터|전력/.test(text)) return "AI 인프라";
  if (/bio|biotech|pharma|fda|바이오|제약|임상|승인/.test(text)) return "바이오";
  if (/aerospace|space|satellite|rocket|launch|항공우주|우주|위성|로켓|발사체/.test(text)) return "항공우주";
  // Ahead of 조선·방산 because both speak about the North and the defense rule
  // would otherwise take everything: today's one matching headline, about the
  // North and the alliance, came back labelled 조선·방산.
  //
  // Cooperation vocabulary only, never a bare 북한. A missile test belongs to
  // 방산 and moves defense names; a summit or a sanctions signal is what moves
  // 아난티 and 현대엘리베이터, and those are different stocks on the same day.
  if (/경협|개성공단|금강산|이산가족|남북정상|남북 대화|남북회담|종전선언|판문점|김정은|대북 제재/.test(text)) return "남북경협";
  if (/shipbuilding|shipyard|defense|missile|조선|방산|함정|미사일/.test(text)) return "조선·방산";
  if (/robot|automation|nuclear|uranium|로봇|자동화|원전|원자력/.test(text)) return "로봇·원전";
  if (/mlcc|capacitor|ceramic capacitor|적층세라믹|콘덴서|커패시터/.test(text)) return "MLCC·전자부품";
  if (/optical|photonics|coherent|networking|광통신|광모듈|광부품|네트워크/.test(text)) return "광통신·네트워크";
  if (/hydrogen|fuel cell|수소|연료전지/.test(text)) return "수소·연료전지";
  if (/renewable|solar|wind|신재생|재생에너지|태양광|풍력|해상풍력/.test(text)) return "재생에너지";
  if (/energy|oil|crude|fuel|gas|wti|lng|에너지|유가|가스/.test(text)) return "에너지";
  if (/\bauto\b|vehicle|vehicles|ev\b|자동차|전기차/.test(text)) return "자동차";
  if (/bank|banks|brokerage|은행|금융|증권/.test(text)) return "금융";
  if (/crypto|bitcoin|btc|가상자산|비트코인/.test(text)) return "암호화폐";
  if (/merger|acquisition|m&a|인수|합병/.test(text)) return "M&A";
  // 관세 belongs here rather than in its own bucket, and it has to be listed
  // explicitly: the fallback below returns the feed's own query string when no
  // rule matches, so "tariff stocks" was arriving as a label and sitting in the
  // same column as the Korean taxonomy.
  if (/policy|정책|규제|tariff|관세/.test(text)) return "정책";

  const fallback = item.label?.trim() || item.category?.trim();

  if (fallback && /주식$|stock news|earnings guidance|earnings revenue|guidance revenue/i.test(fallback)) return "종목 뉴스";
  if (fallback && !/^(general|business|stock market|stocks|news|headline|headlines)$/i.test(fallback)) return fallback;

  return "헤드라인";
}

function sourceDetailFromRaw(item) {
  const values = [item.label, item.category, item.type, item.newsType, item.urgency]
    .map((value) => value?.trim())
    .filter(Boolean);
  const text = `${values.join(" ")} ${item.title ?? ""} ${item.headline ?? ""}`;

  if (/속보|breaking|urgent|flash|newsflash/i.test(text)) return "속보";
  if (/단독|exclusive/i.test(text)) return "단독";
  if (/업데이트|종합|\bupdate\b|updated/i.test(text)) return "업데이트";
  if (/보도자료|press release|prnewswire|businesswire|globenewswire|globe newswire/i.test(text)) return "보도자료";

  return undefined;
}

function regionFromRaw(item) {
  if (item.region) return item.region;

  const text = `${sourceName(item.source, item.provider)} ${item.provider ?? ""} ${item.category ?? ""} ${item.title ?? ""} ${item.headline ?? ""} ${item.text ?? ""}`;

  if (/[가-힣]/.test(text)) return "KR";
  if (/naver|국내|korea|kospi|kosdaq/i.test(text)) return "KR";
  if (/finnhub|benzinga|newsapi|cnbc|reuters|nasdaq|nyse|america|us |u\.s\./i.test(text)) return "US";

  return "GLOBAL";
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function canonicalUrl(value) {
  if (!value || value === "#") return "";

  try {
    const url = new URL(value);

    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "cmpid"]
      .forEach((param) => url.searchParams.delete(param));
    url.hash = "";

    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.split("#")[0].replace(/\/$/, "").toLowerCase();
  }
}

function normalizeHeadlineKey(value) {
  return stripHtml(value)
    .toLowerCase()
    .replace(/\[[^\]]+\]|\([^)]*(속보|종합|단독|update|updated|exclusive)[^)]*\)/gi, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Same story, different outlet: compare the first words of the normalized
// headline within a region rather than the exact string.
function headlineFingerprint(item) {
  const normalized = normalizeHeadlineKey(item.text);
  const words = normalized.split(" ").filter(Boolean);
  const compact = words.length > 0 ? words.slice(0, 16).join(" ") : normalized;

  return `${item.region}|${compact}`.slice(0, 220);
}

function cleanNewsTitle(title, source) {
  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return title
    .replace(new RegExp(`\\s+-\\s+${escapedSource}\\s*$`, "i"), "")
    .replace(/\s+-\s+Google News\s*$/i, "")
    .trim();
}

export function normalizeNewsItem(item, index) {
  const rawTitle = stripHtml(item.headline?.trim() || item.title?.trim() || item.text?.trim() || "");

  if (!rawTitle) return null;

  const originalUrl = item.originalUrl || item.originallink || item.url || item.link || "#";
  const publishedAt = publishedAtFromRaw(item);
  const source = sourceName(item.source, item.provider);
  const title = cleanNewsTitle(rawTitle, source);

  return {
    id: item.id || `news-${hashString(`${originalUrl}|${publishedAt}|${title}`)}` || `news-${index}`,
    time: timeFromPublishedAt(publishedAt),
    source,
    sourceDetail: sourceDetailFromRaw(item),
    region: regionFromRaw(item),
    publishedAt,
    originalUrl,
    label: labelFromRaw(item),
    text: title,
    provider: "news",
    // The provider's own object, kept whole because normalization is lossy in a
    // way that cannot be undone later. What it drops - description, summary,
    // the feed's own category, the tickers some providers already tag - is
    // exactly what a headline classifier would want to read, and a feed only
    // carries a story for a day or two, so anything not captured on the tick
    // that saw it is gone. Stripped before the board is served; see
    // getMarketBoard.
    raw: item
  };
}

export function dedupeNews(items) {
  const seenUrls = new Set();
  const seenHeadlines = new Set();

  return [...items]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .filter((item) => {
      const urlKey = canonicalUrl(item.originalUrl);
      const headlineKey = headlineFingerprint(item);

      if (urlKey && seenUrls.has(urlKey)) return false;
      if (headlineKey && seenHeadlines.has(headlineKey)) return false;

      if (urlKey) seenUrls.add(urlKey);
      if (headlineKey) seenHeadlines.add(headlineKey);

      return true;
    });
}

export function normalizeNewsFeed(feed) {
  return dedupeNews(
    rawItemsFromFeed(feed)
      .map(normalizeNewsItem)
      .filter(Boolean)
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, 80)
  );
}
