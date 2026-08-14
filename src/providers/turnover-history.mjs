import { isRegularSession, minutesSinceOpen, sessionDate } from "./market-session.mjs";
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

/**
 * The opening 90 minutes are where leadership is decided and where turnover
 * concentrates, so samples are taken more often and a shorter span is enough to
 * read. Waiting eight minutes for a first answer would miss the window that
 * matters most; at two-minute samples a reading is available from about 09:03.
 */
const openingWindowMinutes = 90;
const opening = { sampleIntervalMs: 2 * 60 * 1000, minimumWindowMs: 3 * 60 * 1000 };
const steady = { sampleIntervalMs: 5 * 60 * 1000, minimumWindowMs: 8 * 60 * 1000 };

const maximumWindowMs = 40 * 60 * 1000;
// Two minutes apart across a full session, with room to spare.
const maximumSamples = 60;

function cadence(market) {
  const elapsed = minutesSinceOpen(market);

  return elapsed !== null && elapsed < openingWindowMinutes ? opening : steady;
}

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

export async function recordTurnoverSample(market, leaders) {
  // Only the regular session is sampled: outside it the cumulative figure either
  // sits still or inches up on thin 시간외 trading, and neither says anything
  // about leadership.
  if (!isRegularSession(market)) return;

  const values = sampleOf(leaders);

  if (Object.keys(values).length === 0) return;

  const today = sessionDate(market);
  const current = await state.read();
  // Samples from an earlier trading day describe a different cumulative run.
  const samples = (current.markets[market] ?? []).filter((sample) => sample.sessionDate === today);
  const latest = samples.at(-1);
  const now = Date.now();

  // Refreshes arrive far more often than the sampling interval; only the first
  // one in each interval is kept so the window means what it says.
  if (latest && now - latest.observedAt < cadence(market).sampleIntervalMs) {
    if (samples.length !== (current.markets[market] ?? []).length) {
      current.markets[market] = samples;
      await state.save(current);
    }

    return;
  }

  current.markets[market] = [...samples, { observedAt: now, sessionDate: today, values }].slice(-maximumSamples);
  await state.save(current);
}

/**
 * Turnover added since the most recent sample old enough to be useful.
 * Returns null until enough history exists to say anything.
 */
export async function readTurnoverBurst(market) {
  if (!isRegularSession(market)) return null;

  const today = sessionDate(market);
  const current = await state.read();
  const samples = (current.markets[market] ?? []).filter((sample) => sample.sessionDate === today);
  const now = Date.now();
  const { minimumWindowMs } = cadence(market);
  const baseline = [...samples]
    .reverse()
    .find((sample) => now - sample.observedAt >= minimumWindowMs && now - sample.observedAt <= maximumWindowMs);

  if (!baseline) return null;

  return {
    values: baseline.values,
    windowMinutes: Math.round((now - baseline.observedAt) / 60_000)
  };
}
