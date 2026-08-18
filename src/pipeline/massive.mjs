/**
 * Shared access to Massive, paced for the plan.
 *
 * Every caller here competes for the same per-minute allowance, so the spacing
 * lives in one module rather than in each script. A free key allows five a
 * minute, which is why the backfills are measured in hours and the nightly run
 * only ever asks for one day.
 */

let lastRequestAt = 0;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function massiveRequest(config, path, attempt = 1) {
  const intervalMs = Math.ceil(60_000 / Math.max(config.massive.requestsPerMinute, 1));
  const waitMs = lastRequestAt + intervalMs - Date.now();

  if (waitMs > 0) await sleep(waitMs);

  lastRequestAt = Date.now();

  let response;

  try {
    response = await fetch(`${config.massive.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.massive.apiKey}` }
    });
  } catch (error) {
    // A dropped connection is not an answer about this request, and one of them
    // used to end the whole nightly run: the laptop's wifi blinked partway
    // through a two hundred and fifty symbol refresh and the pipeline reported
    // only "fetch failed". Runs here are long enough that a transient failure
    // somewhere in them is close to certain.
    if (attempt > 5) throw error;

    await sleep(attempt * 10_000);

    return massiveRequest(config, path, attempt + 1);
  }

  // A 429 means the configured pace is wrong for this plan rather than that the
  // request was bad, so it backs off and keeps going instead of failing the run.
  if (response.status === 429 && attempt <= 5) {
    await sleep(60_000);

    return massiveRequest(config, path, attempt + 1);
  }

  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText} for ${path}`);

    error.status = response.status;

    throw error;
  }

  return response.json();
}
