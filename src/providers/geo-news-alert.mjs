import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";
import { gistOf, translateToKorean } from "./translate.mjs";

/**
 * [美 발언] 원문 출처 가운데 주제가 붙은 것만, 모아서, 한국어 요지로.
 *
 * 2026-10-24 사용자 요청으로 시작했습니다(이란·러우 전쟁·알래스카 사업). 원문 출처만
 * 보냅니다: 트럼프 Truth·백악관·연방관보·연준·한국은행, 11/01부터 연준 연설·SEC 성명과
 * 보도자료. 구글 뉴스 주제 검색은 하루 백 건이 넘어 geo_news에 쌓기만 합니다.
 *
 * **외국 정상·재무장관(11/01)** 은 언론 보도라 같은 발언이 매체마다 겹칩니다. 그래서 따로
 * 07시·18시 하루 두 번, 인물당 최신 1건만 요약으로 붙입니다.
 *
 * **한국어 요지(11/01 사용자 요청):** "완벽히가 아니라 간추려서 번역, 1~2줄 길어야 3줄".
 * 항목마다 출처·시각 한 줄, 첫 문장부터 200자 안의 요지를 번역한 한 줄, 링크 한 줄입니다
 * (외국 정상은 링크 없이 두 줄).
 * 번역은 비공식 구글 번역이라 실패하면 영문 요지로 나갑니다. 번역한 것은 gist_ko에 남겨
 * 다시 번역하지 않습니다.
 *
 * 00:00~07:00에는 보내지 않고 모아 둡니다. 트럼프 글은 한국 시각 새벽에 몰리는데,
 * 사용자는 07:00 아침 알림부터 봅니다. 07:00 첫 틱에 밤사이 것이 한 통으로 갑니다.
 */

const kind = "geo_news";
const quietStartMinute = 0;
const quietEndMinute = 7 * 60;
const lookbackHours = 12;
const maxItems = 12;
const leaderHours = [7, 18];
const officialSources = ["트럼프 Truth", "백악관", "연방관보", "연준", "한국은행", "연준 연설", "SEC 성명", "SEC 보도자료"];

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

/* Google News titles end with " - Publisher"; the publisher is noise in a two-line gist. */
function withoutPublisher(title) {
  return title.replace(/\s+-\s+[^-]{2,60}$/, "");
}

/*
 * 트럼프 Truth에는 남의 글 공유가 섞입니다(11/01 시험 발송 때 "GREGG JARRETT: 트럼프는
 * 모함당했다"가 본인 말처럼 나감). 두 꼴입니다:
 *   "RT @handle…"      재게시. @realDonaldTrump면 자기 글 재게시라 본인 말로 둡니다.
 *   "GREGG JARRETT: …"  대문자 이름 + 콜론으로 시작하는 남의 칼럼·발언 인용.
 * 공유면 라벨에 누구 것인지 붙이고 본문에서 그 머리를 뗍니다.
 *
 * 피드가 "RT @realDonaldTrumpTO THE GREAT…"처럼 핸들과 본문을 띄어쓰기 없이 붙여 주므로
 * 본인 핸들은 이름으로 먼저 봅니다. 대문자 이름은 두 낱말 이상만 칩니다 -- 트럼프 본인이
 * "IRAN: …", "BREAKING: …" 같은 대문자 머리말을 씁니다.
 */
function truthShare(title) {
  if (title.startsWith("RT @realDonaldTrump")) return { by: null, text: title.slice("RT @realDonaldTrump".length).trim() };

  const retruth = title.match(/^RT @(\w+)\s*/);

  if (retruth) return { by: `@${retruth[1]}`, text: title.slice(retruth[0].length) };

  const quoted = title.match(/^((?!BREAKING\b)[A-Z][A-Z.'-]+(?: [A-Z][A-Z.'-]+){1,3}):\s+/);

  if (quoted) {
    const name = quoted[1].trim().toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

    return { by: name, text: title.slice(quoted[0].length) };
  }

  return { by: null, text: title };
}

function speakerOf(row) {
  if (row.source !== "트럼프 Truth") return { label: row.source.replace("외국 정상 · ", ""), text: row.title };

  const share = truthShare(row.title);

  return { label: share.by ? `트럼프 Truth · 공유(${share.by})` : row.source, text: share.text };
}

async function koreanGist(config, row) {
  if (row.gist_ko) return row.gist_ko;

  const gist = gistOf(withoutPublisher(speakerOf(row).text));
  const translated = await translateToKorean(gist);

  if (!translated) return gist;

  await query(config, "UPDATE geo_news SET gist_ko = $2 WHERE key = $1", [row.key, translated]).catch(() => {});

  return translated;
}

/*
 * 외국 정상 항목은 링크를 뺍니다(11/01 사용자). 구글 뉴스 우회 주소가 서너 줄로 접혀
 * 2~3줄 규칙을 깼습니다. 요지만으로 이야기의 원천은 충분하다는 판단입니다.
 */
async function itemLines(config, row) {
  const at = row.published_at ? seoulTime(row.published_at) : "";
  const topics = row.topics.filter((topic) => topic !== "발언");
  const leader = row.source.startsWith("외국 정상 · ");

  return [
    `· ${speakerOf(row).label} ${at}${topics.length ? ` [${topics.join("/")}]` : ""}`,
    await koreanGist(config, row),
    ...(row.url && !leader ? [row.url] : [])
  ];
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
      SELECT key, source, title, url, published_at, topics, gist_ko
        FROM geo_news
       WHERE (source = ANY($2::text[]) OR source LIKE '외국 정상 · %')
         AND topics <> '{}'
         AND coalesce(published_at, fetched_at) >= now() - make_interval(hours => $1)
       ORDER BY coalesce(published_at, fetched_at)
    `, [lookbackHours, officialSources]);
    const fresh = rows.filter((row) => !sent.has(row.key));
    const official = fresh.filter((row) => officialSources.includes(row.source));
    const hour = Math.floor(minute / 60);
    const slotKey = `leaders:${day}:${hour}`;
    const leaderSlot = leaderHours.includes(hour) && !sent.has(slotKey);
    const leaders = [];

    if (leaderSlot) {
      const newestByLeader = new Map();

      for (const row of fresh.filter((item) => item.source.startsWith("외국 정상 · "))) newestByLeader.set(row.source, row);
      leaders.push(...newestByLeader.values());
    }

    if (official.length === 0 && leaders.length === 0) return 0;

    const shown = official.slice(-maxItems);
    const lines = [];

    if (shown.length) {
      lines.push(`[美 발언] ${official.length}건${official.length > shown.length ? ` · 최근 ${shown.length}건만` : ""}`, "");

      for (const row of shown) lines.push(...await itemLines(config, row), "");
    }

    if (leaders.length) {
      lines.push("[외국 정상 발언] 보도 기준 · 인물당 최신 1건", "");

      for (const row of leaders) lines.push(...await itemLines(config, row), "");
    }

    if (!await notify(config, { text: lines.join("\n").trim(), url: null })) return 0;

    // Every leader row in the window is marked, not only the one shown, so the next
    // digest does not resend the same statement from another outlet.
    const marked = leaderSlot ? fresh : official;

    for (const row of marked) {
      await markAlertSent(config, kind, day, row.key, { note: `${row.source} ${row.topics.join("/")}`.slice(0, 200) });
    }

    if (leaderSlot) await markAlertSent(config, kind, day, slotKey, { note: `외국 정상 ${leaders.length}명` });

    console.log(`알림: 美 발언 ${official.length}건 · 외국 정상 ${leaders.length}명`);

    return official.length + leaders.length;
  } catch (error) {
    console.warn("geo news alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
