import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";

/**
 * DART disclosures for the last week, classified by report title so the board
 * can show why a filing matters before the reader opens the original.
 */

const cacheTtlMs = 60_000;

function yyyymmdd(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
}

function classifyDisclosure(reportName) {
  if (/합병|분할|영업양수|영업양도|타법인주식및출자증권취득|타법인 주식/.test(reportName)) {
    return { urgency: "M&A", tags: ["인수합병"], action: "거래 구조와 자금 조달 방식 확인" };
  }
  if (/단일판매|공급계약|수주/.test(reportName)) {
    return { urgency: "계약", tags: ["공급계약"], action: "계약 금액, 기간, 매출 대비 비중 확인" };
  }
  if (/유상증자|전환사채|신주인수권|CB|BW/.test(reportName)) {
    return { urgency: "자금조달", tags: ["증자·지분"], action: "납입일, 할인율, 전환 조건 확인" };
  }
  if (/최대주주|대표이사|경영권/.test(reportName)) {
    return { urgency: "지배구조", tags: ["경영권"], action: "변경 전후 지분과 보호예수 확인" };
  }
  if (/잠정실적|매출액|손익구조/.test(reportName)) {
    return { urgency: "실적", tags: ["실적"], action: "일회성 여부와 전년 대비 변화 확인" };
  }

  return { urgency: "공시", tags: ["DART"], action: "공시 원문과 제출 시각 확인" };
}

function toDisclosureItem(item) {
  const classified = classifyDisclosure(item.report_nm);
  const receivedDate = item.rcept_dt;

  return {
    id: `dart-${item.rcept_no}`,
    market: "KR",
    source: "DART",
    urgency: classified.urgency,
    companyName: item.corp_name,
    symbol: item.stock_code,
    issuerType: "unknown",
    eventType: classified.urgency,
    accessionNumber: item.rcept_no,
    formType: "공시",
    title: `${item.corp_name} · ${item.report_nm}`,
    filedAt: `${receivedDate.slice(0, 4)}-${receivedDate.slice(4, 6)}-${receivedDate.slice(6, 8)}T09:00:00+09:00`,
    originalUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
    tags: classified.tags,
    action: classified.action
  };
}

export function hasDartCredentials(config) {
  return Boolean(config.dart.apiKey);
}

export async function loadDartDisclosures(config) {
  return readThroughCache("dart:disclosures", cacheTtlMs, async () => {
    const from = new Date();

    from.setDate(from.getDate() - 7);

    const url = new URL("https://opendart.fss.or.kr/api/list.json");

    url.searchParams.set("crtfc_key", config.dart.apiKey);
    url.searchParams.set("bgn_de", yyyymmdd(from));
    url.searchParams.set("page_count", "100");
    url.searchParams.set("sort", "date");
    url.searchParams.set("sort_mth", "desc");

    const response = await fetchJson(url.toString(), { timeoutMs: 6000 });

    // DART reports its own errors in the body with a 200 status.
    if (response?.status !== "000" || !Array.isArray(response.list)) {
      throw new Error(`DART ${response?.status ?? "unknown"} ${response?.message ?? ""}`.trim());
    }

    const krDisclosures = response.list
      .filter((item) => item.rcept_no && item.report_nm)
      .map(toDisclosureItem)
      .slice(0, 30);

    return krDisclosures.length > 0 ? { krDisclosures } : {};
  });
}
