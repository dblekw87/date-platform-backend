import { isMachineHeadline, isReasonHeadline, mentionsBadNews } from "./overnight-classify.mjs";
import { query } from "../db/client.mjs";
import { tradingSessions, upcomingWindow } from "./overnight-window.mjs";

/**
 * 오늘 오른 테마와, 그 테마의 직전 거래일 마감 뒤 기사.
 *
 * 2026-10-06에 보안·양자가 통째로 올랐습니다(샌즈랩·라온시큐어 상한가, 59종목 중
 * 50개 상승, 중앙 +4.86% vs 시장 +3.43%). 재료는 전날 15:44부터 터진 금융권 AI
 * 해킹이었는데 **아침 브리핑은 한 종목도 못 올렸습니다** -- 해킹 기사 81건이 전부
 * 피해자(신한·하나은행) 얘기여서 수혜 종목 이름이 안 들어가고, related_symbols가
 * 비어 후보 수집에 아예 안 들어왔습니다.
 *
 * **개장 전에 맞히는 것은 포기했습니다.** 두 가지를 쟀고 둘 다 반증입니다
 * ([[news-to-theme-verdict]], 이 계열 여섯 번째):
 *
 *   제목이 테마 이름을 부르면 멤버를 올려라
 *     호출 7859건 시가초과 -0.22%p(상회 35%) vs 대조군 73644건 +0.20%p(36%)
 *     낱말이 280개라 밤마다 100~265종목이 걸립니다 -- 선택성이 없습니다
 *   호출 건수로 조이면 10건 이상만 +0.79%p(53%)인데 **독립 사건이 셋**입니다
 *     09-04 로봇 · 09-14 보안 · 09-23 항공. 중앙값은 0.04로 사실상 0
 *
 * 게다가 오늘은 "보안株"라고 쓴 기사가 **한 건뿐**이어서, 2건 문턱이면 화장품(3건)만
 * 남고 보안이 빠집니다. 개장 전 탐지기로는 오늘을 집어내지 못합니다.
 *
 * **그래서 뒤집습니다.** 움직임이 테마를 골라주면 탐지기가 필요 없습니다 -- 사용자가
 * 오늘 한 것이 정확히 그 순서였습니다("양자 및 보안쪽이 오르는데 아마 이건 은행권
 * 해킹 보안 이슈로 인해서"). 예측이 아니라 **설명**이라 반증된 계열과 무관하고,
 * [[leading-theme-detection]]의 "데이터가 먼저 못 찾는다, 뒷받침·반증에만 쓸 것"과
 * 같은 자리입니다.
 *
 * 창은 **직전 거래일 15:40부터**입니다. 어제가 아니라 직전 거래일이어야 합니다 --
 * 오늘 재료는 10-05(대체공휴일) 15:44에 나왔고, 직전 거래일은 10-02였습니다.
 * upcomingWindow가 연휴로 벌어진 간격을 이미 그렇게 셉니다.
 */

/*
 * **중앙값으로 고르면 안 됩니다.**
 *
 * 2026-10-06에 중앙 초과로 줄 세우니 5종목짜리가 위로 올라왔습니다.
 *
 *   반도체 재료/부품    5종목 +5.3%p  10%↑ 1개    610억
 *   딥페이크           5종목 +4.9%p  10%↑ 1개     86억
 *   보안주(정보)      31종목 +1.4%p  10%↑ 7개  3,650억   <- 정작 움직인 테마
 *
 * 멤버가 다섯이면 중앙값이 한 종목으로 흔들립니다. 그날 테마가 움직였다는 것은
 * **여럿이 같이 올랐다**는 뜻이므로 넓이로 셉니다 -- 많이 오른 멤버 수입니다.
 * 보안주는 일곱이고 그다음이 넷(2차전지)이라 순서가 뒤집히지 않습니다.
 */
/* 테마로 부르려면 오늘 표본이 이만큼은 있어야 합니다. */
const minSymbols = 8;
/* 이만큼 오른 멤버가 몇인지로 줄 세웁니다. */
const bigMove = 10.0;
/* 그런 멤버가 이 수 미만이면 테마가 움직인 게 아니라 한두 종목이 움직인 것입니다. */
const minBig = 3;
/* 테마 전체 거래대금. 이 아래는 올라도 들어갈 자리가 없습니다. */
const minTurnover = 300 * 100000000;

/** 오늘 시장 평균 대비 많이 오른 테마들. 표본은 순위권 종목뿐이라는 한계가 있습니다. */
async function movingThemes(config, day) {
  const { rows } = await query(config, `
    WITH last AS (
      SELECT DISTINCT ON (symbol) symbol, name, theme,
             change_rate::float8 AS rate, turnover::float8 AS turnover
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:krx%'
       ORDER BY symbol, observed_at DESC
    ), market AS (
      SELECT avg(rate) AS mean FROM last
    )
    SELECT theme,
           count(*)::int AS symbols,
           count(*) FILTER (WHERE rate >= $4)::int AS big,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) - (SELECT mean FROM market))::float8 AS excess,
           sum(turnover)::float8 AS turnover,
           (SELECT mean FROM market)::float8 AS market_mean
      FROM last
     WHERE theme IS NOT NULL AND theme <> '미분류'
     GROUP BY theme
    HAVING count(*) >= $2 AND sum(turnover) >= $3 AND count(*) FILTER (WHERE rate >= $4) >= $5
     ORDER BY 3 DESC, 5 DESC`, [day, minSymbols, minTurnover, bigMove, minBig]);

  /*
   * 가운데도 올랐어야 테마가 움직인 것입니다.
   *
   * 넓이만 보면 '유전자 치료제/분석'이 걸렸습니다 -- 9종목 중 셋이 +10% 이상인데
   * 중앙은 -0.5%p였습니다. 세 종목이 간 것이지 테마가 간 것이 아닙니다.
   */
  return rows.filter((row) => Number(row.excess) >= 0);
}

/** 그 테마에서 오늘 많이 오른 종목. 이름으로 테마를 설명하지 않고 종목으로 말합니다. */
async function themeMovers(config, day, theme) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name, change_rate::float8 AS rate, turnover::float8 AS turnover
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:krx%' AND theme = $2
     ORDER BY symbol, observed_at DESC`, [day, theme]);

  return rows.sort((a, b) => Number(b.rate) - Number(a.rate)).slice(0, 4);
}

/*
 * 그 테마를 설명하는 기사.
 *
 * 두 길로 찾습니다. 멤버가 태깅된 기사와, 제목이 테마 낱말을 부른 기사입니다.
 * 오늘은 **뒤의 길만** 걸립니다 -- 보안주 네 종목이 태깅 0건이었고,
 * `은행권 해킹 사태에 주목받는 국내 보안株` 한 건이 테마 낱말로 잡힙니다.
 *
 * 여기서 낱말로 찾는 것은 괜찮습니다. 테마를 **고르는 일은 움직임이 이미 했고**,
 * 낱말은 고른 테마를 설명할 기사를 찾는 데만 씁니다. 틀린 기사가 붙으면 사람이
 * 읽고 버리면 되고, 그것이 종목을 추천하지는 않습니다.
 */
async function themeNews(config, theme, window) {
  const bare = theme.replace(/\([^)]*\)/g, "").trim();
  const words = bare.split("/").map((part) => part.replace(/주$/, "").trim()).filter((word) => word.length >= 2);
  const { rows } = await query(config, `
    WITH member AS (
      SELECT symbol FROM kr_theme_membership WHERE theme_name = $1
    ), tagged AS (
      /*
       * 멤버가 태깅된 기사. **재료 기사만** 받습니다.
       *
       * 걸지 않았더니 블록체인과 핀테크 칸에 "최태원, SK 지분 2.3% 매각 결정"이
       * 붙었습니다 -- SK가 두 테마의 멤버라 태깅만으로 끌려온 것입니다. 테마가
       * 오른 이유가 아니고, 아무 기사나 붙으면 설명이 아니라 소음입니다.
       */
      SELECT n.headline, n.original_url, n.published_at, 2 AS weight
        FROM market_news_items n, LATERAL unnest(n.related_symbols) s
       WHERE n.region = 'KR' AND s IN (SELECT symbol FROM member)
         AND n.published_at >= $2 AND n.published_at < $3
         AND cardinality(n.related_symbols) >= 2
    ), named AS (
      SELECT n.headline, n.original_url, n.published_at, 1 AS weight
        FROM market_news_items n
       WHERE n.region = 'KR' AND n.published_at >= $2 AND n.published_at < $3
         AND n.headline ~ $4
    )
    -- 앞의 대괄호 토막을 떼고 키를 만듭니다. "[속보] 최태원…"과 "최태원…"이 나란히 붙었습니다.
    SELECT DISTINCT ON (left(regexp_replace(regexp_replace(lower(headline), '^\s*\[[^\]]*\]\s*', ''), '[^가-힣a-z0-9]', '', 'g'), 28))
           to_char(published_at AT TIME ZONE 'Asia/Seoul', 'DD HH24:MI') AS at,
           headline, original_url, weight, published_at
      FROM (SELECT * FROM tagged UNION ALL SELECT * FROM named) t
     ORDER BY left(regexp_replace(regexp_replace(lower(headline), '^\s*\[[^\]]*\]\s*', ''), '[^가-힣a-z0-9]', '', 'g'), 28), weight DESC, published_at`,
    [theme, window.from, window.to, `(${words.join("|")})\\s*(관련주|수혜주|테마|주|株)`]);

  /*
   * 태깅만으로 끌려온 광고·추천 글을 버립니다.
   *
   * cardinality >= 2만 걸었더니 보안주 칸 맨 위에 "[주식민원처리반 3부]
   * '대주전자재료, 엑스게이트' 월요일에 선택할 이 종목은?"이 붙었습니다. 종목 둘을
   * 달고 있지만 재료가 아니라 홍보입니다. 재료 판정은 알림이 쓰는 것과 같은
   * 함수여야 합니다 -- 화면과 알림이 다른 기준을 쓰면 둘 다 안 믿게 됩니다.
   */
  const usable = rows.filter((row) => isReasonHeadline(row.headline)
    && !isMachineHeadline(row.headline) && !mentionsBadNews(row.headline));
  /*
   * 구글 뉴스 리다이렉트 주소를 뒤로 보냅니다. 한 줄을 다 먹고(300자 넘음) 어차피
   * 다른 매체 기사를 중계한 것이라, 원문이 있으면 원문 쪽이 읽기도 짧기도 낫습니다.
   * 시각보다 먼저 보는 이유는 두 칸뿐이어서입니다 -- 긴 주소 하나가 한 칸을 먹으면
   * 정작 원인 기사가 밀립니다(10-05 16:56 "은행권 해킹 사태에 주목받는 국내 보안株").
   */
  const direct = (row) => (/news\.google\.com/.test(row.original_url ?? "") ? 1 : 0);

  /*
   * **이른 것을 먼저** 올립니다. 태깅 가중치보다 시각이 앞섭니다.
   *
   * 가중치를 먼저 보니 10-06 09:12·10:34 복기 기사가 위로 왔고, 정작 원인인
   * 10-05 16:56 "은행권 해킹 사태에 주목받는 국내 보안株"가 밀렸습니다. 그 기사는
   * 종목 태깅이 없어 가중치가 낮습니다. [[evidence-filter-fixes]]에서 기사 시각을
   * 쟀을 때 선행 74건 -0.31%p가 후행 152건 -0.97%p보다 나았습니다 -- 오른 뒤에 쓴
   * 글은 이유가 아닙니다. 설명을 붙이는 칸에서도 같습니다.
   */
  return usable
    .sort((a, b) => direct(a) - direct(b) || a.published_at - b.published_at || Number(b.weight) - Number(a.weight))
    .slice(0, 2);
}

/** 요약에 붙일 줄들. 오른 테마가 없으면 빈 배열입니다. */
export async function buildThemeWhy(config, day, now = new Date()) {
  if (!config.databaseUrl) return [];

  const themes = await movingThemes(config, day);

  if (!themes.length) return [];

  const sessions = await tradingSessions(config);
  /* 창의 끝은 '지금'이고 시작은 직전 거래일 15:40입니다. 연휴면 그만큼 넓어집니다. */
  const window = upcomingWindow(sessions.filter((session) => session < day), now);
  const lines = [`■ 오늘 오른 테마와 그 재료 (${window.previous} 15:40 이후 기사)`];

  for (const theme of themes.slice(0, 3)) {
    const movers = await themeMovers(config, day, theme.theme);
    const news = await themeNews(config, theme.theme, window);
    const head = movers
      .map((row) => `${row.name} ${Number(row.rate) >= 0 ? "+" : ""}${Number(row.rate).toFixed(1)}%`)
      .join(" · ");

    lines.push(`  ${theme.theme} · ${theme.symbols}종목 중 ${theme.big}개가 +${bigMove.toFixed(0)}% 이상`
      + ` · 중앙 ${Number(theme.excess) >= 0 ? "+" : ""}${Number(theme.excess).toFixed(1)}%p`
      + ` · ${Math.round(Number(theme.turnover) / 1e8).toLocaleString("ko-KR")}억`);
    lines.push(`    ${head}`);

    if (!news.length) {
      lines.push("    기사 없음 (재료를 못 찾았습니다)");
      continue;
    }

    for (const row of news) {
      lines.push(`    ${row.at} ${row.headline.slice(0, 52)}`);
      if (row.original_url) lines.push(`      ${row.original_url}`);
    }
  }

  lines.push("");
  lines.push(`  시장 평균 ${Number(themes[0].market_mean) >= 0 ? "+" : ""}${Number(themes[0].market_mean).toFixed(2)}% 대비 초과입니다.`);
  lines.push("  오른 뒤에 붙인 설명입니다 — 다음 날 후보가 아닙니다(예측은 여섯 번 반증).");

  return lines;
}
