import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";

/**
 * Listing and public-offering calendar from KRX KIND.
 *
 * KIND has no JSON API for these screens, so the two list endpoints are posted
 * to as the page's own XHR does and the returned HTML table is parsed. An
 * optional KRX_CALENDAR_FEED_URL can supply pre-normalized items alongside it.
 */

const cacheTtlMs = 3_600_000;
const listingUrl = "https://kind.krx.co.kr/listinvstg/listingcompany.do";
const offeringUrl = "https://kind.krx.co.kr/listinvstg/pubofrprogcom.do";
const offeringDetailUrl = "https://kind.krx.co.kr/listinvstg/pubofrprogcom.do?method=searchPubofrProgComMain";

function todaySeoulDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(new Date());
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00+09:00`);

  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}

function dayLabel(date) {
  const parsed = new Date(`${date}T00:00:00+09:00`);

  if (Number.isNaN(parsed.getTime())) return "";

  return new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "Asia/Seoul" })
    .format(parsed)
    .replace(".", "");
}

function compactDate(value) {
  const match = value?.match(/(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);

  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return decodeHtml(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "));
}

function htmlRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[0]);
}

function rowCells(html) {
  return [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripTags(match[1]));
}

// KIND marks the market (KOSPI/KOSDAQ) with an icon rather than text.
function rowMarket(html) {
  const alt = html.match(/<img\b[^>]*alt=['"]([^'"]+)['"]/i)?.[1];

  return alt ? decodeHtml(alt) : undefined;
}

function rowDetailUrl(html) {
  const detail = html.match(/fnDetailView\('([^']+)','([^']+)'\)/);

  if (!detail) return "https://kind.krx.co.kr/listinvstg/listingcompany.do?method=searchListingTypeMain";

  const params = new URLSearchParams({
    method: "searchListComDetailMain",
    scrnGb: "new",
    isurCd: detail[1],
    bzProcsNo: detail[2]
  });

  return `https://kind.krx.co.kr/listinvstg/listcomdetail.do?${params.toString()}`;
}

async function postKindHtml(url, body, refererMethod) {
  return fetchText(url, {
    method: "POST",
    timeoutMs: 6000,
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: `${url}?method=${refererMethod}`,
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
}

function dateRange(pastDays, futureDays) {
  const today = todaySeoulDate();

  return { fromDate: addDays(today, -pastDays), toDate: addDays(today, futureDays) };
}

function listingRequestBody() {
  const range = dateRange(90, 90);

  return new URLSearchParams({
    method: "searchListingTypeSub",
    forward: "listingtype_sub",
    currentPageSize: "50",
    pageIndex: "1",
    orderMode: "1",
    orderStat: "D",
    marketType: "",
    searchCorpName: "",
    searchCorpNameTmp: "",
    country: "",
    industry: "",
    repMajAgntDesignAdvserComp: "",
    repMajAgntComp: "",
    designAdvserComp: "",
    secuGrpArr: "ST|FS",
    secuGrpArrStr: "ST|FS",
    listTypeArr: "01",
    listTypeArrStr: "01",
    choicTypeArr: "02",
    choicTypeArrStr: "02|03|04|05|06",
    fromDate: range.fromDate,
    toDate: range.toDate
  });
}

function offeringRequestBody() {
  const range = dateRange(365, 1);

  return new URLSearchParams({
    method: "searchPubofrProgComSub",
    forward: "pubofrprogcom_sub",
    currentPageSize: "50",
    pageIndex: "1",
    orderMode: "1",
    orderStat: "D",
    searchMode: "",
    searchCodeType: "",
    marketType: "",
    searchCorpName: "",
    searchCorpNameTmp: "",
    isurCd: "",
    repIsuSrtCd: "",
    bzProcsNo: "",
    detailMarket: "",
    repMajAgntDesignAdvserComp: "",
    repMajAgntComp: "",
    designAdvserComp: "",
    fromDate: range.fromDate,
    toDate: range.toDate
  });
}

function normalizeListingRow(row, index) {
  const [name, listedAt, type, securityType, industry, country, broker, offerPrice, amount, product, firstShares] = rowCells(row);
  const date = compactDate(listedAt);

  if (!date || !name || name === "회사명") return null;

  const market = rowMarket(row);

  return {
    id: `kind-listing-${date}-${name}-${index}`,
    date,
    day: dayLabel(date),
    type: "신규상장",
    title: `${name} 신규상장`,
    market: "국내",
    check: "상장일 기준가, 유통 가능 물량, 공모가 대비 흐름",
    detail: [
      market ? `시장 ${market}` : null,
      type,
      securityType,
      industry,
      country,
      broker ? `주관 ${broker}` : null,
      offerPrice && offerPrice !== "-" ? `공모가 ${offerPrice}` : null,
      amount && amount !== "-" ? `공모금액 ${amount}` : null,
      product && product !== "-" ? `주요제품 ${product}` : null,
      firstShares && firstShares !== "-" ? `최초상장주식수 ${firstShares}주` : null
    ].filter(Boolean).join(" · "),
    source: "KIND 신규상장기업현황",
    originalUrl: rowDetailUrl(row)
  };
}

// One offering row yields up to two calendar entries: the subscription date and
// the expected listing date.
function normalizeOfferingRow(row, index) {
  const [name, submittedAt, demandSchedule, subscriptionSchedule, paymentDate, offerPrice, amount, expectedListingDate, broker] = rowCells(row);

  if (!name || name === "회사명") return [];

  const market = rowMarket(row);
  const detail = [
    market ? `시장 ${market}` : null,
    submittedAt ? `신고서 ${submittedAt}` : null,
    demandSchedule ? `수요예측 ${demandSchedule}` : null,
    subscriptionSchedule ? `청약 ${subscriptionSchedule}` : null,
    paymentDate ? `납입 ${paymentDate}` : null,
    offerPrice && offerPrice !== "-" ? `공모가 ${offerPrice}` : null,
    amount && amount !== "-" ? `공모금액 ${amount}백만원` : null,
    broker ? `주관 ${broker}` : null
  ].filter(Boolean).join(" · ");
  const subscriptionStart = compactDate(subscriptionSchedule);
  const expectedListing = compactDate(expectedListingDate);
  const events = [];

  if (subscriptionStart) {
    events.push({
      id: `kind-offering-subscription-${subscriptionStart}-${name}-${index}`,
      date: subscriptionStart,
      day: dayLabel(subscriptionStart),
      type: "공모주",
      title: `${name} 청약 시작`,
      market: "국내",
      check: "청약 일정, 확정 공모가, 환불·납입일",
      detail: detail || "공모 세부 일정을 확인합니다.",
      source: "KIND 공모기업현황",
      originalUrl: offeringDetailUrl
    });
  }

  if (expectedListing) {
    events.push({
      id: `kind-offering-listing-${expectedListing}-${name}-${index}`,
      date: expectedListing,
      day: dayLabel(expectedListing),
      type: "신규상장",
      title: `${name} 상장예정`,
      market: "국내",
      check: "상장예정일, 유통 가능 물량, 공모가 대비 기준",
      detail: detail || "상장예정 세부 조건을 확인합니다.",
      source: "KIND 공모기업현황",
      originalUrl: offeringDetailUrl
    });
  }

  return events;
}

function feedItems(feed) {
  if (Array.isArray(feed)) return feed;

  return feed?.items ?? feed?.data ?? feed?.result ?? [];
}

function normalizeFeedItem(item, index) {
  const date = compactDate(item.date ?? item.listingDate ?? item.ipoDate ?? item.subscriptionDate);
  const name = item.companyName ?? item.name ?? item.title;

  if (!date || !name) return null;

  const eventText = `${item.type ?? ""} ${item.eventType ?? ""} ${item.title ?? ""}`;
  const type = /상장|listing/i.test(eventText) ? "신규상장" : "공모주";
  const symbol = item.symbol ?? item.code;

  return {
    id: item.id ?? `krx-calendar-${date}-${symbol ?? index}`,
    date,
    day: item.day ?? dayLabel(date),
    type,
    title: type === "신규상장" ? `${name} 신규상장` : `${name} 공모 일정`,
    market: "국내",
    check: type === "신규상장" ? "상장일 유통물량과 기준가" : "수요예측, 청약일, 환불일",
    detail: [
      symbol ? `종목코드 ${symbol}` : null,
      item.marketName ? `시장 ${item.marketName}` : null,
      item.detail
    ].filter(Boolean).join(" · ") || "상장/공모 세부 조건과 유통 가능 물량을 확인합니다.",
    source: item.source ?? "KRX/KIND",
    originalUrl: item.originalUrl ?? item.url ?? item.link
  };
}

async function loadFeedCalendarItems(config) {
  if (!config.krx.calendarFeedUrl) return [];

  const feed = await fetchJson(config.krx.calendarFeedUrl, {
    timeoutMs: 4000,
    headers: { Accept: "application/json" }
  });

  return feedItems(feed).map(normalizeFeedItem).filter(Boolean).slice(0, 40);
}

export async function loadKrxCalendar(config) {
  return readThroughCache("krx:calendar", cacheTtlMs, async () => {
    const today = todaySeoulDate();
    const fromDate = addDays(today, -45);
    const toDate = addDays(today, 180);
    const results = await Promise.allSettled([
      postKindHtml(listingUrl, listingRequestBody(), "searchListingTypeMain")
        .then((html) => htmlRows(html).map(normalizeListingRow).filter(Boolean)),
      postKindHtml(offeringUrl, offeringRequestBody(), "searchPubofrProgComMain")
        .then((html) => htmlRows(html).flatMap(normalizeOfferingRow)),
      loadFeedCalendarItems(config)
    ]);
    const items = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const calendarItems = [...new Map(items.map((item) => [item.id, item])).values()]
      .filter((item) => item.date >= fromDate && item.date <= toDate)
      .sort((left, right) => left.date.localeCompare(right.date)
        || left.type.localeCompare(right.type)
        || left.title.localeCompare(right.title))
      .slice(0, 80);

    return calendarItems.length > 0 ? { calendarItems } : {};
  });
}
