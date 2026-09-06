/**
 * 지금 나온 재료는 어느 장을 겨냥한 것인가.
 *
 * 막지 않습니다 -- 재료는 하루 종일 나오고, 언제 나오든 살 자리가 있습니다.
 * 장중에 나오면 그날 사고, 마감 뒤에 나오면 애프터마켓(NXT 15:40~20:00)에서
 * 사거나 다음날 아침에 삽니다. 여기서는 **어느 쪽인지 이름만 붙입니다.**
 *
 * 이름을 붙이는 이유는 둘이 같은 조건이 아니기 때문입니다.
 *
 *   overnight  직전 거래일 15:40 이후에 나온 것. measure-overnight-news.mjs가
 *              10세션으로 잰 구간입니다 -- 복기 기사는 승률 40%, 호재 공시는 58%
 *   intraday   09:00~15:40에 나온 것. **재본 적이 없습니다.** 짝꿍도 장중 구간은
 *              대조군과 구별되지 않았으므로([[pair-intraday-verdict]]) 여기도
 *              그럴 수 있습니다. 섞어서 기록하면 나중에 갈라 볼 수 없어 종류를
 *              나눠 남깁니다
 */

const openMinute = 9 * 60;
const closeMinute = 15 * 60 + 40;

export function seoulNow(now = new Date()) {
  const seoul = new Date(now.getTime() + 9 * 3600_000);

  return {
    date: seoul.toISOString().slice(0, 10),
    minute: seoul.getUTCHours() * 60 + seoul.getUTCMinutes()
  };
}

export function materialPhase(now = new Date()) {
  const { minute } = seoulNow(now);

  return minute >= openMinute && minute < closeMinute ? "intraday" : "overnight";
}
