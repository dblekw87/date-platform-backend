import { query } from "../db/client.mjs";

/**
 * 어느 창을 볼 것인가.
 *
 * 재는 쪽과 고르는 쪽이 같은 창을 써야 해서 따로 뒀습니다. 창은 **직전 거래일
 * 15:40부터 대상일 08:50까지** 입니다. 시작이 15:40인 것은 그때가 KRX 정규장이
 * 끝나는 시각이라 그 뒤에 나온 것은 아직 거래되지 않았기 때문이고, 끝이 08:50인
 * 것은 NXT 프리마켓이 그때 멈춰 09:00 주문 직전의 마지막 시점이기 때문입니다.
 *
 * 창을 잡는 방법은 주말이든 평일 하룻밤이든 같지만, **값은 같지 않습니다.**
 * 2026-09-20에 20세션으로 갈라 재니 같은 "새 재료"가 주말 창에서는 장중 초과
 * +1.01%p(승률 58%)인데 평일 창에서는 +0.23%p(46%)로 대조군과 구별되지 않았습니다.
 * 이틀치 뉴스가 한 번에 반영되는 자리라서로 보입니다. 그래서 어느 창인지를
 * 같이 돌려줍니다 -- 거르는 데는 아직 안 쓰고 읽는 사람이 무게를 정하도록 둡니다.
 */

export async function tradingSessions(config, since = "2026-08-14") {
  const { rows } = await query(config, `
    SELECT DISTINCT session_date::text AS d FROM kr_daily_bars
     WHERE session_date >= $1 ORDER BY 1`, [since]);

  return rows.map((row) => row.d);
}

/*
 * 아직 열리지 않은 장을 대상으로 삼습니다. kr_daily_bars의 마지막 날이 직전
 * 거래일이므로 창은 거기서 시작하고, 끝은 "지금"입니다 -- 일요일 밤에 돌리면
 * 일요일 밤까지 나온 것만 보고, 월요일 아침에 다시 돌리면 그 사이에 나온 것이
 * 더해집니다.
 */
export function upcomingWindow(sessions, now = new Date()) {
  const previous = sessions[sessions.length - 1];
  /* 직전 거래일이 금요일이면 다음 장은 월요일입니다. 국내 휴장일 목록이 없어
   * 다음 장이 언제인지는 모르지만 직전 장에서 며칠 지났는지는 알 수 있으므로,
   * 연휴로 사흘 넘게 벌어진 경우도 같은 창으로 봅니다. */
  const previousNoon = new Date(`${previous}T12:00:00+09:00`);
  const elapsedDays = Math.floor((now - previousNoon) / 86400000);

  return {
    previous,
    from: new Date(`${previous}T15:40:00+09:00`),
    to: now,
    /* 직전 장이 열려 있던 동안. 그때 이미 기사가 돌던 종목인지 보려고 같이
     * 돌려줍니다 -- 마감 뒤 기사가 새 사실인지 낮에 하던 얘기의 연장인지가
     * 여기서 갈립니다. */
    sessionFrom: new Date(`${previous}T09:00:00+09:00`),
    sessionTo: new Date(`${previous}T15:40:00+09:00`),
    weekend: previousNoon.getUTCDay() === 5 || elapsedDays >= 3
  };
}
