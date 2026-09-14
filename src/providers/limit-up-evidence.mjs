import { classifyDisclosure, classifyHeadline, isReasonHeadline } from "./overnight-classify.mjs";
import { query } from "../db/client.mjs";
import { loadListedRelatives } from "./ownership-links.mjs";

/**
 * 왜 상한가에 갔는가.
 *
 * 세 단계로 찾고, **어느 단계에서 나왔는지를 같이 돌려줍니다.** 아래로 갈수록
 * 약한 근거라, 어느 쪽인지 모르면 추정을 사실처럼 읽게 됩니다.
 *
 *   filing   그 회사의 오늘 공시. 그 회사에 대한 사실이라 가장 셉니다
 *   direct   그 종목이 태깅된 오늘 기사
 *   theme    같은 테마에서 **같이 오른 다른 종목**의 기사. 추정입니다
 *
 * **테마는 이름으로 잇지 않습니다.** 뉴스의 related_themes는 거친 이름을 쓰고
 * (반도체·바이오·로봇), 시세 표본의 theme은 네이버 테마 사전 이름을 씁니다
 * (로봇(산업용/협동로봇 등), 지능형로봇/인공지능(AI)). 2026-09-07에 세어 보면
 * 5일치에서 `로봇` 126건 대 `로봇(산업용/협동로봇 등)` 7건이라, 문자열로 맞추면
 * 대부분 어긋납니다. 이름으로 테마를 추정하는 것은 이미 여러 번 반증됐습니다
 * ([[theme-dictionary-lag]], [[theme-card-attribution]]).
 *
 * 대신 **같은 테마에서 오늘 5% 이상 오른 다른 종목**을 찾고 그 종목에 붙은
 * 기사를 가져옵니다. 사전 이름을 건너뛰고 "같이 움직인 종목의 재료"라는 사실만
 * 씁니다.
 *
 * 창은 08:00~20:00입니다. **잠긴 시각 이전으로 자르지 않습니다** -- 이유를
 * 설명하는 기사는 대개 잠긴 뒤에 나옵니다. TPC로보틱스는 09:15에 잠기고
 * 기사는 10:26에 나왔습니다. 시각으로 인과를 주장하지 않고 시각을 같이 적어
 * 사람이 판단하게 둡니다.
 */

const peerMinimumMove = 5;

/*
 * 복기 기사는 이유가 아닙니다 -- "주가 13.39% 상승"은 오른 것을 다시 쓴 것이지
 * 왜 올랐는지가 아닙니다. [[overnight-material-verdict]]
 *
 * 단, 복기 모양이라도 **재료 낱말을 들고 있으면** 살립니다. 직접 태깅된 기사는
 * 종목이 지목됐다는 사실이 이미 근거이고, "강세에 19%↑…자사주 소각도"에서 앞을
 * 보고 뒤를 버리면 이유를 손에 쥐고 놓치는 것입니다(2026-09-09 RF머트리얼즈).
 * 다음 장 후보의 규칙은 그대로입니다 -- 거기서는 복기가 반증된 조건입니다.
 */
const isReason = isReasonHeadline;

export async function loadLimitUpEvidence(config, lock, day) {
  const from = new Date(`${day}T08:00:00+09:00`);
  const to = new Date(`${day}T20:00:00+09:00`);

  const filed = await query(config, `
    SELECT to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at,
           report_name, title, original_url
      FROM market_disclosures
     WHERE market = 'KR' AND symbol = $1 AND filed_at >= $2 AND filed_at < $3
     ORDER BY filed_at`, [lock.symbol, from, to]);

  /*
   * 그날 접수된 공시 전부가 이유는 아닙니다.
   *
   * 거르지 않았더니 E8의 이유로 `[기재정정]주요사항보고서(유상증자결정)`이,
   * 원익홀딩스의 이유로 `주식등의대량보유상황보고서(일반)`이 올라왔습니다.
   * 앞의 것은 이미 낸 공시의 오타 수정이고 뒤의 것은 5% 신고라, 둘 다 상한가를
   * 설명하지 않습니다. classifyDisclosure가 이미 그 판단을 합니다 -- 재료 선정과
   * 같은 분류를 써야 두 화면이 같은 것을 공시라고 부릅니다.
   *
   * 희석·악재는 버리지 않고 **경고로** 따로 답니다. 상한가에 갔는데 유상증자
   * 공시가 같이 있는 것은 알아야 하는 사실이지, 오른 이유는 아닙니다.
   */
  const filings = [];
  const cautions = [];

  for (const row of filed.rows) {
    const kind = classifyDisclosure(row.report_name, row.title);

    if (kind === "good") filings.push(row);
    else if (kind === "dilution" || kind === "bad") cautions.push({ ...row, kind });
  }

  /*
   * 같은 기사를 두 번 보여주지 않습니다.
   *
   * 매체마다 제목을 조금씩 고쳐 싣기 때문에 제목 그대로 DISTINCT를 걸면 통과합니다
   * -- "형지엘리트, '남북경협 전담 TF' 출범…개성공단 생산 이력 바탕으로 대..."와
   * 그 전문이 나란히 붙었습니다. 글자·숫자만 남긴 형태로 묶습니다(종가배팅의
   * loadEntryNews가 쓰는 것과 같은 정규화). 앞 30자만 보는 것은 한쪽이 잘린
   * 채로 들어오기 때문입니다 -- 위 두 제목은 하나가 "…대응체계 구축"이고 다른
   * 하나가 "…대"에서 끊겨, 전체를 정규화해도 서로 다른 문자열입니다.
   */
  const direct = await query(config, `
    SELECT DISTINCT ON (left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30))
           to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at,
           headline, original_url, published_at,
           coalesce(array_length(related_symbols, 1), 0) AS tagged
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND s = $1 AND published_at >= $2 AND published_at < $3
     ORDER BY left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30), published_at`,
    [lock.symbol, from, to]);

  const reasons = direct.rows
    .filter((row) => isReason(row.headline))
    .sort((a, b) => a.published_at - b.published_at);

  if (filings.length || reasons.length) {
    return {
      kind: filings.length ? "filing" : "direct",
      filings: filings.slice(0, 2),
      cautions: cautions.slice(0, 2),
      news: reasons.slice(0, 2)
    };
  }

  /*
   * 셋째 근거: **기사가 이 종목을 다른 종목과 묶어 부른 것.**
   *
   * 2026-09-14 광전자가 12:07 시총 6천억·거래대금 2,600억으로 잠겼는데 알림이 끝내
   * 안 나갔습니다. 이유는 있었습니다 -- 젠슨 황의 광통신·보안 발언에 이어진 테마
   * 연속성이고, 13:08 기사가 그대로 말합니다: "광통신 관련주 불붙었다…광전자 상한가,
   * 빛샘전자 26%대 급등". 그 기사는 '상한가·급등'이 들어 복기로 걸려 버려졌고,
   * 사전은 광전자를 LED에 두어 광통신 동료를 못 봤습니다([[theme-dictionary-lag]] --
   * 사전은 틀린 게 아니라 빠진 것).
   *
   * 복기 기사 중에서도 **둘 이상을 한 문장에 묶어 관련주·테마라고 부른 것**은 다릅니다.
   * "무엇이 올랐다"가 아니라 "무엇과 함께, 어느 이름으로 올랐다"를 말하고, 그게
   * 잠긴 뒤의 알림이 답해야 하는 질문입니다. 테마를 이름으로 추정하지 않고 **같이
   * 오른 종목으로** 말하라는 원칙과도 맞습니다 -- 기사가 그 묶음을 해 줬습니다.
   *
   * 잠긴 뒤에만 씁니다. 잠기기 전 알림(nearPass)은 "지금 살까"라 filing·direct만
   * 받고, 이것은 그쪽에 들어가지 않습니다.
   */
  /*
   * 둘째 근거: **지분으로 이어진 회사의 재료.**
   *
   * 2026-09-14 위메이드맥스가 15:11 잠겼는데 이 종목을 지목한 기사는 16:24 사후 복기
   * 하나였습니다. 이유는 모회사에 있었습니다 -- 위메이드(36.83% 보유)에 킹넷이 4000억을
   * 넣는다는 단독이 일요일 11:14에 나왔고, 월요일 프리마켓부터 자회사가 +23%였습니다.
   * DART 지분 그래프([[ownership-graph-finding]])가 그 연결을 이미 알고 있었는데
   * 상한가 근거는 그것을 묻지 않았습니다.
   *
   * 지분 10% 이상, 양방향(모회사의 재료 → 자회사 / 자회사의 재료 → 모회사)으로 봅니다.
   * 창은 직전 거래일 마감부터 -- 주말에 나온 모회사 기사가 월요일 자회사를 설명합니다.
   * 기사는 재료 낱말이 잡힌 것만 받습니다(peers와 같은 문턱): 한 겹 건너 연결이라
   * 아무 기사나 올리면 근거가 아니라 소음입니다.
   */
  const relatives = (await loadListedRelatives(config, [lock.symbol])).get(lock.symbol) ?? [];

  if (relatives.length) {
    const previous = await query(config,
      "SELECT max(session_date)::text AS d FROM kr_daily_universe WHERE session_date < $1::date", [day]);
    const since = previous.rows[0]?.d ? new Date(`${previous.rows[0].d}T15:40:00+09:00`) : from;
    const familyNews = await query(config, `
      SELECT DISTINCT ON (s, left(regexp_replace(lower(n.headline), '[^가-힣a-z0-9]', '', 'g'), 30))
             to_char(n.published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at,
             n.headline, n.original_url, n.published_at, s AS peer
        FROM market_news_items n, LATERAL unnest(n.related_symbols) s
       WHERE n.region = 'KR' AND s = ANY($1) AND n.published_at >= $2 AND n.published_at < $3
       ORDER BY s, left(regexp_replace(lower(n.headline), '[^가-힣a-z0-9]', '', 'g'), 30), n.published_at DESC`,
      [relatives.map((row) => row.symbol), since, to]);
    const byPeer = new Map(relatives.map((row) => [row.symbol, row]));
    const family = familyNews.rows
      .filter((row) => classifyHeadline(row.headline) === "material")
      .map((row) => ({ ...row, relative: byPeer.get(row.peer) }))
      .sort((a, b) => b.published_at - a.published_at);
    const onePerRelative = new Map();

    for (const row of family) if (!onePerRelative.has(row.peer)) onePerRelative.set(row.peer, row);

    if (onePerRelative.size) {
      return { kind: "family", filings: [], cautions, news: [...onePerRelative.values()].slice(0, 2) };
    }
  }

  const grouped = direct.rows
    .filter((row) => Number(row.tagged) >= 2 && /관련주|테마|株|수혜주|동반|줄줄이|불붙|나란히|함께/.test(row.headline))
    .sort((a, b) => a.published_at - b.published_at);

  if (grouped.length) {
    return { kind: "grouped", filings: [], cautions, news: grouped.slice(0, 2) };
  }

  if (!lock.theme || lock.theme === "미분류") return { kind: "none", filings: [], cautions, news: [] };

  const peers = await query(config, `
    WITH peers AS (
      SELECT p.symbol, max(p.change_rate)::float8 AS move
        FROM market_price_samples p
       WHERE p.market = 'KR' AND p.session_date = $4::date AND p.theme = $5 AND p.symbol <> $1
       GROUP BY p.symbol
      HAVING max(p.change_rate) >= $6
    )
    SELECT DISTINCT ON (left(regexp_replace(lower(n.headline), '[^가-힣a-z0-9]', '', 'g'), 30))
           to_char(n.published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at,
           n.headline, n.original_url, n.published_at, s AS peer, peers.move,
           (SELECT name FROM kr_daily_universe u WHERE u.symbol = s AND u.session_date = $4::date) AS peer_name
      FROM market_news_items n, LATERAL unnest(n.related_symbols) s
      JOIN peers ON peers.symbol = s
     WHERE n.region = 'KR' AND n.published_at >= $2 AND n.published_at < $3
     ORDER BY left(regexp_replace(lower(n.headline), '[^가-힣a-z0-9]', '', 'g'), 30), n.published_at`,
    [lock.symbol, from, to, day, lock.theme, peerMinimumMove]);

  /*
   * 추정에는 더 높은 문턱을 둡니다 -- **재료 기사만**.
   *
   * 직접 태깅된 기사는 종목이 지목됐다는 사실 자체가 근거라 복기만 빼면 됩니다.
   * 반면 여기는 "같은 테마의 다른 종목 기사"라 연결이 이미 한 겹 약합니다. 그
   * 위에 아무 기사나 올리면 근거가 아니라 소음이 붙습니다 -- 2026-09-03 동일스틸럭스
   * 자리에 배우 기사와 인기검색 목록이 올라왔습니다.
   *
   * 문턱을 올리면 놓치는 것도 생깁니다(서산의 SG 인도네시아 인프라 기사가
   * "공략"이라 빠집니다). 추정이 틀리는 값이 놓치는 값보다 큽니다 -- 근거로 적힌
   * 것이 근거가 아니면, 다음부터 근거 줄을 안 읽게 됩니다.
   */
  const guessed = peers.rows
    .filter((row) => classifyHeadline(row.headline) === "material")
    .sort((a, b) => b.move - a.move);

  /*
   * 같은 종목의 기사는 하나만.
   *
   * 제목 정규화로는 안 묶입니다 -- 매체마다 부제가 달라서 같은 사건이 서로 다른
   * 기사입니다("형지엘리트, '남북경협 전담 TF' 출범…한반도 교복 공급망 구상"과
   * "…개성공단 생산 이력 바탕으로 대응체계 구축"). 여기서 알고 싶은 것은 **어느
   * 종목이 왜 움직였나**이므로 종목당 한 줄이면 충분합니다.
   */
  const perPeer = new Map();

  for (const row of guessed) {
    if (!perPeer.has(row.peer)) perPeer.set(row.peer, row);
  }

  return { kind: perPeer.size ? "theme" : "none", filings: [], cautions, news: [...perPeer.values()].slice(0, 2) };
}
