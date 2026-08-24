import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 뉴스 키워드로 종목을 묶을 수 있는가 -- 탐색용. 화면에 올리는 코드가 아닙니다.
 *
 *   node scripts/explore-news-groups.mjs
 *
 * 계기: 금호전기(테마=LED)와 금호건설(테마=GTX/건설중소형/수자원)이 8/11·8/12에
 * **나란히 상한가**를 갔고 8/20에도 +29.97%/+24.21%였는데, 공유 테마가 없어
 * 짝꿍 패널이 구조적으로 못 잡습니다. 실제 연결고리는 '호남 반도체 클러스터'라는
 * 정책 테마이고 뉴스에는 8/18부터 있었습니다.
 *
 * 사전으로는 이런 걸 못 따라갑니다. 새 정책 테마가 등재되는 데 걸리는 시간이
 * 정확히 돈이 가장 크게 움직이는 구간입니다.
 *
 * ## 순환을 피하는 방식
 *
 * 동반 상승만으로 묶으면 그냥 co-movement 탐지기가 됩니다. 예전에 뉴스 라벨을
 * 검색어에서 읽어서 "검색어가 자기가 데려온 기사를 보증하는" 순환에 빠진 적이
 * 있습니다. 그래서 역할을 나눕니다.
 *
 *   뉴스 키워드   후보 테마와 **씨앗 종목**을 제안한다
 *   주가 움직임   그 씨앗과 함께 간 종목을 **확인**한다
 *
 * 씨앗은 반드시 기사에 이름이 붙어 있어야 하고, 확장 멤버는 반드시 씨앗과 같은
 * 날 같이 올라야 합니다. 둘 중 하나만으로는 후보가 되지 않습니다.
 *
 * 의존성은 pg 하나뿐이라 형태소 분석기가 없습니다. 공백으로 자른 토큰과 인접
 * 토큰 두 개를 붙인 바이그램만 씁니다 -- '호남 반도체'가 바이그램으로 잡히는지가
 * 이 접근이 되는지의 시금석입니다.
 */

const config = readConfig();

// 기사 제목에 흔한, 테마를 가리키지 않는 말들. 이게 키워드로 뽑히면 아무 종목이나
// 묶입니다.
const stopwords = new Set([
  "특징주", "속보", "단독", "종목", "주가", "코스피", "코스닥", "증시", "장중",
  "상승", "하락", "급등", "급락", "강세", "약세", "상한가", "하한가", "마감",
  "개장", "오전", "오후", "전일", "오늘", "내일", "기자", "종목뉴스", "시황",
  "관련주", "테마주", "수혜주", "그룹주", "인터뷰", "전망", "분석", "기대",
  "이슈", "소식", "발표", "돌파", "기록", "확대", "증가", "감소", "투자",
  "매수", "매도", "순매수", "순매도", "외국인", "기관", "개인"
]);

function tokens(headline) {
  return headline
    .replace(/[[\]()【】<>“”"'·,…]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^가-힣A-Za-z0-9]/g, ""))
    .filter((word) => word.length >= 2 && !stopwords.has(word) && !/^\d+$/.test(word));
}

/** 단어 하나와 인접 두 단어. '호남'만으로는 넓고 '호남 반도체'는 좁습니다. */
function keywordsOf(headline) {
  const words = tokens(headline);
  const grams = new Set(words);

  for (let i = 0; i + 1 < words.length; i += 1) grams.add(`${words[i]} ${words[i + 1]}`);

  return [...grams];
}

const { rows: news } = await query(config, `
  SELECT headline, related_symbols, session_day::text AS d
    FROM (
      SELECT headline, related_symbols,
             (published_at + interval '9 hours')::date AS session_day
        FROM market_news_items
       WHERE region = 'KR' AND related_symbols IS NOT NULL
         AND array_length(related_symbols, 1) > 0
    ) t
`);

console.log(`종목이 붙은 국내 기사 ${news.length}건`);

// 키워드 → {종목, 날짜}
const byKeyword = new Map();

news.forEach((item) => {
  keywordsOf(item.headline).forEach((key) => {
    const entry = byKeyword.get(key) ?? { days: new Set(), symbols: new Map() };

    item.related_symbols.forEach((symbol) => {
      entry.symbols.set(symbol, (entry.symbols.get(symbol) ?? 0) + 1);
      entry.days.add(item.d);
    });
    byKeyword.set(key, entry);
  });
});

console.log(`키워드 ${byKeyword.size.toLocaleString("ko-KR")}개 (단어+바이그램)`);

// 씨앗이 될 만한 키워드: 기사가 여러 건이고, 하루짜리가 아니고, 종목이 너무 많지 않은 것.
const seeds = [...byKeyword.entries()]
  .map(([key, entry]) => ({
    days: entry.days.size,
    key,
    symbols: [...entry.symbols.entries()].sort((a, b) => b[1] - a[1])
  }))
  .filter((s) => s.days >= 2 && s.symbols.length >= 1 && s.symbols.length <= 12
    && s.symbols.reduce((sum, [, n]) => sum + n, 0) >= 3);

console.log(`씨앗 후보 키워드 ${seeds.length}개 (2일 이상 · 종목 12개 이하 · 기사 3건 이상)\n`);

const honam = seeds.filter((s) => s.key.includes("호남") || s.key.includes("클러스터"));

console.log("'호남'·'클러스터' 들어간 씨앗:");
honam.forEach((s) => console.log(`  "${s.key}"  ${s.days}일 · 종목 ${s.symbols.map(([sym, n]) => `${sym}(${n})`).join(" ")}`));

console.log("\n기사 많은 씨앗 상위 12개:");
seeds
  .sort((a, b) => b.symbols.reduce((s, [, n]) => s + n, 0) - a.symbols.reduce((s, [, n]) => s + n, 0))
  .slice(0, 12)
  .forEach((s) => console.log(`  "${s.key}"  ${s.days}일 · 종목 ${s.symbols.length}개`));

process.exit(0);
