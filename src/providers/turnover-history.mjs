import { createRuntimeState } from "./runtime-state.mjs";

/**
 * Tracks how a stock's accumulated turnover grows through the session.
 *
 * Every figure the providers hand back is cumulative since the open, so a stock
 * that exploded at 09:10 and went quiet looks identical to one trading steadily
 * all day. Sampling that cumulative number and differencing two samples gives
 * what is actually moving right now.
 *
 * Samples live in a file rather than the database so this works on a backend
 * running without one, matching how the "new since last check" state is kept.
 */

const sampleIntervalMs = 5 * 60 * 1000;
// Compare against a sample at least this old, so the delta covers a span worth
// reading rather than the noise between two adjacent refreshes.
const minimumWindowMs = 8 * 60 * 1000;
const maximumWindowMs = 40 * 60 * 1000;
const maximumSamples = 24;

const state = createRuntimeState("market-board-turnover-history", () => ({ markets: {} }));

function sampleOf(leaders) {
  const values = {};

  leaders.forEach((leader) => {
    const turnover = Number(leader.turnoverValue);

    if (leader.symbol && Number.isFinite(turnover) && turnover > 0) {
      values[leader.symbol] = turnover;
    }
  });

  return values;
}

/**
 * A cumulative counter only ever rises within a session, so a drop means the
 * market rolled over to a new day and the older samples describe a different
 * session.
 */
function isNewSession(previous, current) {
  const shared = Object.keys(current).filter((symbol) => previous[symbol] !== undefined);

  if (shared.length < 3) return false;

  return shared.filter((symbol) => current[symbol] < previous[symbol] * 0.9).length > shared.length / 2;
}

export async function recordTurnoverSample(market, leaders) {
  const values = sampleOf(leaders);

  if (Object.keys(values).length === 0) return;

  const current = await state.read();
  const samples = current.markets[market] ?? [];
  const latest = samples.at(-1);
  const now = Date.now();

  if (latest && isNewSession(latest.values, values)) {
    current.markets[market] = [{ observedAt: now, values }];
    await state.save(current);

    return;
  }

  // Refreshes arrive far more often than the sampling interval; only the first
  // one in each interval is kept so the window means what it says.
  if (latest && now - latest.observedAt < sampleIntervalMs) return;

  current.markets[market] = [...samples, { observedAt: now, values }].slice(-maximumSamples);
  await state.save(current);
}

/**
 * Turnover added since the most recent sample old enough to be useful.
 * Returns null until enough history exists to say anything.
 */
export async function readTurnoverBurst(market) {
  const current = await state.read();
  const samples = current.markets[market] ?? [];
  const now = Date.now();
  const baseline = [...samples]
    .reverse()
    .find((sample) => now - sample.observedAt >= minimumWindowMs && now - sample.observedAt <= maximumWindowMs);

  if (!baseline) return null;

  return {
    values: baseline.values,
    windowMinutes: Math.round((now - baseline.observedAt) / 60_000)
  };
}
