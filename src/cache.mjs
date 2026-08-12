const cache = new Map();

export function getCache(key) {
  const item = cache.get(key);

  if (!item || item.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return item.value;
}

export function setCache(key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });

  return value;
}

export async function readThroughCache(key, ttlMs, loader) {
  const cached = getCache(key);

  if (cached !== undefined) return cached;

  return setCache(key, await loader(), ttlMs);
}
