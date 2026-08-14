/**
 * Regular trading hours per market.
 *
 * Leadership is read from the regular session only. After the close a stock's
 * cumulative turnover still creeps up on 시간외 trading, which is thin enough
 * that a few hundred million won looks like a burst against a quiet tape — a
 * signal about nothing. Overnight and weekends the figure does not move at all,
 * so any difference is noise from a provider revising its numbers.
 *
 * Holidays are not modelled: the exchange is closed, turnover does not change,
 * and a zero difference reports nothing either way.
 */

const sessions = {
  KR: { timeZone: "Asia/Seoul", openMinute: 9 * 60, closeMinute: 15 * 60 + 30 },
  US: { timeZone: "America/New_York", openMinute: 9 * 60 + 30, closeMinute: 16 * 60 }
};

function localParts(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  // Midnight can format as 24 rather than 00 in some environments.
  const hour = Number(value("hour")) % 24;

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minute: hour * 60 + Number(value("minute")),
    weekday: value("weekday")
  };
}

/** A stable label for the trading day, so samples from another day are dropped. */
export function sessionDate(market, now = new Date()) {
  const session = sessions[market];

  if (!session) return "";

  return localParts(session.timeZone, now).date;
}

/** Minutes since the opening bell, or null outside the regular session. */
export function minutesSinceOpen(market, now = new Date()) {
  const session = sessions[market];

  if (!session || !isRegularSession(market, now)) return null;

  return localParts(session.timeZone, now).minute - session.openMinute;
}

export function isRegularSession(market, now = new Date()) {
  const session = sessions[market];

  if (!session) return false;

  const { minute, weekday } = localParts(session.timeZone, now);

  if (weekday === "Sat" || weekday === "Sun") return false;

  return minute >= session.openMinute && minute < session.closeMinute;
}
