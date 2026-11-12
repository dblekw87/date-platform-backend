import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 단일판매·공급계약 공시를 한 건씩 바로 보냅니다.
 *
 * 2026-11-12 사용자: 다른 서비스(awakeplus)가 보내는 공급계약 카드를 붙여 넣고
 * "이런식으로는 텔레그램으로 전달 못해주나?" -- 같은 날 AP위성이 09:12 공급계약 뒤
 * 13:18에 +22%를 갔습니다. 이전에는 공시가 재료 알림·상한가 근거 안에 섞여만 있었고
 * 계약상대·금액·매출대비를 따로 보여준 적이 없습니다.
 *
 * 범위는 사용자가 정했습니다: **전부**(매출대비 문턱 없음), **[기재정정]도 보냄**.
 * 해지 공시도 같은 제목 줄이라 함께 갑니다 -- 악재라 앞에 표시합니다.
 * 최근 2주 기준 정정 포함 하루 10~20건입니다.
 *
 * 값은 측정하지 않았습니다. 이 알림은 판단이 아니라 원문 요약입니다.
 *
 * 공시 목록은 수집기가 5분마다 DART 당일공시에서 받아 market_disclosures에 넣고,
 * 이 모듈은 그 뒤에 불립니다. 원문 표는 DART 뷰어(EUC-KR)에서 직접 읽습니다.
 * 원문을 못 읽어도 제목·링크만으로 보냅니다 -- 알림이 늦는 것보다 낫습니다.
 */

const kind = "contract";
/* 저녁 전체 훑기가 낮에 놓친 것을 찾아도 몇 시간 지난 공시는 보내지 않습니다. */
const staleMs = 3 * 60 * 60_000;
const titlePattern = "%단일판매%공급계약%";

let running = false;

/** 표의 칸 텍스트를 순서대로. */
export function dartCells(html) {
  return [...html.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => match[1]
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim());
}

/* "3. 계약상대방", "- 체결계약명", "매출액 대비(%)" → 비교용 이름. */
function labelKey(cell) {
  return cell.replace(/^[\d.\s-]+/, "").replace(/[\s·ㆍ]/g, "");
}

function valueAfter(cells, labels, from = 0) {
  const keys = labels.map(labelKey);

  for (let index = from; index < cells.length - 1; index += 1) {
    if (keys.includes(labelKey(cells[index]))) return { index, value: cells[index + 1] };
  }

  return null;
}

/**
 * 원문 칸에서 카드에 쓸 값을 뽑습니다. 양식이 셋입니다 -- 본 공시, 자회사의 주요경영사항,
 * 해지. 정정 공시는 맨 앞에 정정 표가 붙고 그 뒤에 고친 본문 전체가 옵니다.
 */
export function parseContract(cells) {
  const result = {};
  let bodyStart = 0;

  const reason = valueAfter(cells, ["정정사유"]);

  if (reason) {
    result.correctionReason = reason.value;

    const head = cells.indexOf("정정후");
    const changes = [];
    let index = head + 1;

    // 정정 표는 항목·정정전·정정후 세 칸씩입니다. 항목 칸이 "2. 계약내역 - ..." 꼴이
    // 아니면 표가 끝난 것입니다.
    while (head >= 0 && index + 2 < cells.length && /^\d+\s*\./.test(cells[index])) {
      changes.push({ after: cells[index + 2], before: cells[index + 1], item: cells[index] });
      index += 3;
    }

    result.changes = changes;
    bodyStart = Math.max(index, 0);
  }

  const pick = (labels) => valueAfter(cells, labels, bodyStart)?.value ?? null;

  result.content = pick(["판매ㆍ공급계약 내용", "체결계약명", "판매ㆍ공급계약 해지내용"]);
  result.amount = pick(["계약금액 총액(원)", "계약금액(원)", "해지금액(원)"]);
  result.salesRatio = pick(["매출액 대비(%)", "매출액대비(%)"]);
  result.counterparty = pick(["계약상대방", "계약상대"]);
  result.region = pick(["판매ㆍ공급지역"]);
  result.termination = pick(["주요 해지사유"]);

  const term = valueAfter(cells, ["계약기간"], bodyStart);

  if (term) {
    result.start = valueAfter(cells, ["시작일"], term.index)?.value ?? null;
    result.end = valueAfter(cells, ["종료일"], term.index)?.value ?? null;
  }

  return result;
}

async function fetchDartCells(url) {
  const main = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((response) => response.text());
  const ids = main.match(/viewDoc\("(\d+)",\s*"(\d+)"/);

  if (!ids) return null;

  const viewer = `https://dart.fss.or.kr/report/viewer.do?rcpNo=${ids[1]}&dcmNo=${ids[2]}&eleId=0&offset=0&length=0&dtd=HTML`;
  const buffer = await fetch(viewer, { signal: AbortSignal.timeout(10_000) }).then((response) => response.arrayBuffer());

  return dartCells(new TextDecoder("euc-kr").decode(buffer));
}

/* 네이버 실시간. 정규장 밖에는 NXT 값이 오고, 시총은 원 단위입니다. */
async function fetchQuote(symbol) {
  try {
    const body = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${symbol}`, { signal: AbortSignal.timeout(5_000) })
      .then((response) => response.json());
    const data = body?.datas?.[0];

    if (!data) return null;

    return {
      marketCap: Number(data.marketValueFullRaw) || null,
      rate: data.fluctuationsRatioRaw != null ? Number(data.fluctuationsRatioRaw) : null
    };
  } catch {
    return null;
  }
}

function won(value) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const eok = value / 1e8;

  if (eok >= 10_000) return `${(eok / 10_000).toFixed(eok >= 100_000 ? 0 : 1)}조`;

  return `${eok >= 10 ? Math.round(eok).toLocaleString("en-US") : eok.toFixed(1)}억`;
}

function duration(start, end) {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);

  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return null;

  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();

  if (months < 1) return `${Math.round((b - a) / 86_400_000)}일`;

  const years = Math.floor(months / 12);
  const rest = months % 12;

  return [years ? `${years}년` : "", rest ? `${rest}개월` : ""].filter(Boolean).join(" ");
}

export function contractMessage({ filedAt, name, quote, symbol, title }, parsed) {
  const cancel = /해지/.test(title);
  const correction = /정정/.test(title);
  const tag = cancel ? "[공급계약 해지]" : correction ? "[공급계약 정정]" : "[공급계약]";
  const amount = parsed?.amount ? Number(parsed.amount.replace(/[^\d]/g, "")) : null;
  const cap = quote?.marketCap ?? null;
  const head = [`${tag} ${name} ${symbol}`];

  if (cap) head.push(`시총 ${won(cap)}`);
  if (quote?.rate != null && Number.isFinite(quote.rate)) head.push(`지금 ${quote.rate > 0 ? "+" : ""}${quote.rate.toFixed(2)}%`);

  const report = title.replace(/^.*?·\s*/, "");
  const lines = [head.join(" · "), `${filedAt} ${report}`, ""];

  if (parsed) {
    const amountText = won(amount);
    const capShare = amount && cap ? ` (시총의 ${(amount / cap * 100).toFixed(1)}%)` : "";
    const period = parsed.start && parsed.end
      ? `${parsed.start} ~ ${parsed.end}${duration(parsed.start, parsed.end) ? ` (${duration(parsed.start, parsed.end)})` : ""}`
      : null;

    const fields = [
      ["계약상대", parsed.counterparty],
      ["계약내용", parsed.content],
      ["공급지역", parsed.region],
      [cancel ? "해지금액" : "계약금액", amountText ? `${amountText}${capShare}` : null],
      ["계약기간", period],
      ["매출대비", parsed.salesRatio && parsed.salesRatio !== "-" ? `${parsed.salesRatio}%` : null],
      ["해지사유", parsed.termination]
    ];

    for (const [label, value] of fields) {
      if (value && value !== "-") lines.push(`${label} : ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`);
    }

    if (parsed.correctionReason) {
      lines.push("");
      lines.push(`정정사유 : ${parsed.correctionReason}`);

      for (const change of (parsed.changes ?? []).slice(0, 3)) {
        const item = change.item.replace(/^\d+\s*\.\s*/, "");

        lines.push(`  ${item.length > 40 ? `${item.slice(0, 40)}…` : item}: ${change.before} → ${change.after}`);
      }
    }
  } else {
    lines.push("(원문 표를 읽지 못했습니다 — 링크로 확인)");
  }

  return lines.join("\n");
}

/* 오늘 접수된 공급계약 중 아직 안 보낸 것. 키는 접수번호입니다. */
async function loadPending(config, day) {
  const { rows } = await query(config, `
    SELECT symbol, company_name, title, original_url, filed_at
      FROM market_disclosures
     WHERE title LIKE $2
       AND filed_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Seoul'
       AND filed_at > now() - make_interval(secs => $3)
       AND symbol IS NOT NULL
     ORDER BY filed_at`, [day, titlePattern, staleMs / 1000]);

  return rows
    .map((row) => ({ ...row, rcpNo: row.original_url?.match(/rcpNo=(\d+)/)?.[1] ?? null }))
    .filter((row) => row.rcpNo);
}

export async function notifyContracts(config) {
  if (running || !notifyConfigured(config)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    const sent = await loadAlertSent(config, kind, day);
    const pending = (await loadPending(config, day)).filter((row) => !sent.has(row.rcpNo));
    let count = 0;

    for (const row of pending) {
      let parsed = null;

      try {
        const cells = await fetchDartCells(row.original_url);

        parsed = cells?.length ? parseContract(cells) : null;
      } catch (error) {
        console.warn(`contract alert: ${row.rcpNo} 원문 실패`, error instanceof Error ? error.message : error);
      }

      const filedAt = new Date(row.filed_at).toLocaleTimeString("ko-KR", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul" });
      const quote = await fetchQuote(row.symbol);
      const text = contractMessage({ filedAt, name: row.company_name, quote, symbol: row.symbol, title: row.title }, parsed);
      const ok = await notify(config, { text, url: row.original_url });

      if (!ok) continue;

      await markAlertSent(config, kind, day, row.rcpNo, { note: `${row.company_name} ${row.title}`.slice(0, 200) });
      console.log(`알림: 공급계약 · ${row.company_name} ${row.rcpNo}`);
      count += 1;
    }

    return count;
  } catch (error) {
    console.warn("contract alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
