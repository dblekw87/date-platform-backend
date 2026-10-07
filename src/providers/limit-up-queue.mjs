import { isMachineHeadline, isReasonHeadline, mentionsBadNews } from "./overnight-classify.mjs";
import { query } from "../db/client.mjs";

/**
 * 상한가로 닫힌 종목을 하룻밤 들고 갈 자리인가.
 *
 * 사용자는 장중매매를 접고 종가배팅·상따만 합니다("회사를 다니다보니 장중매매는
 * 좀 힘들것 같아", 2026-10-02). 그러면 남는 판단은 하나입니다 -- **잠긴 것을
 * 들고 가서 다음 날 아침에 파는가.** 그 자리를 가르는 것을 쟀습니다.
 *
 * 두 가지가 나왔습니다. 둘 다 그날 종가에 사서 익일 시가에 판 초과수익(시장 평균
 * 갭 제거) 기준이고, 종가가 상한가인 것만 봅니다 -- 장중에 찍었다 풀린 것은
 * 다른 사건입니다.
 *
 *   **언제 잠겼나.** 일찍 잠기면 하루 종일 못 산 수요가 쌓입니다.
 *     09시대 111건 +10.74%p(92%) · 10시대 18건 +8.91%p(94%)
 *     11~12시 20건 +8.93%p(90%) · 13시 이후 43건 +6.06%p(77%)
 *
 *   **줄이 얼마나 길었나.** 마감 매수 1호가 잔량 ÷ 그날 거래량. 절대 수량으로는
 *   비교가 안 됩니다 -- 52만 주가 어디선 하루 거래량의 10%이고 어디선 두 배입니다.
 *     하위 1/3 22건 +0.91%p(55%) · 중간 22건 +4.45%p(77%) · 상위 24건 +14.60%p(92%)
 *
 * **그런데 둘은 대등하지 않습니다.** 2026-10-02 티엠씨가 10:23에 잠겼는데 잔량비는
 * 6%(하위 1/3)로 신호가 반대였습니다. 58건을 2×2로 쪼개니 순서가 보였습니다.
 *
 *     오전 잠김 · 줄 두터움   38건  +9.70%p 상회 87%
 *     오전 잠김 · 줄 얇음      9건  +2.15%p      67%
 *     오후 잠김 · 줄 두터움    7건 +11.56%p      86%
 *     오후 잠김 · 줄 얇음     13건  +0.26%p      46%   ← 유일하게 나쁜 칸
 *
 * 잔량비 하위 1/3이 나빴던 것은 **오후 잠김이 거기 몰려 있었기 때문**입니다.
 * 일찍 잠기면 줄이 얇아도 덜 나쁩니다. 그래서 잠긴 시각을 먼저 보고, 잔량은
 * 오후에 잠긴 것을 가릴 때만 씁니다. 잔량비만 보고 "하위 1/3이니 나쁘다"고
 * 읽으면 틀립니다 -- 티엠씨를 그렇게 읽어 +0.91%p/55%라고 말했고, 해당 칸은
 * +2.15%p/67%였습니다.
 *
 * **위 숫자는 2026-10-07에 전부 다시 쟀습니다.** 그 전 값(오전·얇음 +6.45%p 등)은
 * 시장 평균 갭에 `open > 0` 필터가 빠져 있었습니다 -- `open`이 0인 행이 1,590,865
 * 중 4,283개(0.27%)인데 `(0/prev-1)*100 = -100%`로 들어가 평균을 끌어내렸고,
 * 2026-08-18 이후 시장 갭이 -0.949%(오염) 대 +0.348%(정상)로 **1.3%p** 틀렸습니다.
 * 모든 칸에 같은 값이 더해졌으므로 순서는 그대로였고 절대값만 부풀려졌습니다.
 *
 * **마감 전 잔량의 방향은 신호가 아닙니다.** 줄어듦 16건 +7.29%p(63%),
 * 비슷 31건 +9.65%p(90%), 늘어남 11건 +6.33%p(55%)로 단조롭지 않습니다.
 * '잔량 이탈' 계열은 이것으로 두 번째 탈락이니 다시 제안하지 않습니다 --
 * 잔량은 **크기**만 값이 있고 **변화**는 없습니다.
 *
 * 표본은 호가 수집이 2026-09-15부터라 13거래일 58건입니다. 칸당 4~34건이라
 * **가름으로만 쓰고 문턱으로 박지 않습니다.** 숫자는 사람이 보게 같이 돌려줍니다.
 */
const limitUpFloor = 29.0;
/* 잔량비 하위 1/3과 중간의 경계. 58건 기준 7%입니다. */
const thinRatio = 0.07;
/* 오전/오후를 가르는 시각. 09·10시대가 92~94%로 붙어 있어 11시에서 끊습니다. */
const morningHour = 11;

const cells = {
  "오전·두터움": { note: "38건 초과 +9.70%p · 상회 87%", rank: "좋음" },
  "오전·얇음": { note: "9건 초과 +2.15%p · 상회 67%", rank: "보통" },
  "오후·두터움": { note: "7건 초과 +11.56%p · 상회 86%", rank: "좋음" },
  "오후·얇음": { note: "13건 초과 +0.26%p · 상회 46%", rank: "나쁨" }
};

/**
 * 그날 상한가로 닫힌 종목의 잠긴 시각과 마감 잔량비. 닫힘이 아니면 null입니다.
 *
 * 잠긴 시각은 순위권 표본에서만 보이므로 **실제보다 늦게 보일 수 있습니다** --
 * 윈팩은 09:02:54 첫 표본이 이미 +29.98%였습니다. 그 오차는 이른 것을 늦은 칸으로
 * 밀기만 하므로, 오전으로 분류된 것은 확실히 오전입니다.
 */
export async function readLockQueue(config, symbol, day) {
  if (!config.databaseUrl) return null;

  const { rows: bars } = await query(config, `
    WITH b AS (
      SELECT session_date, close, volume,
             lag(close) OVER (ORDER BY session_date) AS prev
        FROM kr_daily_bars WHERE symbol = $1
    )
    SELECT volume::float8 AS volume, ((close / prev - 1) * 100)::float8 AS rate
      FROM b WHERE session_date = $2::date AND prev > 0`, [symbol, day]);
  const volume = Number(bars[0]?.volume ?? 0);
  const rate = Number(bars[0]?.rate ?? 0);

  /*
   * 일봉이 아직 없는 그날 저녁에도 답해야 합니다. 분 표본의 마지막 등락률과
   * 누적 거래량으로 대신합니다 -- 15:30 뒤의 KRX 표본은 종가에 멈춰 있습니다.
   */
  if (!(volume > 0)) {
    const { rows: live } = await query(config, `
      SELECT DISTINCT ON (symbol) change_rate::float8 AS rate, volume::float8 AS volume
        FROM market_price_samples
       WHERE market = 'KR' AND symbol = $1 AND session_date = $2::date
         AND source LIKE 'kis:krx%'
       ORDER BY symbol, observed_at DESC`, [symbol, day]);

    if (!live.length || Number(live[0].rate) < limitUpFloor || !(Number(live[0].volume) > 0)) return null;

    return describe(config, symbol, day, Number(live[0].volume));
  }

  if (rate < limitUpFloor) return null;

  return describe(config, symbol, day, volume);
}

/** 잠긴 시각과 잔량을 읽어 칸을 정합니다. */
async function describe(config, symbol, day, volume) {
  const { rows: book } = await query(config, `
    SELECT bid_qty1::float8 AS queue,
           to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
      FROM kr_order_book_samples
     WHERE symbol = $1 AND session_date = $2::date
     ORDER BY observed_at DESC LIMIT 1`, [symbol, day]);
  const { rows: hit } = await query(config, `
    SELECT to_char(min(observed_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
      FROM market_price_samples
     WHERE symbol = $1 AND session_date = $2::date AND change_rate >= $3`,
    [symbol, day, limitUpFloor]);
  /*
   * 잔량이 상장주식수를 넘으면 그 잔량은 못 믿습니다.
   *
   * 앤씨앤 09-17·09-18이 그랬습니다 -- 마감 잔량 787만·938만 주인데 환산
   * 상장주식수가 503만·501만이고, 그날 거래량은 5만 주(주식수의 1%)뿐입니다.
   * 잔량비가 15657%·17647%로 나와 상위 1/3의 맨 위에 앉았습니다.
   *
   * 매수 주문은 주식을 들고 있지 않아도 낼 수 있으니 이론상 주식수를 넘을 수는
   * 있습니다. 다만 거래가 1%만 되고 잔량이 전부를 넘는 모양은 실제 수요라기보다
   * 수집 쪽 문제로 보입니다. 쟤서 확인했습니다 -- 그 둘을 빼도 사다리는
   * 그대로입니다(하위 +1.32%p/50% · 중간 +7.01/83% · 상위 +13.61/90%). 그래서
   * **판정만 비우고 숫자는 보여줍니다.** 사람이 보면 이상한 것을 알아봅니다.
   *
   * 국내엔 상장주식수 컬럼이 없어 `market_cap / 종가`로 환산합니다. 환산값이
   * 없으면(시총·종가가 없는 날) 이 가드는 걸지 않습니다 -- 모르는 것을 틀렸다고
   * 할 수는 없습니다.
   */
  const { rows: listed } = await query(config, `
    SELECT (market_cap / nullif(close_price, 0))::float8 AS shares
      FROM kr_daily_universe WHERE symbol = $1 AND session_date = $2::date`, [symbol, day]);
  const shares = Number(listed[0]?.shares ?? 0);
  const lockedAt = hit[0]?.at ?? null;
  const queue = Number(book[0]?.queue ?? 0);
  const overShares = shares > 0 && queue > shares;

  /*
   * 둘 중 하나가 없으면 칸을 말하지 않습니다. 호가는 문턱(24%) 위에 있던 종목만
   * 찍히고 잠긴 시각은 순위권 표본에만 있어, 둘 다 비는 경우가 있습니다. 모르는
   * 것을 '보통'으로 적으면 모른다는 사실이 사라집니다.
   */
  if (!lockedAt && !(queue > 0)) return null;

  const morning = lockedAt ? Number(lockedAt.slice(0, 2)) < morningHour : null;
  const ratio = queue > 0 ? queue / volume : null;
  const thin = ratio === null || overShares ? null : ratio <= thinRatio;
  const key = morning === null || thin === null ? null : `${morning ? "오전" : "오후"}·${thin ? "얇음" : "두터움"}`;

  return {
    cell: key,
    lockedAt,
    morning,
    note: key ? cells[key].note : null,
    observedAt: book[0]?.at ?? null,
    overShares,
    queue: queue > 0 ? queue : null,
    rank: key ? cells[key].rank : null,
    ratio,
    shares: shares > 0 ? shares : null,
    thin,
    volume
  };
}

/** 사람이 읽을 한 줄. 모르는 부분은 비워 둡니다. */
export function describeLockQueue(read) {
  if (!read) return null;

  const parts = [];

  if (read.lockedAt) parts.push(`${read.lockedAt} 잠김(${read.morning ? "오전" : "오후"})`);
  if (read.ratio !== null) {
    parts.push(`마감 잔량 ${read.queue.toLocaleString("ko-KR")}주 · 거래량 대비 ${(100 * read.ratio).toFixed(0)}%`
      + (read.overShares ? "(못 믿음)" : `(${read.thin ? "얇음" : "두터움"})`));
  }

  /* 왜 칸이 없는지 적습니다. 비워 두면 "판정이 없다"와 "판정이 보통"이 섞입니다. */
  if (read.overShares) {
    return `${parts.join(" · ")}\n    → 잔량이 상장주식수(${Math.round(read.shares).toLocaleString("ko-KR")}주)를 넘어 잔량 판정은 비웁니다`;
  }

  if (!read.cell) return parts.join(" · ") || null;

  return `${parts.join(" · ")}\n    → ${read.cell} ${read.rank} · 실측 ${read.note}`;
}

/**
 * 밤에 **새** 재료가 붙었는가.
 *
 * 2026-10-05 18:15 "속도 내는 티엠씨 美 사업…텍사스 공장 이미 풀가동"이 떴는데
 * 주말 브리핑이 안 잡았습니다. `blockReason`이 "복기 기사 8건"으로 막았습니다 --
 * 금요일 상한가 복기 기사가 여덟 건 붙어 있었기 때문입니다.
 *
 * **그 규칙은 그대로 둡니다.** 근거가 되는 측정(복기 -0.69%p·승률 40%)은
 * **장중(시가→종가)** 초과수익이고, 그 트레이드에서는 맞는 말입니다.
 *
 * 그런데 사용자가 하는 트레이드는 그것이 아닙니다 -- 종가에 사서 **다음 날
 * 시가에** 팝니다. 그 자리로 다시 재니 방향이 반대입니다. 그날 +10% 이상 오른
 * 종목 안에서, 밤 창(15:40~익일 08:00)에 isReasonHeadline을 통과하고 기계기사·
 * 악재가 아닌 기사가 붙었는가로 갈랐습니다.
 *
 *   상한가 · 재료 있음     79건  익일 시가 초과  +8.96%p  중앙 7.01  상회 78%
 *   상한가 · 없음         199건                 +6.00%p  중앙 3.47       73%
 *   10~29% · 재료 있음   199건                 +0.34%p  중앙 -0.42      43%
 *   10~29% · 없음       1155건                 -0.48%p  중앙 -0.65      37%
 *
 * 상한가를 통제해도 +2.96%p 남고 중앙값도 7.01 대 3.47로 같이 움직입니다
 * (몇 건이 끌어올린 것이 아님). 상회율도 78% 대 73%로 재료 쪽이 낫습니다.
 * 10~29% 칸은 둘 다 상회 40%대라 재료가 있어도 사는 자리가 아닙니다.
 *
 * 두 측정이 모순이 아닙니다. 갭은 개장 전에 생기고 장중에 녹습니다. 그래서 이것은
 * **파는 쪽에만** 붙입니다(morning-feedback의 "오늘 09:05~09:10 청산" 토막).
 * 사는 자리를 고르는 데 쓰면 서로 다른 트레이드의 숫자를 섞는 일이 됩니다.
 */
const loudRate = 10.0;

const materialCells = {
  "10~29%·없음": "1155건 -0.48%p · 상회 37%",
  "10~29%·있음": "199건 +0.34%p · 상회 43%",
  "상한가·없음": "199건 +6.00%p · 상회 73%",
  "상한가·있음": "79건 +8.96%p · 상회 78%"
};

/**
 * 그날 많이 오른 종목에 밤 새 재료가 붙었는지. 많이 오르지 않았으면 null입니다.
 *
 * 창의 끝은 **지금**입니다. 측정은 익일 08:00까지 봤지만 이 함수는 07:00에
 * 불리므로, 그 사이에 올 기사는 아직 없습니다. 더 좁은 창이라 과장되지 않습니다.
 */
export async function readOvernightMaterial(config, symbol, day, now = new Date()) {
  if (!config.databaseUrl) return null;

  const { rows: bars } = await query(config, `
    WITH b AS (
      SELECT session_date, close,
             lag(close) OVER (ORDER BY session_date) AS prev
        FROM kr_daily_bars WHERE symbol = $1
    )
    SELECT ((close / prev - 1) * 100)::float8 AS rate
      FROM b WHERE session_date = $2::date AND prev > 0`, [symbol, day]);
  const rate = Number(bars[0]?.rate ?? 0);

  if (!(rate >= loudRate)) return null;

  const { rows: news } = await query(config, `
    SELECT DISTINCT ON (left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30))
           to_char(published_at AT TIME ZONE 'Asia/Seoul', 'DD HH24:MI') AS at, headline, original_url
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND s = $1
       AND published_at >= ($2::date + time '15:40') AT TIME ZONE 'Asia/Seoul'
       AND published_at < $3
     ORDER BY left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30), published_at`,
    [symbol, day, now]);
  const fresh = news.filter((row) => isReasonHeadline(row.headline)
    && !isMachineHeadline(row.headline) && !mentionsBadNews(row.headline));
  const key = `${rate >= limitUpFloor ? "상한가" : "10~29%"}·${fresh.length ? "있음" : "없음"}`;

  return { cell: key, fresh: fresh.slice(0, 2), limitUp: rate >= limitUpFloor, note: materialCells[key], rate };
}

/** 파는 쪽에 붙일 줄들. 아무것도 읽히지 않으면 빈 배열입니다. */
export function describeHold(lockQueue, material) {
  const lines = [];
  const queue = describeLockQueue(lockQueue);

  if (queue) for (const line of queue.split("\n")) lines.push(line.trim());

  if (!material) return lines;

  lines.push(material.fresh.length
    ? `밤 새 재료 ${material.fresh.length}건 · ${material.cell} ${material.note}`
    : `밤 새 재료 없음 · ${material.cell} ${material.note}`);

  for (const row of material.fresh) lines.push(`· ${row.at} ${row.headline.slice(0, 52)}`);

  return lines;
}
