/**
 * Shared money formatting for provider payloads.
 *
 * Each provider used to carry its own copy, and they disagreed: one rounded
 * 조 to a whole number while another kept a decimal, so the same screen could
 * show a stock at "5조" next to a theme total of "4.7조". One implementation
 * keeps the board internally consistent.
 *
 * Values are the day's accumulated trading value, in the smallest display unit
 * of the market's currency (원 for KR, 달러 for US).
 */

export function formatTradingAmount(value, currency = "KRW") {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) return "확인 중";

  if (currency === "USD") {
    if (numeric >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(1)}B`;
    if (numeric >= 1_000_000) return `$${Math.round(numeric / 1_000_000).toLocaleString("ko-KR")}M`;

    return `$${Math.round(numeric).toLocaleString("ko-KR")}`;
  }

  const eok = numeric / 100_000_000;

  // 1조 is 10,000억. Keeping a decimal above that matters: rounding to a whole
  // 조 turned 4.73조 into "5조" and 1.24조 into "1조".
  if (eok >= 10_000) return `${(eok / 10_000).toFixed(1)}조`;
  if (eok >= 100) return `${Math.round(eok).toLocaleString("ko-KR")}억`;

  return `${eok.toFixed(1)}억`;
}

export function formatShareVolume(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) return "거래량 확인 중";
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M주`;

  return `${Math.round(numeric).toLocaleString("ko-KR")}주`;
}
