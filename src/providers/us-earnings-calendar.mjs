import { fetchJson } from "../http.mjs";

/**
 * 미국 대형주 실적 발표 -- 금리 일정 알림에 같이 싣는 쪽.
 *
 * 2026-11-05 사용자 요청입니다("어닝 서프라이즈나 실적 발표일도 중요할 것 같은데
 * 날짜 같은 것들" → "미국 실적 일정만 먼저"). 보드 일정 탭이 Finnhub에서 받아 쓰던
 * 것과 같은 원본인데, 그쪽은 하루 수백 건 중 매출 예상치 상위만 남겨 화면에 보이던
 * 것이라 국내로 번지는 이름이 빠질 수 있습니다. 여기서는 국내 종목에 번지는 이름만
 * 고정 목록으로 고릅니다.
 *
 * Finnhub는 한 번에 1,500행까지만 줍니다. 3주를 물으면 잘려서(2026-11-05 실측) 알림
 * 창에 맞게 닷새만 묻습니다.
 *
 * 발표 시각은 bmo(장 전)·amc(장 후)·빈칸으로 옵니다. 미국 동부 08:00·16:30·12:00으로
 * 둡니다 -- 정확한 분이 아니라 국내 다음 장 전인지 뒤인지를 가르는 데만 씁니다.
 */

// [티커, 국내에서 같이 볼 쪽]
const watchlist = new Map([
  ["NVDA", "반도체·AI"], ["AMD", "반도체·AI"], ["AVGO", "반도체·AI"], ["MU", "메모리(하이닉스·삼성)"],
  ["TSM", "파운드리"], ["ASML", "반도체 장비"], ["AMAT", "반도체 장비"], ["LRCX", "반도체 장비"],
  ["KLAC", "반도체 장비"], ["INTC", "반도체"], ["QCOM", "반도체"], ["ARM", "반도체"],
  ["SNDK", "낸드"], ["WDC", "낸드·스토리지"], ["SMCI", "AI 서버"], ["DELL", "AI 서버"],
  ["ANET", "AI 네트워크·광통신"], ["COHR", "광통신"], ["CSCO", "네트워크"], ["VRT", "전력설비"],
  ["CEG", "원전·전력"], ["GEV", "전력설비"], ["ETN", "전력설비"], ["FSLR", "태양광"],
  ["ENPH", "태양광"], ["BE", "연료전지"], ["TSLA", "2차전지·자동차"], ["AAPL", "IT 부품"],
  ["MSFT", "AI·클라우드"], ["GOOGL", "AI·클라우드"], ["AMZN", "AI·클라우드"], ["META", "AI"],
  ["ORCL", "AI·클라우드"], ["PLTR", "AI 소프트웨어"], ["LLY", "비만약"], ["NVO", "비만약"],
  ["COIN", "가상자산"], ["MSTR", "가상자산"], ["WMT", "소비"], ["HD", "소비"]
]);

const easternHour = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });

function easternInstant(day, hour, minute) {
  const [year, month, date] = day.split("-").map(Number);

  for (const offset of [4, 5]) {
    const candidate = new Date(Date.UTC(year, month - 1, date, hour + offset, minute));

    if (Number(easternHour.format(candidate)) === hour) return candidate;
  }

  return new Date(Date.UTC(year, month - 1, date, hour + 5, minute));
}

function addDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

const timing = {
  amc: { hour: 16, label: "장 마감 후", minute: 30 },
  bmo: { hour: 8, label: "장 시작 전", minute: 0 }
};

/** from(미국 날짜)부터 닷새 안의 목록 종목 실적 발표. 실패하면 빈 목록입니다. */
export async function loadUsEarnings(config, from) {
  const key = config.news?.finnhubApiKey;

  if (!key) return [];

  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${addDays(from, 5)}&token=${key}`;
  const data = await fetchJson(url, { timeoutMs: 5000 }).catch(() => null);

  return (data?.earningsCalendar ?? [])
    .filter((item) => watchlist.has(item.symbol) && item.date)
    .map((item) => {
      const when = timing[item.hour] ?? { hour: 12, label: "시각 미정", minute: 0 };

      return {
        at: easternInstant(item.date, when.hour, when.minute),
        detail: [
          when.label,
          typeof item.epsEstimate === "number" ? `EPS 예상 ${item.epsEstimate.toFixed(2)}` : null,
          `국내 ${watchlist.get(item.symbol)}`
        ].filter(Boolean).join(" · "),
        id: `earnings:${item.symbol}:${item.date}`,
        kind: "earnings",
        label: `${item.symbol} 실적`
      };
    });
}
