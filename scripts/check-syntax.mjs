import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * node --check over every module, not just the entry point.
 *
 * `node --check src/server.mjs` parses that one file and nothing it imports, so
 * a missing brace in a route sat in a commit while check reported clean. Only
 * the tests caught it, and the tests need a database.
 */

const run = promisify(execFile);
const roots = ["src", "scripts"];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".mjs")) yield path;
  }
}

const failures = [];
let checked = 0;

for (const root of roots) {
  for await (const file of walk(root)) {
    checked += 1;

    try {
      await run(process.execPath, ["--check", file]);
    } catch (error) {
      failures.push(`${file}\n${error.stderr?.trim() ?? error.message}`);
    }
  }
}

console.log(`${checked} modules checked`);

if (failures.length > 0) {
  failures.forEach((failure) => console.error(`\n${failure}`));
  process.exit(1);
}
