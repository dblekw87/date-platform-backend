import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

export function readConfig() {
  const frontendOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    // 알림에 붙는 링크. 눌러서 바로 보드를 열 수 있게.
    publicSiteUrl: process.env.PUBLIC_SITE_URL ?? "https://date-platform.vercel.app",
    kakao: {
      // 짝꿍 알림용. 없으면 알림만 조용히 꺼지고 나머지는 그대로 돕니다.
      restApiKey: process.env.KAKAO_REST_API_KEY,
      refreshToken: process.env.KAKAO_REFRESH_TOKEN
    },
    port: Number(process.env.PORT ?? 4010),
    frontendOrigins,
    databaseUrl: process.env.DATABASE_URL,
    internalJwtSecret: process.env.INTERNAL_JWT_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT ?? 4010}`,
    uploadDir: process.env.UPLOAD_DIR || "data/uploads",
    marketDataMode: process.env.MARKET_DATA_MODE === "licensed-live" ? "licensed-live" : "demo",
    // Off unless asked for: the collector writes to the database on a timer, so
    // a machine that only serves requests should not start one.
    marketCollector: process.env.MARKET_COLLECTOR === "true",
    // Off unless asked for, like the collector: the nightly rebuild writes to
    // the database and only one machine should be doing it.
    usPipeline: process.env.US_PIPELINE === "true",
    // How many share counts one nightly run refreshes. The set worth keeping
    // current is ~2,300 symbols and a free key allows five requests a minute,
    // so 250 a night is roughly an hour and brings the whole set round weekly.
    usPipelineShareSlice: Number(process.env.US_PIPELINE_SHARE_SLICE ?? 250),
    toss: {
      baseUrl: process.env.TOSS_INVEST_BASE_URL ?? "https://openapi.tossinvest.com",
      clientId: process.env.TOSS_INVEST_CLIENT_ID,
      clientSecret: process.env.TOSS_INVEST_CLIENT_SECRET
    },
    kis: {
      baseUrl: process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443",
      appKey: process.env.KIS_APP_KEY,
      appSecret: process.env.KIS_APP_SECRET,
      htsId: process.env.KIS_HTS_ID,
      enableMinuteCharts: process.env.KIS_ENABLE_MINUTE_CHARTS === "true"
    },
    // Providers migrated from the frontend adapter layer. Unlike Toss and KIS
    // these are not gated by MARKET_DATA_MODE.
    dart: {
      apiKey: process.env.DART_API_KEY
    },
    krx: {
      calendarFeedUrl: process.env.KRX_CALENDAR_FEED_URL
    },
    market: {
      finnhubApiKey: process.env.FINNHUB_API_KEY
    },
    // Whole-market US history, read by the backfill script rather than by a
    // request. Free keys are capped at a few calls a minute, so the pace is
    // configured instead of assumed.
    massive: {
      apiKey: process.env.MASSIVE_API_KEY,
      baseUrl: process.env.MASSIVE_BASE_URL ?? "https://api.polygon.io",
      requestsPerMinute: Number(process.env.MASSIVE_REQUESTS_PER_MINUTE ?? 5)
    },
    news: {
      benzingaApiKey: process.env.BENZINGA_API_KEY,
      feedUrl: process.env.MARKET_BOARD_NEWS_FEED_URL,
      finnhubApiKey: process.env.FINNHUB_API_KEY,
      naverApiHubKey: process.env.NAVER_API_HUB_KEY,
      naverApiHubKeyId: process.env.NAVER_API_HUB_KEY_ID,
      naverSearchClientId: process.env.NAVER_SEARCH_CLIENT_ID ?? process.env.NAVER_CLIENT_ID,
      naverSearchClientSecret: process.env.NAVER_SEARCH_CLIENT_SECRET ?? process.env.NAVER_CLIENT_SECRET,
      newsApiKey: process.env.NEWSAPI_KEY,
      papagoClientId: process.env.NAVER_PAPAGO_CLIENT_ID,
      papagoClientSecret: process.env.NAVER_PAPAGO_CLIENT_SECRET
    },
    sec: {
      userAgent: process.env.SEC_USER_AGENT || "DATE Market Board admin@date-platform.local"
    }
  };
}

export function hasTossCredentials(config) {
  return Boolean(config.toss.clientId && config.toss.clientSecret);
}

export function hasKisCredentials(config) {
  return Boolean(config.kis.appKey && config.kis.appSecret);
}
