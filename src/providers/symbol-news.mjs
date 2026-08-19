import { fetchText } from "../http.mjs";
import { readThroughCache } from "../cache.mjs";

/**
 * Dated announcements pulled out of each company's own news feed.
 *
 * The calendar held two things: KRX listings and Finnhub's earnings dates. That
 * misses everything a company schedules for itself — a data readout, a
 * conference call, an investor day. On 2026-08-19 the day's biggest US story was
 * Merck and Moderna's Phase 3 melanoma readout, and it appears in no earnings
 * calendar because it is not earnings.
 *
 * Yahoo's per-symbol RSS carries them, needs no key, and is the same host every
 * other quote here comes from. Only headlines that name a date are kept, and
 * only if that date has not passed: a calendar is a list of things that have not
 * happened yet, and a headline about yesterday belongs in the news flow.
 *
 * Bounded on purpose. One request per symbol, so it asks about the names on the
 * board rather than the whole watchlist, and caches for ten minutes.
 */

const cacheTtlMs = 10 * 60_000;
const maximumSymbols = 20;
const batchSize = 4;
const batchSpacingMs = 150;

const months = {
  april: 4, august: 8, december: 12, february: 2, january: 1, july: 7,
  june: 6, march: 3, may: 5, november: 11, october: 10, september: 9
};

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** "on August 20, 2026" and "August 20, 2026" both, but never a bare weekday. */
export function datedEvent(headline, today) {
  const match = headline.match(/\b([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b/);

  if (!match) return null;

  const month = months[match[1].toLowerCase()];

  if (!month) return null;

  const date = `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;

  return date >= today ? date : null;
}

function eventType(headline) {
  if (/\b(results|earnings|report)\b/i.test(headline)) return "실적";
  if (/\b(FDA|PDUFA|approval|Phase\s*[123])\b/i.test(headline)) return "임상·승인";
  if (/\b(conference|presentation|investor day|webcast|summit)\b/i.test(headline)) return "행사";

  return "이벤트";
}

async function loadSymbolFeed(symbol) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const xml = await fetchText(url, {
    timeoutMs: 4000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" }
  });

  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => ({
    headline: decodeXml(match[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
    url: decodeXml(match[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "")
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadSymbolCalendarItems(symbols, { today }) {
  const wanted = [...new Set(symbols)].slice(0, maximumSymbols);

  if (wanted.length === 0) return [];

  return readThroughCache(`symbol-news:${today}:${wanted.join(",")}`, cacheTtlMs, async () => {
    const items = new Map();

    for (let index = 0; index < wanted.length; index += batchSize) {
      const batch = wanted.slice(index, index + batchSize);
      const settled = await Promise.allSettled(batch.map(async (symbol) => {
        for (const entry of await loadSymbolFeed(symbol)) {
          const date = datedEvent(entry.headline, today);

          if (!date) continue;

          const id = `symbol-event-${symbol}-${date}`;

          if (items.has(id)) continue;

          items.set(id, {
            check: "회사 발표 원문과 발표 시각(현지)을 확인합니다",
            date,
            detail: entry.headline,
            id,
            market: "미국",
            originalUrl: entry.url || "#",
            source: `${symbol} IR·뉴스`,
            title: `${symbol} ${eventType(entry.headline)}`,
            type: eventType(entry.headline)
          });
        }
      }));

      settled.forEach((result) => {
        if (result.status === "rejected") {
          console.warn("symbol news failed", result.reason instanceof Error ? result.reason.message : result.reason);
        }
      });

      if (index + batchSize < wanted.length) await sleep(batchSpacingMs);
    }

    return [...items.values()];
  });
}
