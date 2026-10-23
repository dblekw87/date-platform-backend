import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * [美 발언] 트럼프·백악관·연방관보 가운데 주제가 붙은 것만, 모아서.
 *
 * 2026-10-24 사용자 요청입니다(이란·러우 전쟁·알래스카 사업). 원문 출처 셋만
 * 보냅니다. 구글 뉴스 주제 검색은 하루 백 건이 넘어 geo_news에 쌓기만 합니다.
 *
 * 00:00~07:00에는 보내지 않고 모아 둡니다. 트럼프 글은 한국 시각 새벽에 몰리는데,
 * 사용자는 07:00 아침 알림부터 봅니다. 07:00 첫 틱에 밤사이 것이 한 통으로 갑니다.
 *
 * 번역은 없습니다. 쓰던 파파고 API가 2026-10-24 기준 404(서비스 종료)라 원문에
 * 주제 낱말만 한글로 붙입니다.
 */

const kind = "geo_news";
const quietStartMinute = 0;
const quietEndMinute = 7 * 60;
const lookbackHours = 12;
const maxItems = 12;

let running = false;

function seoulMinute(now) {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: "Asia/Seoul" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);

  return hour * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

function seoulTime(date) {
  return new Intl.DateTimeFormat("ko-KR", { day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "numeric", timeZone: "Asia/Seoul" }).format(date);
}

function previousDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

export async function notifyGeoNews(config, { now = new Date() } = {}) {
  if (running || !notifyConfigured(config)) return 0;

  const minute = seoulMinute(now);

  if (minute >= quietStartMinute && minute < quietEndMinute) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    // 07:00 묶음은 어제 저녁 것과 겹치므로 이틀치를 같이 봅니다.
    const sent = new Set([
      ...(await loadAlertSent(config, kind, day)).keys(),
      ...(await loadAlertSent(config, kind, previousDay(day))).keys()
    ]);
    const { rows } = await query(config, `
      SELECT key, source, title, url, published_at, topics
        FROM geo_news
       WHERE source IN ('트럼프 Truth', '백악관', '연방관보')
         AND topics <> '{}'
         AND coalesce(published_at, fetched_at) >= now() - make_interval(hours => $1)
       ORDER BY coalesce(published_at, fetched_at)
    `, [lookbackHours]);
    const fresh = rows.filter((row) => !sent.has(row.key));

    if (fresh.length === 0) return 0;

    const shown = fresh.slice(-maxItems);
    const lines = [`[美 발언] ${fresh.length}건${fresh.length > shown.length ? ` · 최근 ${shown.length}건만` : ""}`, ""];

    for (const row of shown) {
      const at = row.published_at ? seoulTime(row.published_at) : "";

      lines.push(`· ${row.source} ${at} [${row.topics.join("/")}]`);
      lines.push(row.title.length > 280 ? `${row.title.slice(0, 277)}...` : row.title);
      if (row.url) lines.push(row.url);
      lines.push("");
    }

    if (!await notify(config, { text: lines.join("\n").trim(), url: null })) return 0;

    for (const row of fresh) {
      await markAlertSent(config, kind, day, row.key, { note: `${row.source} ${row.topics.join("/")}`.slice(0, 200) });
    }

    console.log(`알림: 美 발언 ${fresh.length}건`);

    return fresh.length;
  } catch (error) {
    console.warn("geo news alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
