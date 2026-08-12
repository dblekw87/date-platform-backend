import pg from "pg";

const { Pool } = pg;

let pool;

export function getPool(config) {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
  }

  return pool;
}

export async function query(config, text, params = []) {
  return getPool(config).query(text, params);
}
