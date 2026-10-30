/**
 * 금리 일정: FOMC 결정, 한국은행 금통위, 미국 CPI·PCE·고용보고서.
 *
 * 2026-10-25 사용자 질문("금리 인상을 한다는 내용이나 이런것들은 어떻게 해?")에서
 * 시작했습니다. 보드의 일정 탭은 FOMC·CPI를 보여 준다고 적혀 있었지만 실제로는
 * 실적과 공모주뿐이었습니다. 종가배팅은 밤을 넘기는 매매라, 그 밤에 금리 결정이나
 * 물가 발표가 있는지가 진입 전에 알아야 할 위험입니다.
 *
 * us-holidays.mjs처럼 적어 둡니다. 셋 다 해마다 미리 공개되고, 바깥에 물어보다
 * 실패하면 그날 알림이 비기 때문입니다. 출처(2026-10-25에 받음):
 *
 *   FOMC  federalreserve.gov/monetarypolicy/fomccalendars.htm  (회의 둘째 날 14:00 ET)
 *   CPI   bls.gov/schedule/news_release/cpi.htm, 지난 것은 bls.gov/bls/news-release/cpi.htm
 *         의 보관 파일 이름(cpi_MMDDYYYY)  (08:30 ET). 2025년 10월분은 셧다운으로 미발표
 *   금통위 bok.or.kr 통화정책방향 결정회의 일정. 2027년은 아직 공개 전입니다
 *   PCE   bea.gov/news/schedule 의 Personal Income and Outlays (08:30 ET, 2026-10-30에 받음).
 *         2027년은 그 페이지의 2027 탭에서 받아야 합니다
 *   고용  bls.gov/schedule/news_release/empsit.htm (08:30 ET, 2026-10-30에 받음)
 *
 * PCE와 고용은 2026-10-30 사용자 요청으로 더했습니다. 10/29 밤 9월 근원 PCE가 +0.5%
 * (예상 +0.3%)로 나온 밤 코스피가 다음 날 −3.48%였는데(알파벳 실적과 겹침) 알림에
 * 없었습니다.
 *
 * **해가 바뀌면 여기에 한 줄 더하세요.** 금통위 2027년은 보통 연말에 나옵니다.
 *
 * 금통위 시각은 발표 시각이 아니라 한국은행 보도자료 RSS의 게시 시각(10:30)입니다.
 * 2026-08-27과 10-22 두 번 다 10:30이었습니다.
 */

// 회의 둘째 날(결정일, 미국 동부 날짜). 별표(*)는 경제전망(점도표)이 같이 나오는 회의.
const fomcDecisions = [
  "2025-01-29", "2025-03-19*", "2025-05-07", "2025-06-18*", "2025-07-30", "2025-09-17*", "2025-10-29", "2025-12-10*",
  "2026-01-28", "2026-03-18*", "2026-04-29", "2026-06-17*", "2026-07-29", "2026-09-16*", "2026-10-28", "2026-12-09*",
  "2027-01-27", "2027-03-17*", "2027-04-28", "2027-06-09*", "2027-07-28", "2027-09-15*", "2027-10-27", "2027-12-08*"
];

// [발표일(미국 동부), 기준 월]
const cpiReleases = [
  ["2025-01-15", 12], ["2025-02-12", 1], ["2025-03-12", 2], ["2025-04-10", 3], ["2025-05-13", 4], ["2025-06-11", 5],
  ["2025-07-15", 6], ["2025-08-12", 7], ["2025-09-11", 8], ["2025-10-24", 9], ["2025-12-18", 11],
  ["2026-01-13", 12], ["2026-02-13", 1], ["2026-03-11", 2], ["2026-04-10", 3], ["2026-05-12", 4], ["2026-06-10", 5],
  ["2026-07-14", 6], ["2026-08-12", 7], ["2026-09-11", 8], ["2026-10-14", 9], ["2026-11-10", 10], ["2026-12-10", 11],
  ["2027-01-13", 12], ["2027-02-11", 1], ["2027-03-10", 2], ["2027-04-13", 3], ["2027-05-12", 4], ["2027-06-10", 5],
  ["2027-07-14", 6], ["2027-08-11", 7], ["2027-09-14", 8], ["2027-10-14", 9], ["2027-11-10", 10], ["2027-12-10", 11]
];

// [발표일(미국 동부), 기준 월, 같은 날 나오는 GDP]
const pceReleases = [
  ["2026-10-29", 9, "3분기 GDP 속보"], ["2026-11-25", 10, "3분기 GDP 2차"], ["2026-12-23", 11, "3분기 GDP 3차"]
];

// [발표일(미국 동부), 기준 월] 비농업 고용·실업률
const jobsReleases = [
  ["2026-11-06", 10], ["2026-12-04", 11], ["2027-01-08", 12], ["2027-02-05", 1], ["2027-03-05", 2], ["2027-04-02", 3],
  ["2027-05-07", 4], ["2027-06-04", 5], ["2027-07-02", 6], ["2027-08-06", 7], ["2027-09-03", 8], ["2027-10-08", 9],
  ["2027-11-05", 10], ["2027-12-03", 11]
];

// 통화정책방향 결정회의(한국 날짜)
const bokDecisions = [
  "2025-01-16", "2025-02-25", "2025-04-17", "2025-05-29", "2025-07-10", "2025-08-28", "2025-10-23", "2025-11-27",
  "2026-01-15", "2026-02-26", "2026-04-10", "2026-05-28", "2026-07-16", "2026-08-27", "2026-10-22", "2026-11-26"
];

const easternHour = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });

/*
 * 미국 동부 벽시계 시각을 실제 순간으로. 서머타임이면 UTC−4, 아니면 −5인데,
 * 바뀌는 날을 적어 두는 대신 두 후보 중 동부 시계로 되읽었을 때 맞는 쪽을 고릅니다.
 */
function easternInstant(day, hour, minute) {
  const [year, month, date] = day.split("-").map(Number);

  for (const offset of [4, 5]) {
    const candidate = new Date(Date.UTC(year, month - 1, date, hour + offset, minute));

    if (Number(easternHour.format(candidate)) === hour) return candidate;
  }

  return new Date(Date.UTC(year, month - 1, date, hour + 5, minute));
}

function seoulInstant(day, hour, minute) {
  const [year, month, date] = day.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, date, hour - 9, minute));
}

/** 전부. 시각순입니다. */
export function macroEvents() {
  const events = [
    ...fomcDecisions.map((entry) => {
      const day = entry.replace("*", "");
      const projections = entry.endsWith("*");

      return {
        at: easternInstant(day, 14, 0),
        detail: projections ? "점도표 포함 · 파월 기자회견 30분 뒤" : "파월 기자회견 30분 뒤",
        id: `fomc:${day}`,
        kind: "fomc",
        label: "FOMC 금리 결정"
      };
    }),
    ...cpiReleases.map(([day, month]) => ({
      at: easternInstant(day, 8, 30),
      detail: null,
      id: `cpi:${day}`,
      kind: "cpi",
      label: `美 CPI(${month}월분)`
    })),
    ...pceReleases.map(([day, month, gdp]) => ({
      at: easternInstant(day, 8, 30),
      detail: gdp ? `${gdp} 같이` : null,
      id: `pce:${day}`,
      kind: "pce",
      label: `美 PCE 물가(${month}월분)`
    })),
    ...jobsReleases.map(([day, month]) => ({
      at: easternInstant(day, 8, 30),
      detail: "비농업 고용·실업률",
      id: `jobs:${day}`,
      kind: "jobs",
      label: `美 고용보고서(${month}월분)`
    })),
    ...bokDecisions.map((day) => ({
      at: seoulInstant(day, 10, 30),
      detail: "통화정책방향 보도자료 10:30경",
      id: `bok:${day}`,
      kind: "bok",
      label: "한은 금통위 금리 결정"
    }))
  ];

  return events.sort((left, right) => left.at - right.at);
}

/** from 이상 to 미만에 있는 것. */
export function macroEventsBetween(from, to) {
  return macroEvents().filter((event) => event.at >= from && event.at < to);
}
