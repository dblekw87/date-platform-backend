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

/**
 * Which venue to ask KIS about for domestic stocks.
 *
 * NXT opens its pre-market at 08:00, an hour before the KRX bell. Asking KRX
 * during that hour returns yesterday's close, so a session watched from 08:00
 * records nothing until 09:00 — which is the hour the morning is being read in.
 *
 * After the KRX close it stays on KRX rather than following NXT into the
 * after-market: leadership is judged on the regular session, and the two venues'
 * turnover must not be summed into one figure.
 */
export function krTradingVenue(now = new Date()) {
  return localParts(sessions.KR.timeZone, now).minute < sessions.KR.openMinute ? "NX" : "J";
}

export function isRegularSession(market, now = new Date()) {
  const session = sessions[market];

  if (!session) return false;

  const { minute, weekday } = localParts(session.timeZone, now);

  if (weekday === "Sat" || weekday === "Sun") return false;

  return minute >= session.openMinute && minute < session.closeMinute;
}
