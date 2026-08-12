import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

const expectedTables = [
  "users",
  "profiles",
  "community_posts",
  "community_comments",
  "trade_journals",
  "media_assets",
  "schema_migrations"
];

const config = readConfig();

let database;
let tables;

try {
  database = await query(config, "SELECT current_database() AS database, current_user AS user");
  tables = await query(config, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [expectedTables]);
} catch (error) {
  console.error("database check failed");

  if (!config.databaseUrl) {
    console.error("DATABASE_URL is not configured. Create .env from .env.example or set DATABASE_URL.");
  } else if (error.code === "ECONNREFUSED") {
    console.error("PostgreSQL is not accepting connections at DATABASE_URL.");
    console.error("Start PostgreSQL, then run: npm run db:migrate && npm run db:check");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }

  process.exit(1);
}

const foundTables = new Set(tables.rows.map((row) => row.table_name));
const missingTables = expectedTables.filter((tableName) => !foundTables.has(tableName));

if (missingTables.length > 0) {
  console.error(`missing tables: ${missingTables.join(", ")}`);
  process.exit(1);
}

console.log(`database ok: ${database.rows[0].database}`);
console.log(`database user: ${database.rows[0].user}`);
console.log(`tables ok: ${expectedTables.join(", ")}`);

process.exit(0);
