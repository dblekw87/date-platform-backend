import { heldMark, heldWindow } from "./alert-digest.mjs";
import { isKrMarketOpen } from "./kis.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";

/**
 * 특징주 기사를 나오는 대로.
 *
 * 다음 장 후보에서는 특징주를 **일부러 뺍니다** -- "특징주, X 테마 상승세에 6% ↑"는
 * 오른 것을 다시 쓴 기사라 복기로 분류되고, 복기는 10세션 실측에서 승률 40%로
 * 반증됐습니다([[overnight-material-verdict]]). 그 조건에 섞으면 잰 값이 망가집니다.
 *
 * 그래서 따로 흐릅니다. 여기는 **판단이 아니라 전달**입니다 -- 무엇이 지금 움직이고
 * 기사가 이유를 뭐라고 쓰는지를 보는 자리이고, 살지는 사용자가 정합니다. 그래서
 * 기록도 채점도 하지 않습니다.
 *
 * 양: 하루 70~80건, 09~10시에 45+23건이 몰립니다(2026-08-31~09-04 실측). 5분마다
 * 새 것만 한 통으로 묶으면 개장 직후 한 통에 서너 줄입니다.
 *
 * 하루 종일 돕니다. 장 밖에는 특징주가 드물어 저절로 조용하지만, 나오면 갑니다.
 */

const alertIntervalMs = 5 * 60_000;

let lastRunAt = 0;
let running = false;
/*
 * 창의 아래쪽. 처음엔 켠 시각입니다 -- 재시작할 때 그날 것을 전부 다시 보내지
 * 않게. 다만 오늘 이미 보낸 기록이 있으면 그 마지막 발송 시각부터 봅니다 -- 꺼져
 * 있던 사이에 들어온 기사를 건너뛰지 않으려고요. 같은 기사가 두 번 가는 것은
 * 보낸 키 기록(alert-sent.mjs)이 막습니다.
 */
let since = new Date();
let sinceDay = null;

export function featuredAlertDue(now = Date.now()) {
  return now - lastRunAt >= alertIntervalMs;
}

/*
 * force는 뉴스가 방금 저장됐을 때 씁니다. 타이머는 뉴스가 안 들어왔을 때를 위한
 * 뒷받침이고, 들어온 직후에는 기다릴 이유가 없습니다 -- 5분 타이머면 09:04 기사가
 * 09:09에 가는데, 그 사이에 종목은 이미 다른 값입니다.
 */
export async function notifyFeatured(config, { day, url, force = false } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (!force && !featuredAlertDue()) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const seen = await loadAlertSent(config, "featured", day);

    if (sinceDay !== day) {
      sinceDay = day;

      const lastSentAt = [...seen.values()].reduce((latest, row) => (row.sentAt > latest ? row.sentAt : latest), null);

      if (lastSentAt && lastSentAt < since) since = lastSentAt;
    }

    /*
     * 창은 **저장 시각**(observed_at)으로 자릅니다. 발행 시각이 아닙니다.
     *
     * 발행 시각으로 잘랐더니 2026-09-08에 특징주 88건 중 1건만 나갔습니다. 기사는
     * 발행되고 몇 분 뒤에 우리 DB에 들어오는데(수집 3분 주기 + 피드 지연), "지난
     * 5분에 발행된 것"을 물으면 그 사이에 이미 저장까지 된 기사가 거의 없습니다.
     * 저장 시각으로 물으면 "지난 5분에 들어온 것"이 되어 빠지는 게 없고, 같은
     * 기사가 두 번 오는 것은 seen이 막습니다.
     */
    const until = new Date();
    const { rows } = await query(config, `
      SELECT DISTINCT ON (key) key, symbol, headline, original_url, published_at,
             to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
        FROM (
          SELECT left(regexp_replace(lower(n.headline), '[^가-힣a-z0-9]', '', 'g'), 30) AS key,
                 s AS symbol, n.headline, n.original_url, n.published_at
            FROM market_news_items n, LATERAL unnest(n.related_symbols) s
           WHERE n.region = 'KR' AND n.headline LIKE '%특징주%'
             AND n.observed_at > $1 AND n.observed_at <= $2
        ) t
       ORDER BY key, published_at`,
      [since, until]);

    since = until;

    const fresh = rows.filter((row) => !seen.has(row.key));

    if (!fresh.length) return 0;

    const quotes = await latestRates(config, day, fresh.map((row) => row.symbol));
    const names = await namesOf(config, day, fresh.map((row) => row.symbol));

    /*
     * 휴장일에는 적어만 둡니다. **heldWindow보다 먼저 봐야 합니다** -- heldWindow는
     * 시계만 보므로 휴장일 10:00 기사도 보류로 들어가고, 그러면 15:20 요약이 그것을
     * 한 통으로 내보냅니다. 그래서 묶음 표시(heldMark)가 아닌 다른 표시를 씁니다.
     *
     * 2026-10-09 한글날 18:35에 "특징주 더블유씨피 2차전지 나트륨이온 테마 상승세에
     * 7.46%"가 나갔습니다. 그 7.46%는 **10/8 가격**입니다 -- 언론사가 휴장일에 올린
     * 복기 기사라, 보고도 할 수 있는 것이 없고 오늘 장이 있었던 것처럼 읽힙니다.
     *
     * 재료 쪽(material-alert.mjs)은 **일부러 휴장일에도 보냅니다** -- 정책·사건은
     * 다음 장 재료가 되고 월요일 진입을 미리 볼 수 있습니다. 여기만 막는 것은
     * 특징주가 그 반대이기 때문입니다: 위에 적은 대로 복기는 승률 40%로 반증됐고,
     * 장이 없는 날의 특징주 기사는 복기 말고는 있을 수가 없습니다.
     *
     * 기록은 남깁니다 -- 발송을 끊어도 표본은 끊지 않는다는 같은 이유이고, 적어
     * 두지 않으면 다음 틱에 같은 기사가 또 후보가 됩니다.
     */
    if (!await isKrMarketOpen(config)) {
      for (const row of fresh) {
        const name = names.get(row.symbol) ?? row.symbol;

        await markAlertSent(config, "featured", day, row.key,
          { note: `휴장:${row.at} ${name} ${row.headline.slice(0, 44)}` });
      }

      console.log(`알림: 특징주 ${fresh.length}건 휴장이라 보내지 않음`);

      return 0;
    }

    /*
     * 장중에는 보내지 않고 **적어만 둡니다.** 사용자가 장중매매를 접었으므로 이
     * 시각에 받아도 할 수 있는 것이 없고, 특징주는 하루 52통으로 가장 많이 옵니다.
     * 15:20 창에서 alert-digest.mjs가 한 통으로 묶어 보냅니다.
     *
     * 기록을 남기는 것이 중요합니다 -- 발송을 끊으면 표본이 끊깁니다. 그리고
     * 적어 두지 않으면 다음 틱에 같은 기사가 또 후보가 됩니다.
     */
    if (heldWindow()) {
      for (const row of fresh) {
        const name = names.get(row.symbol) ?? row.symbol;

        await markAlertSent(config, "featured", day, row.key,
          { note: `${heldMark}${row.at} ${name} ${row.headline.slice(0, 44)}` });
      }

      console.log(`알림: 특징주 ${fresh.length}건 보류 (15:20 요약으로)`);

      return 0;
    }

    const text = message(fresh, quotes, names, url);

    if (!await notify(config, { text })) return 0;

    for (const row of fresh) await markAlertSent(config, "featured", day, row.key, { note: row.symbol });

    console.log(`알림: 특징주 ${fresh.length}건`);

    return fresh.length;
  } catch (error) {
    console.warn("featured alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/** 지금 등락률. 기사가 말하는 숫자는 쓴 시점의 것이라 지금과 다를 수 있습니다. */
async function latestRates(config, day, symbols) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, change_rate::float8 AS rate
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND symbol = ANY($2)
     ORDER BY symbol, observed_at DESC`, [day, symbols]);

  return new Map(rows.map((row) => [row.symbol, row.rate]));
}

async function namesOf(config, day, symbols) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name FROM kr_daily_universe
     WHERE symbol = ANY($1) ORDER BY symbol, session_date DESC`, [symbols]);

  return new Map(rows.map((row) => [row.symbol, row.name]));
}

function message(rows, quotes, names, url) {
  const lines = [`[특징주] 새 기사 ${rows.length}건`, ""];

  for (const row of rows) {
    const rate = quotes.get(row.symbol);
    const now = rate === undefined ? "" : ` ${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`;

    lines.push(`${row.at} ${names.get(row.symbol) ?? row.symbol} ${row.symbol}${now}`);
    lines.push(`  ${row.headline}`);

    if (row.original_url) lines.push(`  ${row.original_url}`);
  }

  lines.push("");
  lines.push("판단이 아니라 전달입니다 — 다음 장 후보·종가배팅과 달리 재본 조건이 아닙니다.");

  if (url) lines.push(url);

  return lines.join("\n");
}
