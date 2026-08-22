import { classifyDisclosure, loadDartDisclosures } from "./dart.mjs";
import { fetchJson, fetchText } from "../http.mjs";
import { query } from "../db/client.mjs";

/**
 * 국내 공시를 접수 시각과 함께 저장합니다.
 *
 * 왜 두 곳에서 받아오는가. OpenDART의 list.json은 종목코드와 법인 구분을 주는 대신
 * 접수 "날짜"만 주고 시각을 주지 않습니다. 2026-08-21 삼성전자가 그 차이를 보여줬는데,
 * 17:09 공정공시와 17:19 자기주식취득결정이 같은 날짜 아래 구분 없이 들어옵니다.
 * 주가는 17:13에 무너졌으므로 둘 중 어느 것에 반응했는지가 정반대로 갈립니다.
 * DART 당일공시 목록 화면은 같은 접수번호에 분 단위 시각을 붙여 주므로, 내용은 API에서
 * 받고 시계는 그쪽에서 받아 접수번호로 잇습니다.
 *
 * 시각을 못 받은 건은 처음 관측한 시각을 대신 적고 filed_at_source에 그렇다고
 * 남깁니다. 폴링 간격만큼 늦은 상한값이라 근사치로 쓸 수는 있지만, 근사치인 줄 모르고
 * 쓰면 위의 6분짜리 판단이 그대로 틀립니다.
 */

// 당일공시 화면은 탭마다 목록이 갈립니다. mainAll은 이름과 달리 전체가 아니라
// 시장별 공시(유가·코스닥·코넥스·기타법인)까지이고, 5%룰과 임원 소유상황은 mainO,
// 집합투자증권은 mainF에 따로 있습니다. 2026-08-21 실측 587 + 113 + 106건으로,
// mainAll만 읽으면 그날 지분공시 113건이 전부 시각 없이 들어옵니다. 지분 변동은
// 주가가 움직인 이유를 찾을 때 가장 먼저 보는 것이라 빠뜨릴 수 없습니다.
const dartDayTabs = ["mainAll", "mainO", "mainF"];
const dartDayListUrl = "https://dart.fss.or.kr/dsac001/";
const dartListUrl = "https://opendart.fss.or.kr/api/list.json";
const pageSize = 100;

// 새 공시는 언제나 시각순 맨 앞에 있으므로 상시 수집에는 첫 장이면 충분합니다. 하루치를
// 처음부터 메우는 경우에만 더 넘깁니다.
const defaultTimePages = 1;

function yyyymmdd(sessionDate) {
  return sessionDate.replaceAll("-", "");
}

/**
 * 접수번호 → "HH:MM". 화면이 바뀌어 한 건도 못 읽으면 빈 Map을 돌려주고, 그러면
 * 호출부가 관측 시각으로 떨어집니다 — 시각 하나 때문에 공시 자체를 잃지 않도록.
 */
export async function loadFilingTimes(sessionDate, pages = defaultTimePages) {
  const times = new Map();

  for (const tab of dartDayTabs) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL(`${tab}.do`, dartDayListUrl);

      url.searchParams.set("currentPage", String(page));
      url.searchParams.set("selectDate", yyyymmdd(sessionDate));

      const html = await fetchText(url.toString(), {
        headers: { "accept-language": "ko", "user-agent": "date-platform/1.0" },
        timeoutMs: 8000
      }).catch(() => "");

      if (!html) break;

      let found = 0;

      for (const row of html.split(/<tr[ >]/).slice(1)) {
        const receipt = row.match(/rcpNo=(\d{14})/) ?? row.match(/openReportViewer\((["'])(\d{14})\1\)/);
        const time = row.match(/>\s*([0-2]\d:[0-5]\d)\s*</);

        if (!receipt || !time) continue;

        const number = receipt[2] ?? receipt[1];

        found += 1;

        if (!times.has(number)) times.set(number, time[1]);
      }

      if (found < pageSize) break;
    }
  }

  return times;
}

function toRow(item, times, sessionDate) {
  const classified = classifyDisclosure(item.report_nm);
  const time = times.get(item.rcept_no);
  const reportName = String(item.report_nm ?? "").trim();
  const symbol = String(item.stock_code ?? "").trim();

  return {
    accessionNumber: item.rcept_no,
    action: classified.action,
    companyName: item.corp_name,
    eventType: classified.urgency,
    filedAt: time ? `${sessionDate}T${time}:00+09:00` : null,
    filerName: item.flr_nm ?? null,
    formType: "공시",
    id: `dart-${item.rcept_no}`,
    marketClass: item.corp_cls ?? null,
    originalUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
    reportName,
    sessionDate,
    symbol: symbol === "" ? null : symbol,
    tags: classified.tags,
    title: `${item.corp_name} · ${reportName}`,
    urgency: classified.urgency
  };
}

/**
 * 하루치 공시 한 장. total_page를 같이 돌려줘 호출부가 더 넘길지 정합니다.
 */
export async function readKrDisclosures(config, { page = 1, sessionDate, times }) {
  if (!config.dart.apiKey) return { items: [], totalPages: 0 };

  const day = yyyymmdd(sessionDate);
  const url = new URL(dartListUrl);

  url.searchParams.set("bgn_de", day);
  url.searchParams.set("crtfc_key", config.dart.apiKey);
  url.searchParams.set("end_de", day);
  url.searchParams.set("page_count", String(pageSize));
  url.searchParams.set("page_no", String(page));
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "desc");

  const response = await fetchJson(url.toString(), { timeoutMs: 8000 });

  // 013은 "그날 공시가 없다"이고 오류가 아닙니다. 휴장일과 이른 아침이 여기로 옵니다.
  if (response?.status === "013") return { items: [], totalPages: 0 };

  if (response?.status !== "000" || !Array.isArray(response.list)) {
    throw new Error(`DART ${response?.status ?? "unknown"} ${response?.message ?? ""}`.trim());
  }

  const items = response.list
    .filter((item) => item.rcept_no && item.report_nm)
    .map((item) => toRow(item, times, sessionDate));

  return { items, totalPages: Number(response.total_page ?? 1) };
}

export async function saveKrDisclosures(config, rows) {
  if (rows.length === 0) return 0;

  // 관측 시각은 처음 본 때로 고정합니다. 갱신하면 폴링할 때마다 뒤로 밀려서, 시각을
  // 못 받은 건의 유일한 단서가 사라집니다. 나중에 진짜 시각이 붙으면 그때만 고칩니다.
  const result = await query(config, `
    INSERT INTO market_disclosures
      (id, market, source, urgency, company_name, symbol, issuer_type, event_type,
       accession_number, form_type, title, filed_at, original_url, tags, action,
       session_date, filed_at_source, report_name, filer_name, market_class)
    SELECT id, 'KR', 'DART', urgency, company_name, symbol, 'unknown', event_type,
           accession_number, form_type, title,
           coalesce(filed_at, now()), original_url, ARRAY[tag], action,
           $16::date, CASE WHEN filed_at IS NULL THEN 'first-seen' ELSE 'dart' END,
           report_name, filer_name, market_class
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                $7::text[], $8::text[], $9::timestamptz[], $10::text[], $11::text[],
                $12::text[], $13::text[], $14::text[], $15::text[])
      AS t(id, urgency, company_name, symbol, event_type, accession_number,
           form_type, title, filed_at, original_url, tag, action, report_name,
           filer_name, market_class)
    ON CONFLICT (id) DO UPDATE
      SET filed_at = EXCLUDED.filed_at,
          filed_at_source = 'dart',
          updated_at = now()
      WHERE market_disclosures.filed_at_source = 'first-seen'
        AND EXCLUDED.filed_at_source = 'dart'
  `, [
    rows.map((row) => row.id),
    rows.map((row) => row.urgency),
    rows.map((row) => row.companyName),
    rows.map((row) => row.symbol),
    rows.map((row) => row.eventType),
    rows.map((row) => row.accessionNumber),
    rows.map((row) => row.formType),
    rows.map((row) => row.title),
    rows.map((row) => row.filedAt),
    rows.map((row) => row.originalUrl),
    rows.map((row) => row.tags[0] ?? "DART"),
    rows.map((row) => row.action),
    rows.map((row) => row.reportName),
    rows.map((row) => row.filerName),
    rows.map((row) => row.marketClass),
    rows[0].sessionDate
  ]);

  return result.rowCount;
}

/**
 * 하루치를 훑되, 이미 아는 구간에 닿으면 멈춥니다.
 *
 * 한 장이 통째로 새것이면 그 사이에 백 건 넘게 접수됐다는 뜻이므로 다음 장으로
 * 넘어갑니다. 평소에는 첫 장에서 끝나 요청 두 번이면 되고, 하루를 처음부터 메울 때만
 * 깊이 들어갑니다.
 */
export async function collectKrDisclosures(config, {
  log,
  maxPages = 10,
  sessionDate,
  stopWhenKnown = true,
  timePages = defaultTimePages
} = {}) {
  const times = await loadFilingTimes(sessionDate, timePages);

  let fetched = 0;
  let saved = 0;
  let timed = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const { items, totalPages } = await readKrDisclosures(config, { page, sessionDate, times });

    if (items.length === 0) break;

    const stored = await saveKrDisclosures(config, items);

    fetched += items.length;
    saved += stored;
    timed += items.filter((item) => item.filedAt !== null).length;

    // 하루를 메울 때는 끝까지 갑니다. 이미 저장된 건에 뒤늦게 시각을 붙이는 것이
    // 목적이라, 새것이 없다는 이유로 멈추면 고쳐야 할 행에 닿지 못합니다.
    if (page >= totalPages || (stopWhenKnown && stored < items.length)) break;
  }

  if (log) log(`kr disclosures · ${saved}/${fetched} new · ${timed} timed · ${sessionDate}`);

  return { fetched, saved, timed };
}

/**
 * 시가총액으로 나눈 발행사 규모.
 *
 * 화면의 `소형주` 칩이 국내에서 한 건도 못 잡고 있었습니다. 저장할 때
 * issuer_type을 그냥 'unknown'으로 박아 넣었기 때문입니다. 실제로는 하루 공시
 * 780건 중 117건이 시총 3천억 미만 회사가 낸 것이고, 시총을 아예 모르는 208건은
 * 수집 대상(거래 상위 568종목) 밖이라 그 자체가 소형주라는 신호입니다.
 *
 * 유가증권 상장사는 모른다고 답합니다 -- 거래가 뜸한 대형주도 있어서, 코스닥·코넥스와
 * 달리 시장 구분만으로는 규모를 말할 수 없습니다.
 */
const largeCapFloor = 1_000_000_000_000;
const midCapFloor = 300_000_000_000;

function issuerTypeFor(marketCap, marketClass) {
  if (Number.isFinite(marketCap) && marketCap > 0) {
    if (marketCap >= largeCapFloor) return "large-cap";

    return marketCap >= midCapFloor ? "mid-cap" : "small-cap";
  }

  return marketClass === "K" || marketClass === "N" ? "small-cap" : "unknown";
}

// 화면에 담기는 양. 하루 780건을 다 내려보내도 읽는 사람이 없습니다.
const boardDisclosureLimit = 120;

/**
 * 보드가 그리는 국내 공시 -- DART가 아니라 우리가 저장한 표에서 읽습니다.
 *
 * 보드는 매번 DART에 다시 물어 최신 30건만 받고 있었습니다. 시장 전체에서 30건이면
 * 오전에 이미 그날 것이 아니고, 무엇보다 필터 칩을 누르면 걸리는 게 거의 없습니다.
 * 저장된 표에는 같은 날 780건이 접수 시각과 분류를 달고 들어와 있으므로, 칩이
 * 실제로 무언가를 걸러낼 수 있는 모집단은 이미 여기 있습니다.
 */
export async function loadStoredKrDisclosures(config, { limit = boardDisclosureLimit, sessionDate } = {}) {
  const result = await query(config, `
    SELECT d.accession_number, d.action, d.company_name, d.event_type, d.filed_at,
           d.form_type, d.id, d.market_class, d.original_url, d.report_name,
           d.symbol, d.tags, d.title, d.urgency, c.market_cap
      FROM market_disclosures d
      LEFT JOIN LATERAL (
        SELECT market_cap
          FROM market_price_samples s
         WHERE s.market = 'KR' AND s.symbol = d.symbol AND s.market_cap IS NOT NULL
         ORDER BY s.observed_at DESC
         LIMIT 1
      ) c ON true
     WHERE d.market = 'KR'
       AND ($1::date IS NULL OR d.session_date = $1::date)
     ORDER BY d.filed_at DESC
     LIMIT $2
  `, [sessionDate ?? null, limit]);

  return result.rows.map((row) => ({
    accessionNumber: row.accession_number,
    action: row.action,
    companyName: row.company_name,
    eventType: row.event_type,
    filedAt: row.filed_at,
    formType: row.form_type,
    id: row.id,
    issuerType: issuerTypeFor(Number(row.market_cap), row.market_class),
    market: "KR",
    originalUrl: row.original_url,
    source: "DART",
    symbol: row.symbol,
    tags: row.tags ?? [],
    title: row.title,
    urgency: row.urgency
  }));
}

/**
 * The board's domestic filing box.
 *
 * Prefers what the collector stored, which is the whole day with receipt times
 * and a size for each filer, and falls back to asking DART directly so a fresh
 * database or a morning before the first sweep still draws something.
 */
export async function loadKrDisclosureBoard(config) {
  const stored = await loadStoredKrDisclosures(config).catch(() => []);

  if (stored.length > 0) return { krDisclosures: stored };

  return loadDartDisclosures(config);
}
