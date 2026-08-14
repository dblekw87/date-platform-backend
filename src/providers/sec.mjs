import { readThroughCache } from "../cache.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { createRuntimeState } from "./runtime-state.mjs";

/**
 * SEC EDGAR current-filings feed, narrowed to forms that signal an actionable
 * event (8-K, 13D/G, S-1, 424B5, merger proxies, tender offers) and ranked so
 * the ones worth opening first come first.
 */

const disclosureCacheTtlMs = 60_000;
const tickerCacheTtlMs = 3_600_000;

const watchedForms = new Set([
  "8-K", "13D", "13G", "SC 13D", "SC 13G", "S-1", "424B5",
  "PREM14A", "DEFM14A", "SC TO-T", "SC TO-I"
]);

const material8KKeywords = [
  "acquisition", "agreement", "asset", "bankruptcy", "business combination",
  "change in control", "definitive merger agreement", "disposition",
  "entry into", "going private", "merger", "offering", "sale", "tender offer",
  "termination"
];

const eventRules = [
  { eventType: "인수합병 후보", score: 96, itemCodes: ["2.01"], keywords: ["merger", "business combination", "acquisition", "definitive merger agreement", "plan of merger", "tender offer", "going private"] },
  { eventType: "매각·자산처분 후보", score: 90, itemCodes: ["2.01", "2.05"], keywords: ["disposition", "asset sale", "sale of assets", "divestiture"] },
  { eventType: "증자·발행 후보", score: 84, itemCodes: ["3.02"], keywords: ["offering", "private placement", "registered direct", "securities purchase", "424b5"] },
  { eventType: "지배권 변경 후보", score: 82, itemCodes: ["5.01", "5.02"], keywords: ["change in control", "departure of directors", "appointment of officers"] },
  { eventType: "주요 계약 후보", score: 74, itemCodes: ["1.01", "1.02"], keywords: ["entry into", "material definitive agreement", "agreement"] },
  { eventType: "상장·재무 위험 후보", score: 68, itemCodes: ["1.03"], keywords: ["bankruptcy", "delisting", "non-compliance", "going concern"] }
];

const state = createRuntimeState("market-board-sec-state", () => ({
  events: [],
  seenAccessionsByCik: {}
}));

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#39;/g, "'")
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

function firstXmlAttribute(xml, tag, attribute) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]+)"`, "i"));

  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function isMaterial8K(description) {
  const normalized = description.toLowerCase();

  return material8KKeywords.some((keyword) => normalized.includes(keyword));
}

function extract8KItemCodes(text) {
  return [...new Set([...text.matchAll(/Item\s+([1-9]\.\d{2})/gi)].map((match) => match[1]))];
}

function classifySecEvent(form, description, documentText = "") {
  if (form.includes("13")) return { eventType: "지분 변동", score: 72 };
  if (form === "S-1" || form.startsWith("424B")) return { eventType: "증권 발행", score: 76 };
  if (form.includes("14A") || form.startsWith("SC TO")) return { eventType: "인수합병 후보", score: 88 };

  const itemCodes = extract8KItemCodes(documentText);
  const normalized = `${form} ${description} ${documentText.slice(0, 12_000)}`.toLowerCase();
  const matched = eventRules.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)))
    ?? eventRules.find((rule) => rule.itemCodes.some((code) => itemCodes.includes(code)));

  if (matched) return { eventType: matched.eventType, score: matched.score };

  return form === "8-K"
    ? { eventType: "8-K 원문 확인", score: 48 }
    : { eventType: "SEC 원문 확인", score: 44 };
}

function secHeaders(config, accept) {
  return {
    "User-Agent": config.sec.userAgent,
    Accept: accept
  };
}

async function loadTickerByCik(config) {
  return readThroughCache("sec:company-tickers", tickerCacheTtlMs, async () => {
    const tickerMap = await fetchJson("https://www.sec.gov/files/company_tickers.json", {
      headers: secHeaders(config, "application/json"),
      timeoutMs: 4000
    });
    const byCik = new Map();

    Object.values(tickerMap ?? {}).forEach((company) => {
      byCik.set(String(company.cik_str).padStart(10, "0"), company);
    });

    return byCik;
  });
}

async function loadCurrentSecFeed(config, type) {
  const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");

  url.searchParams.set("action", "getcurrent");
  url.searchParams.set("count", "100");
  url.searchParams.set("output", "atom");
  if (type) url.searchParams.set("type", type);

  const xml = await fetchText(url.toString(), {
    headers: secHeaders(config, "application/atom+xml"),
    timeoutMs: 5000
  });

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].flatMap((match) => {
    const entryXml = match[1];
    const title = firstXmlValue(entryXml, "title") ?? "";
    const summary = stripHtml(firstXmlValue(entryXml, "summary") ?? "");
    const form = firstXmlAttribute(entryXml, "category", "term") ?? title.split(" - ")[0]?.trim();
    const cik = title.match(/\((\d{10})\)/)?.[1];
    const companyName = title.match(/^[^-]+-\s+(.+?)\s+\(\d{10}\)/)?.[1]?.trim();
    const accessionNumber = summary.match(/AccNo:\s*([0-9-]+)/i)?.[1]
      ?? firstXmlValue(entryXml, "id")?.match(/accession-number=([0-9-]+)/)?.[1];
    const originalUrl = firstXmlAttribute(entryXml, "link", "href");
    const filedAt = firstXmlValue(entryXml, "updated") ?? new Date().toISOString();

    if (!form || !cik || !companyName || !accessionNumber || !originalUrl) return [];

    return [{ accessionNumber, cik, companyName, filedAt, form, originalUrl, summary }];
  });
}

async function loadCurrentSecFilings(config) {
  const feedTypes = [undefined, "8-K", "SC 13D", "SC 13G", "S-1", "424B5", "PREM14A", "DEFM14A", "SC TO-T", "SC TO-I"];
  const results = await Promise.allSettled(feedTypes.map((type) => loadCurrentSecFeed(config, type)));
  const byAccession = new Map();

  results.forEach((result) => {
    if (result.status !== "fulfilled") return;

    result.value.forEach((item) => {
      if (watchedForms.has(item.form) && !byAccession.has(item.accessionNumber)) {
        byAccession.set(item.accessionNumber, item);
      }
    });
  });

  return [...byAccession.values()];
}

// The first run has nothing to compare against, so nothing is flagged as new.
async function recordAccessions(cik, accessionNumbers) {
  const current = await state.read();
  const seen = current.seenAccessionsByCik[cik];

  if (!seen) {
    current.seenAccessionsByCik[cik] = accessionNumbers;
    await state.save(current);

    return new Set();
  }

  const seenSet = new Set(seen);
  const newAccessions = new Set(accessionNumbers.filter((accessionNumber) => !seenSet.has(accessionNumber)));

  current.seenAccessionsByCik[cik] = [...new Set([...seen, ...accessionNumbers])].slice(-100);
  await state.save(current);

  return newAccessions;
}

async function recordDisclosureEvents(events) {
  if (events.length === 0) return;

  const current = await state.read();
  const existingIds = new Set(current.events.map((event) => event.id));

  current.events = [...events.filter((event) => !existingIds.has(event.id)), ...current.events].slice(0, 200);
  await state.save(current);
}

export async function readSecDisclosureEvents() {
  return (await state.read()).events;
}

export async function loadSecDisclosures(config) {
  return readThroughCache("sec:disclosures", disclosureCacheTtlMs, async () => {
    const filings = await loadCurrentSecFilings(config);

    if (filings.length === 0) return {};

    const tickerByCik = await loadTickerByCik(config);
    const newAccessions = await recordAccessions("current-feed", filings.map((item) => item.accessionNumber));
    const ranked = filings
      .map((filing) => {
        const tickerInfo = tickerByCik.get(filing.cik);
        const symbol = tickerInfo?.ticker;
        const companyName = tickerInfo?.title ?? filing.companyName;
        const event = classifySecEvent(filing.form, filing.summary);
        const materialTag = filing.form === "8-K" && (isMaterial8K(filing.summary) || event.score >= 68)
          ? event.eventType
          : "SEC 원문";
        const isNew = newAccessions.has(filing.accessionNumber);

        return {
          id: `sec-${filing.cik}-${filing.accessionNumber}`,
          cik: filing.cik,
          market: "US",
          source: "SEC",
          urgency: filing.form.includes("13") ? "지분" : filing.form === "8-K" ? "공시" : "증권",
          companyName,
          symbol,
          issuerType: "unknown",
          eventType: event.eventType,
          accessionNumber: filing.accessionNumber,
          isNew,
          formType: filing.form,
          title: `${symbol ? `${symbol} · ` : ""}${companyName} · ${event.eventType}`,
          filedAt: filing.filedAt,
          originalUrl: filing.originalUrl,
          tags: ["SEC 전체", ...(isNew ? ["새 공시"] : []), materialTag, "조건 확인"],
          action: `${companyName} · 원문 Item 확인`,
          priorityScore: event.score + (isNew ? 30 : 0) + (symbol ? 8 : 0)
        };
      })
      .sort((left, right) => right.priorityScore - left.priorityScore || right.filedAt.localeCompare(left.filedAt))
      .slice(0, 30);

    await recordDisclosureEvents(ranked.filter((item) => item.isNew).map((item) => ({
      id: item.id,
      cik: item.cik,
      accessionNumber: item.accessionNumber,
      symbol: item.symbol ?? item.cik,
      companyName: item.companyName,
      issuerType: item.issuerType,
      eventType: item.eventType,
      formType: item.formType,
      filedAt: item.filedAt,
      originalUrl: item.originalUrl,
      detectedAt: new Date().toISOString()
    })));

    const usDisclosures = ranked.map(({ cik, priorityScore, ...disclosure }) => ({
      ...disclosure,
      symbol: disclosure.symbol ?? cik
    }));

    return usDisclosures.length > 0 ? { usDisclosures } : {};
  });
}
