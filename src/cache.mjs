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

const inFlight = new Map();

/**
 * Cache reads also collapse concurrent misses onto one loader call. Without
 * this, every request arriving while a provider call is in progress starts its
 * own, which is how a burst of page loads turns into a rate-limit response.
 */
export async function readThroughCache(key, ttlMs, loader) {
  const cached = getCache(key);

  if (cached !== undefined) return cached;

  const pending = inFlight.get(key);

  if (pending) return pending;

  const request = (async () => {
    try {
      return setCache(key, await loader(), ttlMs);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);

  return request;
}
