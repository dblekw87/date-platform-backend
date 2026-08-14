import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Persists provider access tokens across restarts.
 *
 * KIS caps token issuance (roughly once a minute per app key) and Toss enforces
 * a request quota, so an in-memory-only cache makes every `node --watch` reload
 * burn an issuance and eventually return 403/429. Tokens outlive the process
 * here, which keeps development restarts free.
 *
 * Lives under data/, which is gitignored.
 */

const tokenDirectory = "data/.tokens";
const expirySkewMs = 60_000;

function tokenPath(name) {
  return resolve(join(tokenDirectory, `${name}.json`));
}

export async function readStoredToken(name) {
  try {
    const stored = JSON.parse(await readFile(tokenPath(name), "utf8"));

    if (typeof stored?.accessToken !== "string" || typeof stored?.expiresAt !== "number") return null;
    if (stored.expiresAt <= Date.now() + expirySkewMs) return null;

    return stored;
  } catch {
    return null;
  }
}

export async function writeStoredToken(name, token) {
  try {
    const path = tokenPath(name);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(token), "utf8");
  } catch (error) {
    // A token that cannot be cached is not fatal; the next call re-requests it.
    console.warn(`token cache write failed for ${name}`, error instanceof Error ? error.message : error);
  }
}
