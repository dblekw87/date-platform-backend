/**
 * 시장 전체 급등 스캔. 예약 스크리너가 못 보는 크기까지 내려갑니다.
 *
 * 2026-08-31 밤에 두 종목을 나란히 놓치고 만들었습니다.
 *
 *   RDHL  프리 +116% → 정규장 +139%. 감시 목록에 없어 한 행도 안 잡혔습니다.
 *   CLGN  프리 +4% → 정규장 +187%. 목록엔 있었지만 개장 후 터져서 알림 대상이 아니었습니다.
 *
 * 예약 스크리너(`predefined/saved`)는 시총 바닥이 있습니다. 그날 실측:
 *
 *   day_gainers  $2.0B · small_cap_gainers  $383M · aggressive_small_caps  $26M
 *
 * RDHL은 시총 $4M이라 얼마를 오르든 어느 목록에도 안 들어옵니다. 타이밍 문제가
 * 아니라 구조 문제라, 개장을 기다려도 영영 안 잡힙니다.
 *
 * 커스텀 스크리너는 크럼이 필요한 대신 바닥이 없습니다. 크럼은 fc.yahoo.com이
 * 심는 쿠키와 짝이라 둘을 같이 들고 다녀야 합니다.
 *
 * **거래소 필터가 이 모듈의 핵심입니다.** 안 걸면 OTC가 상위를 독식합니다 --
 * 필터 없이 부르면 KTRIF +52,500%, CTHRQ +48,650%, MPVDF +1,900% 같은 값이
 * 25칸을 다 채워 진짜 급등주가 묻힙니다(F나 Q로 끝나는 티커들, 대부분 해외
 * 원주의 미국 호가라 체결이 거의 없습니다). NMS/NGM/NCM/NYQ로 자르면 나스닥·NYSE
 * 정규 상장만 남고, 그때 RDHL이 1위로 나왔습니다.
 */

const crumbUrl = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const cookieUrl = "https://fc.yahoo.com";
const screenerUrl = "https://query1.finance.yahoo.com/v1/finance/screener";
// 스크리너는 기본 클라이언트 식별자를 거부합니다. market.mjs와 같은 값입니다.
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// 나스닥·NYSE 정규 상장만. 이유는 위 주석 참고 -- 이 목록이 필터의 전부입니다.
const exchanges = ["NMS", "NGM", "NCM", "NYQ"];

// 크럼은 쿠키와 한 쌍이고 만료됩니다. 만료를 미리 알 방법이 없으므로 401을 보고
// 한 번 다시 받습니다. 매번 새로 받으면 호출이 세 배가 됩니다.
let session = null;

async function openSession() {
  const response = await fetch(cookieUrl, {
    headers: { "User-Agent": browserUserAgent },
    signal: AbortSignal.timeout(6000)
  });
  // fc.yahoo.com은 404를 주면서 쿠키를 심습니다. 상태 코드로 판단하면 안 됩니다.
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(";")[0])
    .join("; ");

  if (!cookie) throw new Error("yahoo cookie missing");

  const crumbResponse = await fetch(crumbUrl, {
    headers: { "User-Agent": browserUserAgent, Cookie: cookie },
    signal: AbortSignal.timeout(6000)
  });
  const crumb = (await crumbResponse.text()).trim();

  // 실패하면 HTML 한 장이 돌아옵니다. 그것을 크럼으로 들고 다니면 매 호출이
  // 401이 되고 원인이 안 보입니다.
  if (!crumb || crumb.length > 32 || crumb.includes("<")) throw new Error(`yahoo crumb invalid: ${crumb.slice(0, 40)}`);

  return { cookie, crumb };
}

async function ask(body) {
  if (!session) session = await openSession();

  const call = async () => fetch(`${screenerUrl}?crumb=${encodeURIComponent(session.crumb)}&lang=en-US&region=US`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "User-Agent": browserUserAgent
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });

  let response = await call();

  // 만료된 크럼은 401입니다. 한 번만 다시 받고, 그래도 안 되면 포기합니다 --
  // 여기서 계속 재시도하면 야후가 아예 막습니다.
  if (response.status === 401) {
    session = await openSession();
    response = await call();
  }

  if (!response.ok) throw new Error(`screener HTTP ${response.status}`);

  const data = await response.json();

  if (data?.finance?.error) throw new Error(`screener ${data.finance.error.code}`);

  return data?.finance?.result?.[0]?.quotes ?? [];
}

/**
 * 오늘 정규장에서 minPercent 넘게 오른 종목 전부.
 *
 * `percentchange`는 **정규장 기준**입니다. 장 밖에서 부르면 직전 정규장 값이
 * 그대로 나오므로, 프리마켓 급등을 이걸로 잡으려 하면 안 됩니다. 프리마켓은
 * 여전히 감시 목록 방식이고, 이 모듈은 정규장을 답합니다.
 *
 * dayvolume 문턱은 체결이 있었다는 최소 증거입니다. 없으면 호가만 뛴 종목이
 * 상위에 섞입니다.
 */
export async function loadUsMarketGainers(config, { minPercent = 20, minVolume = 200_000, size = 50 } = {}) {
  const quotes = await ask({
    size,
    offset: 0,
    sortField: "percentchange",
    sortType: "DESC",
    quoteType: "EQUITY",
    query: {
      operator: "AND",
      operands: [
        { operator: "gt", operands: ["percentchange", minPercent] },
        { operator: "gt", operands: ["dayvolume", minVolume] },
        { operator: "or", operands: exchanges.map((code) => ({ operator: "eq", operands: ["exchange", code] })) }
      ]
    },
    userId: "",
    userIdType: "guid"
  });

  return quotes
    .map((quote) => {
      const price = Number(quote.regularMarketPrice);
      const volume = Number(quote.regularMarketVolume ?? 0);

      return {
        // 퍼센트입니다. 비율이 아닙니다 -- premarket.mjs는 비율을 쓰므로 이름을
        // 다르게 두어 섞이지 않게 합니다.
        changePercent: Number(quote.regularMarketChangePercent),
        exchange: quote.fullExchangeName ?? quote.exchange ?? null,
        marketCap: Number(quote.marketCap ?? 0) || null,
        name: quote.shortName ?? quote.longName ?? quote.symbol,
        price,
        symbol: quote.symbol,
        // 거래대금. 회전율이 미국 급등에서 유일하게 살아남은 신호였으므로
        // (뉴스·차트·공시는 전부 탈락) 문턱은 여기에 겁니다.
        turnover: Number.isFinite(price) && Number.isFinite(volume) ? price * volume : 0,
        volume
      };
    })
    .filter((row) => Number.isFinite(row.changePercent) && Number.isFinite(row.price) && row.price > 0)
    .sort((left, right) => right.changePercent - left.changePercent);
}
