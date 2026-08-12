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
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT ?? 4010}`,
    uploadDir: process.env.UPLOAD_DIR || "data/uploads",
    toss: {
      baseUrl: process.env.TOSS_INVEST_BASE_URL ?? "https://openapi.tossinvest.com",
      clientId: process.env.TOSS_INVEST_CLIENT_ID,
      clientSecret: process.env.TOSS_INVEST_CLIENT_SECRET
    }
  };
}

export function hasTossCredentials(config) {
  return Boolean(config.toss.clientId && config.toss.clientSecret);
}
