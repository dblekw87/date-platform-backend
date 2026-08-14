import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * File-backed JSON state for providers that need to remember what they have
 * already seen, so "new since last check" survives a restart. Writes are queued
 * so concurrent savers cannot interleave and truncate the file.
 *
 * Lives under data/runtime, which is gitignored.
 */
export function createRuntimeState(name, createEmpty) {
  const filePath = resolve(join("data", "runtime", `${name}.json`));

  let memoryState;
  let writeQueue = Promise.resolve();

  async function read() {
    if (memoryState) return memoryState;

    try {
      memoryState = { ...createEmpty(), ...JSON.parse(await readFile(filePath, "utf8")) };
    } catch {
      memoryState = createEmpty();
    }

    return memoryState;
  }

  async function save(state) {
    memoryState = state;
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      })
      .catch(() => undefined);

    await writeQueue;
  }

  return { read, save };
}
