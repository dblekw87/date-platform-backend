import { isKrMarketOpen } from "./kis.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { macroEventsBetween } from "./macro-calendar.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * [금리 일정] 오늘 종가에 사서 다음 장 아침에 파는 사이에 낀 금리 결정·물가·고용 발표.
 *
 * 2026-10-25 사용자 요청입니다. 종가배팅을 고르는 15:05~15:20 전에 와 있어야 해서
 * 14:40~15:00에 한 번 보냅니다. 낀 것이 없는 날은 보내지 않습니다.
 *
 * 범위는 지금부터 **다음 장 10:30**까지입니다. 금요일이면 월요일 아침까지 봅니다.
 * 10:30까지인 이유는 금통위(10:30경)를 같이 보이려는 것인데, 청산(09:05~09:10)보다
 * 늦게 나오므로 보유 위험이 아니라고 적습니다.
 *
 * 줄마다 붙는 측정은 scripts/measure-macro-nights.mjs(2026-10-25, 국내 2025-01~) 값입니다.
 * 표본이 작아(FOMC 14밤, CPI 21밤) 다시 재면 여기 숫자도 고칩니다.
 */

const kind = "macro_calendar";
const alertMinute = 14 * 60 + 40;
const stopMinute = 15 * 60;

const measured = {
  bok: "청산(09:05~09:10) 뒤 발표라 보유 위험은 아님. 금통위 날 장중 변동은 평소보다 작았음(15일)",
  cpi: "측정: CPI 밤엔 대형주 갭이 큼 — 시총 상위 30 갭 크기 중앙 2.24% vs 평소 0.99%(21밤). 중소형 평균은 비슷(0.61 vs 0.50)",
  fomc: "측정: FOMC 밤 다음 날 갭은 평소와 같음 — 시총 상위 30 갭 크기 중앙 0.96% vs 평소 0.99%(14밤)",
  jobs: "아직 측정 전(지난 발표일을 모아 재야 함)",
  pce: "아직 측정 전. 10/29 밤 근원 +0.5%(예상 +0.3%) 다음 날 코스피 −3.48%(알파벳 실적과 겹침)"
};

let running = false;

const seoulClock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: "Asia/Seoul" });
const seoulWeekday = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });

function seoulMinute(now) {
  const [hour, minute] = seoulClock.format(now).split(":").map(Number);

  return hour * 60 + minute;
}

/** 다음 장 날짜. 주말과 KIS 달력의 휴장일을 건너뜁니다. 일주일 안에 없으면 null. */
async function nextKrSession(config, today) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const noon = new Date(Date.parse(`${today}T12:00:00+09:00`) + offset * 86400000);
    const weekday = seoulWeekday.format(noon);

    if (weekday === "토" || weekday === "일") continue;
    if (await isKrMarketOpen(config, noon)) return sessionDate("KR", noon);
  }

  return null;
}

function whenLabel(at, today) {
  const day = sessionDate("KR", at);
  const clock = seoulClock.format(at);

  if (day === today) return `오늘${seoulMinute(at) >= 18 * 60 ? " 밤" : ""} ${clock}`;

  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}(${seoulWeekday.format(at)}) ${clock}`;
}

/** 알림 본문. 보내지 않고 문구만 확인할 수 있게 따로 둡니다(notify는 드라이런이 없습니다). */
export function macroCalendarText(events, { next, today, url }) {
  const lines = [`[금리 일정] 오늘 종가 → ${next ? `${Number(next.slice(5, 7))}/${Number(next.slice(8, 10))}` : "다음 장"} 아침 사이`, ""];

  for (const event of events) {
    lines.push(`· ${whenLabel(event.at, today)}  ${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
    lines.push(`  ${measured[event.kind]}`);
  }

  lines.push("");
  lines.push("결정 원문(연준 성명·한은 통화정책방향)은 나오는 대로 [美 발언]으로 갑니다. 00~07시 발표는 07시에.");
  if (url) lines.push(url);

  return lines.join("\n");
}

export async function notifyMacroCalendar(config, { minute, now = new Date(), url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const today = sessionDate("KR", now);

  running = true;

  try {
    if ((await loadAlertSent(config, kind, today)).has("done")) return 0;
    if (!await isKrMarketOpen(config, now)) return 0;

    const next = await nextKrSession(config, today);
    const until = next ? new Date(`${next}T10:31:00+09:00`) : new Date(now.getTime() + 3 * 86400000);
    const events = macroEventsBetween(now, until);

    if (!events.length) {
      await markAlertSent(config, kind, today, "done", { note: "일정 없음" });

      return 0;
    }

    if (!await notify(config, { text: macroCalendarText(events, { next, today, url }), url: null })) return 0;

    await markAlertSent(config, kind, today, "done", { note: events.map((event) => event.id).join(", ").slice(0, 200) });
    console.log(`알림: 금리 일정 ${events.map((event) => event.id).join(", ")}`);

    return events.length;
  } catch (error) {
    console.warn("macro calendar alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
