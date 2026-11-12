import { fetchJson, fetchText } from "../http.mjs";
import { query } from "../db/client.mjs";
import { translateToKorean } from "./translate.mjs";

/**
 * 미국 급등 종목의 "왜"를 알림에 붙입니다. SEC 공시와 보도자료, 한국어 번역까지.
 *
 * 2026-11-12 사용자가 토스증권 해외 프리마켓 급등 화면(칠드런스 플레이스 +444%,
 * 파오스 +213% ...)을 보여주며 "이런 뉴스는 어디서 가져오나, 벤징가·GlobeNewswire·
 * PR Newswire·Business Wire·ACCESS Newswire에서 가져와서 번역해 텔레그램에" 요청.
 * 같은 밤 확인한 원천:
 *   PLCE  챕터11 파산보호 → Benzinga 장후 기사(우리 뉴스에 있었음)
 *   ICMB  합병 계약 → 17:27 Seeking Alpha, 8-K는 22:37 (보도자료가 다섯 시간 빠름)
 *   ADXN  6-K 20:05 → 우리 뉴스엔 없었음
 *
 * 그래서 세 갈래를 봅니다.
 *   1. SEC EDGAR 제출 목록(data.sec.gov/submissions) -- 8-K 항목 번호를 한국어로
 *   2. 우리가 이미 받는 미국 뉴스(GlobeNewswire·PR Newswire·BusinessWire·Benzinga 등이
 *      market_news_items에 들어옴)에서 종목이 붙은 것
 *   3. 구글 뉴스 영문 RSS를 그 종목 이름으로 한 번 -- 배포사 피드는 전체 흐름이라 소형주
 *      한 건을 놓칠 수 있고(ACCESS Newswire는 피드가 없음), 구글이 다섯 배포사를 다 덮습니다.
 *      벤징가 API 키는 무료 티어가 없어 비어 있습니다.
 *
 * **판단이 아니라 설명입니다.** 미국 급등은 뉴스로 미리 못 맞혔고(회전율만 살아남음,
 * us-surge-findings) 이건 오른 뒤에 이유를 읽는 칸입니다.
 *
 * 절대 던지지 않습니다. 무엇이 실패해도 빈 목록을 돌려줘 알림은 그대로 나갑니다.
 * 번역은 비공식 구글 번역이라 막히면 원문으로 갑니다(translate.mjs).
 */

const wireSources = /globenewswire|pr ?newswire|business ?wire|access ?newswire|accesswire|benzinga|stock ?titan|newsfile/i;

const formLabels = {
  "10-Q": "분기보고서",
  "424B4": "공모 확정(증권 발행)",
  "424B5": "추가 공모(증권 발행)",
  "425": "합병 관련 공시",
  "6-K": "외국기업 수시공시",
  "8-K": "수시공시",
  "8-K/A": "수시공시 정정",
  "F-1": "공모 등록",
  "S-1": "공모 등록",
  "SC 13D": "5% 이상 지분 취득",
  "SC 13D/A": "5% 이상 지분 변동",
  "SCHEDULE 13D": "5% 이상 지분 취득",
  "SCHEDULE 13D/A": "5% 이상 지분 변동"
};

const itemLabels = {
  "1.01": "중요 계약 체결",
  "1.02": "중요 계약 해지",
  "1.03": "파산·법정관리",
  "2.01": "자산 인수·처분 완료",
  "2.02": "실적 발표",
  "2.03": "채무 발생",
  "3.01": "상장유지 미달·상장폐지 통지",
  "3.02": "주식 사모 발행",
  "3.03": "주주 권리 변경",
  "5.01": "지배권 변경",
  "5.02": "임원·이사 변동",
  "5.03": "정관 변경(역분할 등)",
  "5.07": "주총 결과",
  "7.01": "보도자료(공정공시)",
  "8.01": "기타 중요 사항"
};

let tickerMap = null;
let tickerMapAt = 0;

async function cikOf(config, symbol) {
  if (!tickerMap || Date.now() - tickerMapAt > 24 * 60 * 60_000) {
    const data = await fetchJson("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": config.sec.userAgent },
      timeoutMs: 10_000
    });

    tickerMap = new Map(Object.values(data ?? {}).map((row) => [String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, "0")]));
    tickerMapAt = Date.now();
  }

  return tickerMap.get(symbol.toUpperCase()) ?? null;
}

function kst(date) {
  return new Date(date).toLocaleString("ko-KR", { day: "2-digit", hour: "2-digit", hour12: false, minute: "2-digit", month: "2-digit", timeZone: "Asia/Seoul" })
    .replace(/\.\s*/g, "/").replace(/\/(\d{2}:)/, " $1").replace(/\/\s*$/, "");
}

async function loadFilings(config, symbol, since) {
  const cik = await cikOf(config, symbol);

  if (!cik) return [];

  const data = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": config.sec.userAgent },
    timeoutMs: 8000
  });
  const recent = data?.filings?.recent;

  if (!recent) return [];

  const rows = [];

  for (let index = 0; index < Math.min(recent.form.length, 20); index += 1) {
    const at = new Date(recent.acceptanceDateTime[index]);

    if (at < since) break;
    if (!formLabels[recent.form[index]]) continue;

    const items = String(recent.items?.[index] ?? "").split(",").map((item) => item.trim()).filter((item) => itemLabels[item]);
    const accession = recent.accessionNumber[index];

    rows.push({
      at,
      form: recent.form[index],
      label: items.length ? items.map((item) => itemLabels[item]).join(" · ") : formLabels[recent.form[index]],
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${recent.primaryDocument[index]}`
    });
  }

  return rows.slice(0, 3);
}

async function loadStoredNews(config, symbol, since) {
  const { rows } = await query(config, `
    SELECT headline, source, original_url, published_at
      FROM market_news_items
     WHERE region = 'US' AND $1 = ANY(related_symbols) AND published_at >= $2
     ORDER BY published_at DESC
     LIMIT 12`, [symbol, since]);

  return rows.map((row) => ({ at: new Date(row.published_at), source: row.source, title: row.headline, url: row.original_url }));
}

function decodeXml(text) {
  return String(text ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .trim();
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));

  return match ? decodeXml(match[1]) : null;
}

/* "Childrens Place, Inc." → "Childrens Place". 회사 꼬리를 떼야 기사 제목과 맞습니다. */
export function plainName(name) {
  return String(name ?? "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[,.]/g, " ")
    .replace(/\b(inc|corp|corporation|co|ltd|limited|plc|holdings?|group|class [a-z]|ordinary shares|common stock|ads|adr|sa|nv|ag|se|llc|lp)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadGoogleNews(symbol, name) {
  const plain = plainName(name);
  const terms = [`"${symbol}"`, plain.length >= 4 ? `"${plain}"` : null].filter(Boolean).join(" OR ");
  const url = new URL("https://news.google.com/rss/search");

  url.searchParams.set("q", `${terms} when:2d`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const xml = await fetchText(url.toString(), { timeoutMs: 6000 });
  const firstWord = plain.split(" ")[0]?.toLowerCase() ?? "";
  const tickerPattern = new RegExp(`\\b${symbol.replace(/[^A-Z0-9.]/gi, "")}\\b`);

  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 20)
    .map((match) => {
      const source = xmlValue(match[1], "source") ?? "Google News";
      const title = (xmlValue(match[1], "title") ?? "").replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");

      return { at: new Date(xmlValue(match[1], "pubDate") ?? 0), source, title, url: xmlValue(match[1], "link") };
    })
    // 이름이 흔한 낱말이면 남의 기사가 섞입니다. 티커나 이름 첫 낱말이 제목에 있어야 합니다.
    .filter((row) => row.title && (tickerPattern.test(row.title) || (firstWord.length >= 4 && row.title.toLowerCase().includes(firstWord))));
}

function titleKey(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

/**
 * 종목 하나의 이유 후보. since 뒤의 공시·기사만 봅니다(기본 36시간 -- 장 마감 뒤 나온
 * 보도자료가 다음날 프리마켓을 띄우는 경우가 대부분입니다).
 */
export async function loadUsReasons(config, { name, since = new Date(Date.now() - 36 * 60 * 60_000), symbol }) {
  const [filings, stored, google] = await Promise.all([
    loadFilings(config, symbol, since).catch(() => []),
    loadStoredNews(config, symbol, since).catch(() => []),
    loadGoogleNews(symbol, name).catch(() => [])
  ]);

  const seen = new Set();
  const news = [...stored, ...google.filter((row) => row.at >= since)]
    .filter((row) => {
      const key = titleKey(row.title);

      if (!key || seen.has(key)) return false;
      seen.add(key);

      return true;
    })
    // 배포사 원문이 먼저, 그 안에서는 최신순. 재가공 기사는 배포사가 없을 때만.
    .sort((a, b) => Number(wireSources.test(b.source)) - Number(wireSources.test(a.source)) || b.at - a.at)
    .slice(0, 3);

  for (const row of news) {
    row.korean = await translateToKorean(row.title).catch(() => null);
  }

  return { filings, news };
}

/** 알림 본문에 붙일 줄들. 없으면 "이유 못 찾음" 한 줄. */
export function reasonLines({ filings, news }) {
  const lines = [];

  for (const filing of filings) {
    lines.push(`📄 SEC ${filing.form} ${kst(filing.at)} · ${filing.label}`);
  }

  for (const row of news) {
    lines.push(`📰 ${row.source} ${kst(row.at)}`);
    lines.push(`   ${row.korean && row.korean !== row.title ? row.korean : row.title}`);
  }

  if (!lines.length) lines.push("이유 못 찾음 — 36시간 안 SEC 공시·보도자료·기사 없음");

  // 구글 뉴스 링크는 수백 자짜리 리다이렉트라 원문 링크·SEC 원문을 먼저 씁니다.
  const direct = news.find((row) => row.url && !row.url.includes("news.google.com"));
  const link = direct?.url ?? filings[0]?.url ?? news[0]?.url;

  if (link) lines.push(link);

  return lines;
}
