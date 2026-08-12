import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

const config = readConfig();
const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));

await query(config, `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const applied = await query(config, "SELECT id FROM schema_migrations WHERE id = $1", [file]);

  if (applied.rowCount > 0) {
    console.log(`skip ${file}`);
    continue;
  }

  const sql = await readFile(join(migrationsDir, file), "utf8");

  await query(config, "BEGIN");
  try {
    await query(config, sql);
    await query(config, "INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    await query(config, "COMMIT");
    console.log(`applied ${file}`);
  } catch (error) {
    await query(config, "ROLLBACK");
    throw error;
  }
}

process.exit(0);
