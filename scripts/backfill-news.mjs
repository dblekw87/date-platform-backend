import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { saveMarketNewsItems } from "../src/db/repositories.mjs";
import { dedupeNews, normalizeNewsItem } from "../src/providers/news-normalizer.mjs";
import { attachKrUniverseTags, isArticleLikeSource, isMarketRelevant, koreanRssQueries, loadListedNames, themeLabelFor } from "../src/providers/news.mjs";
import { loadKrNameIndex } from "../src/providers/kr-universe.mjs";

/**
 * 꺼져 있던 동안 나온 기사를 되받아옵니다.
 *
 *   node scripts/backfill-news.mjs [--days 3]
 *
 * **분봉과 달리 뉴스는 되받아올 수 있습니다.** 분봉은 그 순간이 지나면 없지만
 * 기사는 검색에 남아 있습니다. 그래서 주말에 컴퓨터를 꺼도 되고, 켠 뒤 이걸 한
 * 번 돌리면 그 사이 기사가 들어옵니다.
 *
 * 왜 필요한가. 평소 수집은 검색어마다 `when:2d`로 최근 이틀을 훑고 그중 앞
 * 16건만 가져갑니다. 5분마다 도니 켜져 있는 동안은 새 기사가 늘 앞에 있어
 * 충분한데, 이틀을 꺼 두면 그동안 쌓인 것이 16건 뒤로 밀려 다시 볼 기회가
 * 없습니다.
 *
 * 어디서 받아오는가 -- **구글 뉴스 RSS입니다.** 네이버가 아닙니다. 2026-08-28
 * 확인: 개발자센터 키는 .env에 없고 API Hub 키는 401을 돌려줍니다. 최근 나흘
 * 국내 기사 2,230건이 전부 구글 뉴스에서 왔습니다. 네이버가 살아나면 이 스크립트도
 * 그쪽을 함께 봐야 합니다.
 *
 * 구글 뉴스 RSS는 `after:` / `before:`로 날짜를 지정할 수 있습니다. 하루씩
 * 끊어 검색어마다 요청하면 그 날짜의 기사가 최대 100건씩 돌아옵니다 -- 평소의
 * 16건보다 훨씬 두껍습니다.
 *
 * 평소 수집과 **같은 검색어, 같은 정규화, 같은 관련성 필터, 같은 종목 태깅**을
 * 씁니다. 여기가 갈리면 메운 기사와 평소 기사가 다른 corpus가 되어, 뉴스로 재는
 * 측정이 요일에 따라 다른 것을 재게 됩니다. id는 URL·시각·제목의 해시라 이미
 * 있는 기사는 저장 단계에서 겹쳐 쓰이고 중복이 쌓이지 않습니다.
 */

const config = readConfig();
const args = process.argv.slice(2);
const at = args.indexOf("--days");

/*
 * 며칠을 메울 것인가.
 *
 * --days를 주면 그대로 씁니다. 안 주면 **구멍을 직접 재서** 정합니다 -- 마지막
 * 국내 기사가 몇 시간 전인지 보고 그만큼만 메웁니다. 로그온 때마다 불려도
 * 되도록 하려는 것입니다: 컴퓨터를 껐다 켠 만큼만 일하고, 안 꺼 놨으면 몇 초 만에
 * 아무 일도 안 하고 끝납니다.
 */
const skipUnderHours = 6;

async function gapDays() {
  const { rows } = await query(config, `
    SELECT extract(epoch FROM now() - max(published_at)) / 3600 AS hours
      FROM market_news_items WHERE region = 'KR'`);
  const hours = Number(rows[0]?.hours);

  if (!Number.isFinite(hours)) return 3;
  if (hours < skipUnderHours) return 0;

  return Math.min(14, Math.max(2, Math.ceil(hours / 24) + 1));
}

const days = at >= 0 && args[at + 1] ? Number(args[at + 1]) : await gapDays();

if (days === 0) {
  console.log("최근 기사가 6시간 안쪽입니다 - 메울 구멍이 없습니다.");
  process.exit(0);
}

// 구글은 명시된 한도가 없습니다. 한 번에 다섯 개씩, 초당 한 묶음으로 둡니다.
const perSecond = 5;

function seoulDay(offset) {
  const now = new Date(Date.now() + 9 * 3600_000 - offset * 86400_000);

  return now.toISOString().slice(0, 10);
}

function shift(day, delta) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86400_000).toISOString().slice(0, 10);
}

/*
 * 하루치. after/before는 경계를 포함하지 않으므로 앞뒤로 하루씩 벌립니다 --
 * 그러면 이웃 날짜가 함께 딸려오는데, 저장 단계에서 겹쳐 쓰이므로 문제가 되지
 * 않고 오히려 경계에 걸친 기사를 놓치지 않습니다.
 */
async function fetchDay(topic, day) {
  const url = new URL("https://news.google.com/rss/search");

  url.searchParams.set("q", `${topic} after:${shift(day, -1)} before:${shift(day, 1)}`);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "KR");
  url.searchParams.set("ceid", "KR:ko");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const xml = await response.text();
  const value = (block, tag) => {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);

    return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : undefined;
  };

  // googleNewsRssFeed가 만드는 것과 같은 모양. 다른 점은 slice(0, 16)이 없다는
  // 것뿐입니다 -- 메우러 온 것이므로 주는 대로 다 받습니다.
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((match) => ({
      category: topic,
      originalUrl: value(match[1], "link"),
      provider: "Google News",
      pubDate: value(match[1], "pubDate"),
      region: "KR",
      source: value(match[1], "source") || "Google News",
      title: value(match[1], "title")?.replace(/<[^>]+>/g, "").trim()
    }))
    .filter((item) => item.title && isArticleLikeSource(item.source, item.title));
}

const listed = await loadListedNames(config);
const nameIndex = await loadKrNameIndex(config).catch(() => []);
const before = (await query(config, "SELECT count(*) AS n FROM market_news_items")).rows[0].n;
const targets = Array.from({ length: days }, (unused, index) => seoulDay(index));

console.log("");
console.log(`구글 뉴스 RSS · 검색어 ${koreanRssQueries.length}개 × ${days}일 = ${koreanRssQueries.length * days}회 요청`);
console.log(`날짜 ${targets[targets.length - 1]} ~ ${targets[0]}`);
console.log(`상장 이름 ${listed.length.toLocaleString("ko-KR")}개로 관련성 판정, ${nameIndex.length.toLocaleString("ko-KR")}개로 종목 태깅`);
console.log("");

const collected = [];
const jobs = targets.flatMap((day) => koreanRssQueries.map((topic) => ({ day, topic })));
let failed = 0;

for (let i = 0; i < jobs.length; i += perSecond) {
  const tick = Date.now();

  await Promise.all(jobs.slice(i, i + perSecond).map(async ({ day, topic }) => {
    try {
      collected.push(...await fetchDay(topic, day));
    } catch (error) {
      failed += 1;
      console.warn(`  ${day} ${topic} 실패: ${error instanceof Error ? error.message : error}`);
    }
  }));

  const spent = Date.now() - tick;

  if (spent < 1000) await new Promise((resolve) => setTimeout(resolve, 1000 - spent));
}

const normalized = dedupeNews(collected.map(normalizeNewsItem).filter(Boolean));
const relevant = normalized
  .filter((item) => isMarketRelevant(item, listed))
  .map((item) => ({ ...item, label: themeLabelFor(item, listed) }));
const tagged = attachKrUniverseTags(relevant, nameIndex);

console.log("");
console.log(`  받은 기사 ${collected.length.toLocaleString("ko-KR")}건 → 중복 제거 ${normalized.length.toLocaleString("ko-KR")}건 → 시장 관련 ${tagged.length.toLocaleString("ko-KR")}건`);
console.log(`  그중 종목이 붙은 것 ${tagged.filter((item) => (item.relatedSymbols ?? []).length > 0).length.toLocaleString("ko-KR")}건${failed > 0 ? ` · 실패한 요청 ${failed}회` : ""}`);

// ON CONFLICT라 이미 있는 기사는 태그만 갱신되고 새 기사만 늘어납니다.
await saveMarketNewsItems(config, tagged);

const after = (await query(config, "SELECT count(*) AS n FROM market_news_items")).rows[0].n;

console.log(`  새로 저장 ${(Number(after) - Number(before)).toLocaleString("ko-KR")}건`);

const span = await query(config, `
  SELECT date(published_at AT TIME ZONE 'Asia/Seoul')::text AS d,
         count(*) AS n,
         count(*) FILTER (WHERE array_length(related_symbols, 1) > 0) AS tagged
    FROM market_news_items
   WHERE published_at > now() - ($1 || ' days')::interval AND region = 'KR'
   GROUP BY 1 ORDER BY 1`, [days + 1]);

console.log("");
console.log("날짜별 국내 기사 보유량 (괄호는 종목이 붙은 것)");
console.log("");
span.rows.forEach((row) => console.log(`  ${row.d}  ${String(row.n).padStart(5)}건  (${row.tagged})`));

process.exit(0);
