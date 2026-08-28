import { readConfig } from "../src/config.mjs";
import { fetchPressFeed } from "../src/providers/news.mjs";

/**
 * 뉴스 소스가 실제로 응답하는지 하나씩 찔러 봅니다.
 *
 *   node scripts/check-news-sources.mjs
 *
 * 키를 새로 넣은 뒤 서버를 띄우고 로그를 뒤지는 대신 이걸 돌립니다. 키가 있다
 * 없다가 아니라 **그 키로 실제 기사가 돌아오는지**를 봅니다 -- 네이버 두 경로가
 * 조용히 죽어 있던 것이 정확히 그 차이였습니다. 키는 .env에 있었고, 응답은 401이었고,
 * 아무도 몰랐습니다.
 */

const config = readConfig();
const results = [];

async function probe(name, run) {
  const at = Date.now();

  try {
    const count = await run();

    results.push({ count, name, ms: Date.now() - at, ok: count > 0, note: count > 0 ? "" : "응답은 왔는데 기사가 0건입니다" });
  } catch (error) {
    results.push({ count: 0, name, ms: Date.now() - at, ok: false, note: error instanceof Error ? error.message : String(error) });
  }
}

async function rssCount(url, headers) {
  // 언론사는 수집기와 **같은 함수**로 받습니다. 점검이 다른 방식으로 받으면
  // 여기서 통과한 것이 실제로는 막혀 있을 수 있습니다 -- 한국경제가 크롬 UA에
  // 403을 주는 것을 이 스크립트가 잡아낸 것이 바로 그 경우였습니다.
  const text = headers
    ? await (async () => {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        return response.text();
      })()
    : await fetchPressFeed(url, { timeoutMs: 8000 });

  return [...text.matchAll(/<item[\s>]/gi)].length;
}

async function jsonCount(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const body = await response.text();

  if (!response.ok) {
    // 네이버는 왜 거절했는지를 본문에 적어 줍니다. 그게 다음에 할 일을 정합니다.
    const detail = /"(?:errorMessage|message|details)"\s*:\s*"([^"]+)"/.exec(body);

    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail[1]}` : ""}`);
  }

  return (JSON.parse(body)?.items ?? []).length;
}

const query = encodeURIComponent("코스피");

await probe("구글 뉴스 RSS", () =>
  rssCount(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`, {}));

await probe("네이버 API Hub", () => {
  if (!config.news.naverApiHubKeyId || !config.news.naverApiHubKey) throw new Error("키가 .env에 없습니다");

  return jsonCount(
    `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${query}&display=10&start=1&sort=date&format=json`,
    { "X-NCP-APIGW-API-KEY": config.news.naverApiHubKey, "X-NCP-APIGW-API-KEY-ID": config.news.naverApiHubKeyId }
  );
});

await probe("네이버 개발자센터", () => {
  if (!config.news.naverSearchClientId || !config.news.naverSearchClientSecret) throw new Error("키가 .env에 없습니다 (2026-07-31 신규 신청 종료)");

  return jsonCount(
    `https://openapi.naver.com/v1/search/news.json?query=${query}&display=10&sort=date`,
    { "X-Naver-Client-Id": config.news.naverSearchClientId, "X-Naver-Client-Secret": config.news.naverSearchClientSecret }
  );
});

const press = [
  ["한국경제 증권", "https://www.hankyung.com/feed/finance"],
  ["한국경제 경제", "https://www.hankyung.com/feed/economy"],
  ["매일경제 증권", "https://www.mk.co.kr/rss/50200011/"],
  ["파이낸셜뉴스", "https://www.fnnews.com/rss/r20/fn_realnews_stock.xml"],
  ["머니투데이", "https://rss.mt.co.kr/mt_news.xml"],
  ["연합뉴스 경제", "https://www.yna.co.kr/rss/economy.xml"],
  ["아시아경제 증권", "https://www.asiae.co.kr/rss/stock.htm"],
  ["뉴시스 경제", "https://newsis.com/RSS/economy.xml"],
  ["조선비즈 증권", "https://biz.chosun.com/arc/outboundfeeds/rss/category/stock/?outputType=xml"],
  ["연합인포맥스", "https://news.einfomax.co.kr/rss/allArticle.xml"]
];

for (const [name, url] of press) await probe(name, () => rssCount(url));

console.log("");
console.log("뉴스 소스 점검");
console.log("");

for (const result of results) {
  const mark = result.ok ? "on " : "OFF";
  const count = result.ok ? `${String(result.count).padStart(3)}건` : "    ";

  console.log(`  ${mark}  ${result.name.padEnd(18)} ${count}  ${String(result.ms).padStart(5)}ms  ${result.note}`);
}

const naver = results.filter((result) => result.name.startsWith("네이버"));
const alive = results.filter((result) => result.ok).length;

console.log("");
console.log(`  ${alive} / ${results.length} 살아 있습니다`);

if (!naver.some((result) => result.ok)) {
  console.log("");
  console.log("  네이버는 두 경로 다 막혀 있습니다. 국내 기사는 구글 뉴스와 언론사 RSS로만 들어옵니다.");
  console.log("  API Hub 키는 NCP 콘솔에서 Application을 만들고 Search API를 고르면 나오는");
  console.log("  Client ID/Secret입니다 -- ncp_iam_ 으로 시작하는 IAM 계정 키가 아닙니다.");
}

process.exit(0);
