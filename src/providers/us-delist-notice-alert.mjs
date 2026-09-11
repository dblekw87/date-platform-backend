import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadNewDelistNotices } from "./us-delist-risk.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 새로 상장유지 미달 통지를 받은 미국 종목 -- 아침에 한 번.
 *
 * 통지를 받은 종목의 13.3%가 60일 안에 급등합니다(중앙값 24일, 대조군 3.0%).
 * 그래서 이것은 "오늘 급등"이 아니라 **앞으로 몇 주 지켜볼 목록**입니다. 급등하는
 * 순간은 [미국 급등]이 따로 잡고 거기에 이 표식이 붙습니다.
 *
 * 07:30~07:45 KST에 보냅니다. 미국 애프터마켓이 05:00에 끝나고 SEC 공시 파이프라인이
 * 매시 도니 그 사이에 전날 접수분이 들어와 있습니다.
 */

const alertMinute = 7 * 60 + 30;
const stopMinute = 7 * 60 + 45;

let running = false;

export async function notifyNewDelistNotices(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  running = true;

  try {
    // 하루 한 통. 끝낸 날은 저장소에 남아 창 안에서 재기동해도 또 가지 않습니다.
    if ((await loadAlertSent(config, "us_delist_notice", day)).has("done")) return 0;

    const rows = await loadNewDelistNotices(config, { sinceDays: 2, limit: 12 });

    if (!rows.length) {
      await markAlertSent(config, "us_delist_notice", day, "done", { note: "새 통지 없음" });

      return 0;
    }

    const lines = [`[미국 상폐위험] 새 상장유지 미달 통지 ${rows.length}종목 · 최근 2일 접수`, ""];

    for (const row of rows) {
      lines.push(`${row.symbol} ${row.name && row.name !== row.symbol ? row.name.slice(0, 28) : ""}`.trim()
        + ` · 접수 ${row.filed_on.slice(5).replace("-", "/")}`
        + (row.close === null ? "" : ` · $${Number(row.close).toFixed(2)}`)
        + (row.surged_already ? " · 이미 급등" : ""));
    }

    lines.push("");
    lines.push("통지 뒤 60일 안 급등 13% (대조군 3%, 중앙값 24일). 지켜볼 목록이지 매수 신호가 아닙니다.");

    if (url) lines.push(url);

    if (!await notify(config, { text: lines.join("\n"), url: null })) return 0;

    await markAlertSent(config, "us_delist_notice", day, "done", { note: rows.map((row) => row.symbol).join(", ").slice(0, 200) });
    console.log(`알림: 미국 상폐위험 ${rows.length}종목`);

    return rows.length;
  } catch (error) {
    console.warn("delist notice alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
