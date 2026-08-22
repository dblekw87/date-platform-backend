import { readThroughCache } from "../cache.mjs";
import { fetchJson } from "../http.mjs";
import { resolveCorpCodes } from "./industry.mjs";

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

/**
 * What a filing is about, in the words a reader would sort them by.
 *
 * Five rules answered 공시 for 86% of a day's 780 filings, which is the board's
 * filter chips showing an empty box whichever one you press. The rules below
 * were written against those 200 distinct report names rather than from memory,
 * so the buckets are the ones DART actually fills.
 *
 * Order matters: 자기주식취득 is a 주주환원 and not 자금조달 even though it moves
 * money, and 조회공시요구 is 해명 and not 지배구조 even when it asks about the
 * largest shareholder. The specific test always comes first.
 *
 * The tag is the contract with the screen — the chips are built from whatever
 * tags the day's filings carry, so a bucket added here appears there with no
 * further work, and a bucket nobody filed into never renders an empty list.
 */
export function classifyDisclosure(reportName) {
  // Housekeeping, and the largest group by far: shelf prospectuses, ELS
  // takedowns, fund effectiveness notices, group-structure returns. Filed
  // constantly, about the paperwork rather than the company.
  if (/일괄신고|효력발생안내|대규모기업집단현황|기업설명회|주주총회소집|주주명부폐쇄|의결권대리행사|증권발행실적|지급수단별|기업지배구조보고서|거래계획(보고서|철회)/.test(reportName)) {
    return { action: "정기·안내 공시입니다", tags: ["정기·안내"], urgency: "안내" };
  }
  if (/반기보고서|분기보고서|사업보고서|감사보고서|결산/.test(reportName)) {
    return { action: "재무제표와 주석 확인", tags: ["정기·안내"], urgency: "정기보고" };
  }
  if (/매매거래정지|상장폐지|관리종목|정리매매|소송등의판결|불성실공시/.test(reportName)) {
    return { action: "사유와 해제 조건 확인", tags: ["주의"], urgency: "주의" };
  }
  if (/풍문또는보도|조회공시요구/.test(reportName)) {
    return { action: "회사가 무엇을 확인하고 무엇을 부인했는지 확인", tags: ["해명"], urgency: "해명" };
  }
  if (/자기주식|주식소각|현금ㆍ현물배당|배당결정/.test(reportName)) {
    return { action: "규모와 소각 여부, 기간 확인", tags: ["주주환원"], urgency: "주주환원" };
  }
  if (/합병|분할|영업양수|영업양도|타법인주식및출자증권(취득|양수)|타법인 주식/.test(reportName)) {
    return { action: "거래 구조와 자금 조달 방식 확인", tags: ["인수합병"], urgency: "M&A" };
  }
  if (/단일판매|공급계약|수주/.test(reportName)) {
    return { action: "계약 금액, 기간, 매출 대비 비중 확인", tags: ["계약·수주"], urgency: "계약" };
  }
  if (/신규시설투자|유형자산(취득|처분)/.test(reportName)) {
    return { action: "투자 규모와 완료 시점 확인", tags: ["설비투자"], urgency: "투자" };
  }
  if (/유상증자|전환사채|신주인수권|증권신고서|CB|BW/.test(reportName)) {
    return { action: "납입일, 할인율, 전환 조건 확인", tags: ["증자·지분"], urgency: "자금조달" };
  }
  // Somebody's holding moved. Not the company acting, but the register
  // changing, which is the other half of what 지분 means to a reader.
  if (/대량보유상황|특정증권등소유상황|최대주주등소유주식변동|특수관계인에대한주식|주식담보제공/.test(reportName)) {
    return { action: "누가 얼마나 늘리고 줄였는지 확인", tags: ["증자·지분"], urgency: "지분변동" };
  }
  if (/최대주주|대표이사|경영권/.test(reportName)) {
    return { action: "변경 전후 지분과 보호예수 확인", tags: ["경영권"], urgency: "지배구조" };
  }
  if (/잠정실적|매출액|손익구조|영업실적/.test(reportName)) {
    return { action: "일회성 여부와 전년 대비 변화 확인", tags: ["실적"], urgency: "실적" };
  }
  if (/채무보증|자금차입|금전대여/.test(reportName)) {
    return { action: "상대방과 규모, 이자 조건 확인", tags: ["자금거래"], urgency: "자금거래" };
  }

  return { action: "공시 원문과 제출 시각 확인", tags: ["기타"], urgency: "공시" };
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

// A filing older than this is not why a stock moved today.
const leaderDisclosureDays = 3;

// One request per leader, and eight leaders on a build. At a board a minute
// through a session that is a few thousand against a 20,000/day quota, so the
// cache is what keeps it affordable rather than the request count.
const leaderDisclosureTtlMs = 5 * 60_000;

/**
 * The filings made by particular companies, rather than by the market.
 *
 * loadDartDisclosures asks what was filed at all and keeps the newest thirty,
 * which is the right list for the 공시 board and the wrong one for explaining a
 * move: measured across three builds, the overlap between those thirty filings
 * and the day's eight leaders was zero, zero and zero. The strongest evidence
 * the reason engine has — a company saying something itself — was structurally
 * unable to fire.
 *
 * DART's list endpoint takes a corp_code, so the question can simply be asked
 * the other way round.
 */
export async function loadLeaderDisclosures(config, symbols) {
  if (!config.dart.apiKey || symbols.length === 0) return [];

  const corpCodes = await resolveCorpCodes(config, symbols);
  const from = new Date();

  from.setDate(from.getDate() - leaderDisclosureDays);

  const results = await Promise.all([...corpCodes].map(([symbol, corpCode]) =>
    readThroughCache(`dart:disclosures:${symbol}`, leaderDisclosureTtlMs, async () => {
      const url = new URL("https://opendart.fss.or.kr/api/list.json");

      url.searchParams.set("crtfc_key", config.dart.apiKey);
      url.searchParams.set("corp_code", corpCode);
      url.searchParams.set("bgn_de", yyyymmdd(from));
      url.searchParams.set("page_count", "20");
      url.searchParams.set("sort", "date");
      url.searchParams.set("sort_mth", "desc");

      const response = await fetchJson(url.toString(), { timeoutMs: 6000 });

      // 013 is "this company filed nothing", which is an answer and is cached
      // like one so a quiet company is not asked about on every build.
      if (response?.status === "013") return [];

      if (response?.status !== "000" || !Array.isArray(response.list)) return [];

      return response.list
        .filter((item) => item.rcept_no && item.report_nm)
        .map(toDisclosureItem);
    }).catch(() => [])
  ));

  return results.flat();
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
