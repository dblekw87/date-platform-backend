import { query } from "../db/client.mjs";

/**
 * 어느 창을 볼 것인가.
 *
 * 재는 쪽과 고르는 쪽이 같은 창을 써야 해서 따로 뒀습니다. 창은 **직전 거래일
 * 15:40부터 대상일 08:50까지** 입니다. 시작이 15:40인 것은 그때가 KRX 정규장이
 * 끝나는 시각이라 그 뒤에 나온 것은 아직 거래되지 않았기 때문이고, 끝이 08:50인
 * 것은 NXT 프리마켓이 그때 멈춰 09:00 주문 직전의 마지막 시점이기 때문입니다.
 *
 * 금요일 15:40부터 월요일 08:50까지가 곧 주말 창이라, 주말이라고 다르게 다룰
 * 것이 없습니다. 컴퓨터를 껐다 켠 주말이든 평일 하룻밤이든 같은 코드가 답합니다.
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

  return {
    previous,
    from: new Date(`${previous}T15:40:00+09:00`),
    to: now,
    /* 직전 장이 열려 있던 동안. 그때 이미 기사가 돌던 종목인지 보려고 같이
     * 돌려줍니다 -- 마감 뒤 기사가 새 사실인지 낮에 하던 얘기의 연장인지가
     * 여기서 갈립니다. */
    sessionFrom: new Date(`${previous}T09:00:00+09:00`),
    sessionTo: new Date(`${previous}T15:40:00+09:00`)
  };
}
