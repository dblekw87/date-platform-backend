/**
 * 네이버 상승률 상위 목록. **종목을 찾는 데만 씁니다.**
 *
 * KIS 거래대금 랭킹이 우리 국내 유니버스의 뼈대인데, 그 목록이 60종목뿐입니다.
 * 거기 못 든 종목은 표본이 한 줄도 안 쌓이고, 표본이 없으면 상따 감시도 짝꿍도
 * 그 종목을 영영 못 봅니다.
 *
 * 2026-09-29 테라뷰(950250)가 그랬습니다. 오늘 +30% 상한가로 마감하고 거래대금
 * 344억이었는데 우리 표본은 0건이었습니다. 사용자가 그 종목을 +29.1%에 직접 잡았고,
 * 우리 알림은 나갈 수가 없었습니다. 같은 시각 네이버 상승률 목록에는 09:44부터
 * 올라와 있었습니다.
 *
 * **값은 여기서 읽지 않습니다.** 네이버가 주는 등락률·거래대금을 그대로 저장하면
 * 같은 표에 두 출처의 숫자가 섞여, 어느 행이 어느 자로 잰 것인지 알 수 없게 됩니다.
 * 여기서는 **종목 코드만** 얻고 시세는 KIS에 다시 물어 채웁니다 -- 자는 하나여야 합니다.
 *
 * 문턱 10%는 비용에서 나왔습니다. 2026-09-29 장 마감 기준 코스피·코스닥 상승률 상위
 * 200종목 중 10% 이상이 37종목, 15% 이상이 14종목이었습니다. 상따 감시가 소형 25%에서
 * 시작하므로 10%면 도달 한참 전에 표본이 쌓이기 시작하고, 종목 수는 한 틱에 수십 건이라
 * KIS 시세 조회로 감당됩니다.
 */

const endpoint = "https://m.stock.naver.com/api/stocks/up";
const markets = ["KOSPI", "KOSDAQ"];
/* 사업 회사가 아닌 것. market_watch.py가 쓰는 목록과 같은 이유로 같은 낱말을 씁니다. */
const notCompanies = /ETF|ETN|KODEX|TIGER|KBSTAR|ACE |SOL |HANARO|PLUS |RISE |스팩/;

function usable(name) {
  if (!name) return false;
  if (notCompanies.test(name)) return false;

  /* 우선주. 끝이 '우'이거나 우B·우C 꼴입니다. 본주와 따로 움직이지만 재료는 본주에
     붙고, 상따 자리도 본주에서 나옵니다. */
  return !/우$|우[BC]$/.test(name);
}

function rateOf(row) {
  const raw = String(row?.fluctuationsRatio ?? "").replace(/,/g, "");
  const value = Number.parseFloat(raw);

  return Number.isFinite(value) ? value : null;
}

/**
 * 오늘 많이 오른 종목의 코드. 실패하면 빈 배열입니다 -- 이 목록이 없다고 수집을
 * 멈추면 안 됩니다. 원래 보던 것은 그대로 봅니다.
 */
export async function loadNaverMoverSymbols({ minRate = 10, timeoutMs = 6000 } = {}) {
  const found = new Map();

  await Promise.all(markets.map(async (market) => {
    try {
      const response = await fetch(`${endpoint}/${market}?page=1&pageSize=100`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) throw new Error(`naver movers ${response.status}`);

      const data = await response.json();

      for (const row of data?.stocks ?? []) {
        const symbol = String(row?.itemCode ?? "").trim();
        const name = String(row?.stockName ?? "").trim();
        const rate = rateOf(row);

        if (!symbol || !usable(name) || rate === null || rate < minRate) continue;

        found.set(symbol, { name, rate, symbol });
      }
    } catch (error) {
      console.warn(`collector: naver movers ${market} failed`, error instanceof Error ? error.message : error);
    }
  }));

  return [...found.values()].sort((left, right) => right.rate - left.rate);
}
