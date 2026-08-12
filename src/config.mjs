export function readConfig() {
  return {
    port: Number(process.env.PORT ?? 4010),
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
    databaseUrl: process.env.DATABASE_URL,
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
