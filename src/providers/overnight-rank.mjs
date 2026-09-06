/**
 * 무엇을 빼고 무엇을 올릴 것인가.
 *
 * 규칙은 전부 measure-overnight-news.mjs가 잰 값에서 나왔습니다. 10세션·유동성
 * 10억 기준, 시장 평균 대비 장중(시가→종가) 초과수익입니다.
 *
 *   뉴스 있음(대조군)     -0.10%p   승률 45%
 *   news:recap          -0.69%p   승률 40%   10세션 중 8세션 음수
 *   news:material만      +0.46%p   승률 52%
 *   공시 있음(대조군)      +0.20%p   승률 52%
 *   filing:good         +0.50%p   승률 58%
 *   호재공시·복기없음       +0.58%p   승률 59%
 *
 * 읽는 법이 중요합니다. **가장 믿을 만한 것은 빼는 규칙입니다.** 복기 기사는
 * 시가가 +0.67%p 높게 열리고 장중에 -0.69%p 빠지며, 열 세션 중 여덟이 음수라
 * 부호가 흔들리지 않습니다. 반대로 올리는 규칙(호재 공시, 새 재료)은 평균은
 * 양수지만 세션별로 +5.6에서 -4.7까지 튀어 크기를 믿을 수 없습니다.
 *
 * 그래서 여기서는 **거르는 데 무게를 싣고 순위는 약하게** 매깁니다. 순위를
 * 정교하게 만들 근거가 아직 없습니다 -- 10세션은 방향만 겨우 말합니다.
 */

/* 상한가는 다음 날 사는 자리가 아닙니다. [[leader-trade-verdict]]에서 상승률
 * 상위의 +5.6%p가 전부 상한가라 못 사는 값이었던 것과 같은 이유입니다. */
const limitUpRate = 29;

export function rankPicks(candidates, universe) {
  const picks = [];

  for (const entry of candidates.values()) {
    const listing = universe.get(entry.symbol);

    if (!listing) continue;

    const blocked = blockReason(entry, listing);
    const hasMaterial = entry.material.length > 0;
    const hasGoodFiling = entry.good.length > 0;

    if (!hasMaterial && !hasGoodFiling) continue;
    if (blocked) continue;

    picks.push({
      ...entry,
      listing,
      score: score(entry),
      sourceCount: entry.sources.size
    });
  }

  return picks.sort((a, b) => b.score - a.score || b.listing.turnover - a.listing.turnover);
}

/* 뺀 이유를 값으로 돌려주는 것은 화면에 같이 적기 위해서입니다. 왜 없는지
 * 모르는 목록은 다음 주에 규칙을 고칠 때 아무것도 알려주지 않습니다. */
export function blockReason(entry, listing) {
  if (entry.recap > 0) return `복기 기사 ${entry.recap}건`;

  /*
   * 낮에 이미 다뤄진 종목은 뉴스만으로는 후보가 아닙니다.
   *
   * 재료 뉴스가 붙은 129건을 둘로 갈라 재면 방향이 반대입니다.
   *
   *   처음 나온 것   64건   장중 +1.43%p   승률 59%
   *   이어진 것      65건   장중 -0.48%p   승률 46%   (뉴스 대조군 45%와 같음)
   *
   * 조건의 값이 전부 앞쪽에 있습니다. 뒤쪽은 아무 뉴스나 붙은 종목과 구별되지
   * 않으므로, 그것을 후보에 올리는 것은 목록을 두 배로 늘리고 값을 절반으로
   * 나누는 일입니다.
   *
   * **공시가 있으면 걸지 않습니다.** 공시는 그 자체가 새 사실이라 낮에 기사가
   * 돌았는지와 무관하고, 실제로 갈라 재도 +0.62 대 +0.50으로 거의 같습니다.
   */
  if (entry.coveredInSession && !entry.good.length) return "직전 장중에 이미 다뤄짐";
  if (entry.dilution.length) return `희석 공시 ${entry.dilution.length}건`;
  if (entry.bad.length) return `악재 공시 ${entry.bad.length}건`;
  if (listing.halted || listing.managed) return "거래정지·관리종목";
  if (listing.change_rate >= limitUpRate) return "직전 상한가";

  return null;
}

/*
 * 점수.
 *
 * 공시를 뉴스보다 위에 둡니다 -- 승률이 58%대 52%로 갈리고, DART가 붙인
 * report_name이 기사 제목보다 정확합니다. 소스 수를 세는 것은 한 매체가 같은
 * 기사를 여덟 번 밀어낸 것과 여덟 매체가 각자 쓴 것을 가르기 위해서입니다
 * (2026-09-05 주말 실측: 현대제철 86건이 3개 매체에서 나왔습니다).
 */
function score(entry) {
  return Math.min(entry.good.length, 2) * 2
    + Math.min(entry.sources.size, 6) * 0.5
    + Math.min(entry.material.length, 10) * 0.1;
}

export function tierOf(pick) {
  if (pick.good.length && pick.sourceCount >= 3) return "A";
  if (pick.good.length || pick.sourceCount >= 4) return "B";

  return "C";
}
