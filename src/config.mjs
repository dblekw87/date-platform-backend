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
    port: Number(process.env.PORT ?? 4010),
    frontendOrigins,
    databaseUrl: process.env.DATABASE_URL,
    internalJwtSecret: process.env.INTERNAL_JWT_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT ?? 4010}`,
    uploadDir: process.env.UPLOAD_DIR || "data/uploads",
    marketDataMode: process.env.MARKET_DATA_MODE === "licensed-live" ? "licensed-live" : "demo",
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
    market: {
      finnhubApiKey: process.env.FINNHUB_API_KEY
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
