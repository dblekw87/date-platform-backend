import { hasTossCredentials } from "../config.mjs";
import { loadTossExchangeRate, loadTossLeaders } from "../providers/toss.mjs";

export async function getMarketBoard(config) {
  const checkedAt = new Date().toISOString();

  if (!hasTossCredentials(config)) {
    return {
      providerStatuses: [
        {
          id: "toss",
          label: "토스증권 Open API",
          status: "mock",
          message: "TOSS_INVEST_CLIENT_ID, TOSS_INVEST_CLIENT_SECRET 없음 · provider 비활성",
          checkedAt
        }
      ],
      krLeadingStocks: [],
      usLeadingStocks: [],
      macroSnapshot: []
    };
  }

  const [krLeadingStocks, usLeadingStocks, usdKrw] = await Promise.all([
    loadTossLeaders(config, "KR"),
    loadTossLeaders(config, "US"),
    loadTossExchangeRate(config, "USD", "KRW").catch(() => null)
  ]);

  return {
    providerStatuses: [
      {
        id: "toss",
        label: "토스증권 Open API",
        status: "ready",
        message: "backend adapter 활성화 · live 데이터 수신",
        checkedAt
      }
    ],
    krLeadingStocks,
    usLeadingStocks,
    macroSnapshot: usdKrw ? [
      {
        id: "usd-krw",
        label: "원/달러 환율",
        market: "KR",
        instrumentType: "fx",
        symbol: "USD/KRW",
        value: usdKrw.rate ?? usdKrw.midRate ?? "확인 중",
        tone: "flat",
        note: "토스증권 참고 환율",
        timestamp: usdKrw.validFrom ?? usdKrw.timestamp,
        source: "toss"
      }
    ] : []
  };
}
