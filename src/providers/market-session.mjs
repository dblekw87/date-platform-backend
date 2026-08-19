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

// NXT's pre-market ends at 08:50, ten minutes before the KRX bell, and its
// after-market opens at 15:40 and trades to 20:00.
export const krPreMarketCloseMinute = 8 * 60 + 50;
export const krAfterHoursOpenMinute = 15 * 60 + 40;
export const krAfterHoursCloseMinute = 20 * 60;

const sessions = {
  KR: { timeZone: "Asia/Seoul", openMinute: 9 * 60, closeMinute: 15 * 60 + 30 },
  US: { timeZone: "America/New_York", openMinute: 9 * 60 + 30, closeMinute: 16 * 60 }
};

/**
 * The domestic collection windows, in one place.
 *
 * Built from the same constants the collector schedules on, so a diagnostic
 * cannot describe a timetable the collector is not keeping - which is the way a
 * check earns the right to be believed.
 */
export const krCollectionWindows = [
  { closeMinute: krPreMarketCloseMinute, label: "NXT 프리마켓", openMinute: 8 * 60, source: "kis:nxt" },
  { closeMinute: krAfterHoursOpenMinute, label: "KRX 정규장", openMinute: 9 * 60, source: "kis:krx" },
  { closeMinute: krAfterHoursCloseMinute, label: "NXT 애프터마켓", openMinute: krAfterHoursOpenMinute, source: "kis:nxt:after" }
];

/** Minutes past midnight in Seoul, for comparing against those windows. */
export function seoulMinuteNow(now = new Date()) {
  return localParts(sessions.KR.timeZone, now).minute;
}

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
 * After 15:40 it goes back to NXT, because that is the only book still trading.
 * Measured on 2026-08-18 between 15:45 and 16:05: KRX repeated SK하이닉스 at
 * 1,662,000 with turnover moving twenty-one million won, while NXT went
 * 1,660,000 to 1,673,000 on a hundred and nine billion, and five of five names
 * told the same story. Asking J in the evening does not return a quiet market,
 * it returns a price that stopped existing at the close.
 *
 * This does not make the evening part of the regular session. Leadership is
 * still read from 09:00 to 15:30, and the two venues' turnover is still never
 * summed - the after-hours samples are stored under their own source and carry
 * no rank.
 */
export function krTradingVenue(now = new Date()) {
  const { minute } = localParts(sessions.KR.timeZone, now);

  if (minute < sessions.KR.openMinute) return "NX";

  // Only inside the after-hours window. Past 20:00 both books are shut and the
  // KRX close is the canonical last price, so the venue goes back to J rather
  // than serving NXT's final print all night.
  return minute >= krAfterHoursOpenMinute && minute < krAfterHoursCloseMinute ? "NX" : "J";
}

/**
 * The venue a *ranking* is asked of, which is not the venue a quote is asked of.
 *
 * A quote follows the book that is trading, so the evening asks NXT. A ranking
 * answers "what rose today", and after 15:30 the day is over — asking NXT for
 * it returns the evening's thin book instead. Measured 2026-08-19 at 17:30 with
 * both venues side by side:
 *
 *   J   한켐 29.94, 아이윈 30.00, 덱스터 29.94, 에이엔피 30.00, 화신정공 29.79
 *   NX  바이오니아 29.99, 에이프릴바이오 -14.99, 비츠로셀 13.58, 두산퓨얼셀 9.81
 *
 * Nine stocks closed limit-up that day and the board showed one of them, because
 * the other eight are not listed on NXT and vanish from its ranking entirely.
 * The J list is the same one every other broker shows for 오늘.
 *
 * So NXT ranks only the pre-market, where KRX is genuinely not trading.
 */
export function krRankingVenue(now = new Date()) {
  const { minute } = localParts(sessions.KR.timeZone, now);

  return minute < sessions.KR.openMinute ? "NX" : "J";
}

export function isRegularSession(market, now = new Date()) {
  const session = sessions[market];

  if (!session) return false;

  const { minute, weekday } = localParts(session.timeZone, now);

  if (weekday === "Sat" || weekday === "Sun") return false;

  return minute >= session.openMinute && minute < session.closeMinute;
}
