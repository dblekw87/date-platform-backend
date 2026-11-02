import { query } from "../db/client.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadKrxCalendar } from "./krx.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 오늘 상장하는 종목 -- 아침에 한 번, 있을 때만.
 *
 * 사용자가 신규 상장주를 그날 헷지주로 씁니다(`kr-listings.mjs`). 재료도 차트도
 * 아니고 **오늘 상장한다는 사실**이 조건인 매매라, 그 사실이 아침에 와 있어야 합니다.
 * 2026-09-21에 사용자가 "신규상장할 게 있다면 07:30에 보내 달라"고 했습니다.
 *
 * 원본은 KIND 두 표(`providers/krx.mjs`가 보드 달력에 쓰는 것과 같은 캐시)입니다.
 * 신규상장기업현황은 상장 당일 아침에 이미 그 종목을 싣고 업종·주요제품·최초상장
 * 주식수를 주며, 공모기업현황은 상장예정일 기준이라 청약 일정과 공모가를 줍니다.
 * 같은 회사가 양쪽에 있으면 앞엣것을 씁니다.
 *
 * **스팩도 보냅니다.** 처음엔 `kr-listings.mjs`처럼 스팩·리츠를 빼려 했는데 사용자가
 * "신규 상장이라 하면 스팩주도 전달해야 한다"고 했습니다(2026-09-21). 그 표는 상장일을
 * 헷지 매매 대상으로 기록하는 곳이고, 이 알림은 오늘 상장하는 것 전부를 알리는 곳이라
 * 기준이 다릅니다. KIND 기업현황 두 표에는 ETF·ETN이 애초에 없습니다.
 *
 * 07:30~07:45 KST. 상장일 아침이면 KIND에 이미 올라와 있습니다(2026-09-21 00:30에
 * 그날 상장인 네오사피엔스가 양쪽 표에 있었습니다). 없는 날은 조용히 끝냅니다.
 */

const alertMinute = 7 * 60 + 30;
const stopMinute = 7 * 60 + 45;

let running = false;

export async function notifyKrListings(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  running = true;

  try {
    // 하루 한 통. 끝낸 날은 저장소에 남아 창 안에서 재기동해도 또 가지 않습니다.
    if ((await loadAlertSent(config, "kr_listing", day)).has("done")) return 0;

    const stocks = await loadListingsOn(config, day);

    if (!stocks.length) {
      await markAlertSent(config, "kr_listing", day, "done", { note: "상장 없음" });

      return 0;
    }

    const weekday = new Date(`${day}T00:00:00+09:00`).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
    const lines = [`[신규상장] 오늘 상장 ${stocks.length}종목 · ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} (${weekday})`, ""];

    for (const stock of stocks) {
      lines.push([stock.name, stock.market, stock.offerPrice ? `공모가 ${stock.offerPrice}원` : null, stock.amount ? `공모 ${stock.amount}` : null,
        stock.firstShares ? `최초상장 ${stock.firstShares}주` : null, stock.broker].filter(Boolean).join(" · "));

      if (stock.industry || stock.product) lines.push(`  ${[stock.industry, stock.product].filter(Boolean).join(" · ")}`);

      const ipo = await loadIpoNews(config, stock.name, day);

      if (ipo.about) lines.push(`  하는 일: ${ipo.about}`);

      lines.push(`  ${[
        `기관 ${ipo.institution ?? "?"}`,
        `청약 ${ipo.retail ?? "?"}`,
        ipo.deposit ? `증거금 ${ipo.deposit}` : null,
        `확약 ${ipo.lockup ?? "?"}`
      ].filter(Boolean).join(" · ")}`);

      if (ipo.lockupNote) lines.push(`  ${ipo.lockupNote}`);
    }

    lines.push("");
    lines.push("첫날 가격 범위는 공모가의 60~400%. 시초가는 09:00 동시호가에서 정해집니다.");
    lines.push("경쟁률·확약은 공모 기사 제목에서 읽은 값입니다. ?는 기사에서 못 찾은 것.");
    if (url) lines.push(url);

    if (!await notify(config, { text: lines.join("\n"), url: null })) return 0;

    await markAlertSent(config, "kr_listing", day, "done", { note: stocks.map((stock) => stock.name).join(", ").slice(0, 200) });
    console.log(`알림: 신규상장 ${stocks.length}종목 · ${stocks.map((stock) => stock.name).join(", ")}`);

    return stocks.length;
  } catch (error) {
    console.warn("kr listing alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 달력 항목은 표시용 문자열(detail) 하나로 옵니다. 그 문자열은 우리가 krx.mjs에서
 * `라벨 값 · 라벨 값` 꼴로 만든 것이라 라벨로 되읽습니다. 보드 DTO에 구조화된 필드를
 * 더하면 프론트 타입까지 같이 바뀌므로, 알림 하나를 위해 계약을 건드리지 않습니다.
 */
export async function loadListingsOn(config, day) {
  const { calendarItems = [] } = await loadKrxCalendar(config);
  const byName = new Map();

  for (const item of calendarItems) {
    if (item.type !== "신규상장" || item.date !== day) continue;

    const name = item.title.replace(/ (신규상장|상장예정)$/, "").trim();

    // 신규상장기업현황이 더 자세하므로 그것이 먼저 오면 공모기업현황 행은 버립니다.
    const listed = item.source === "KIND 신규상장기업현황";

    if (byName.has(name) && !listed) continue;

    byName.set(name, {
      amount: eok(field(item.detail, "공모금액")),
      broker: field(item.detail, "주관"),
      firstShares: field(item.detail, "최초상장주식수")?.replace(/주$/, "") ?? null,
      industry: listed ? industryOf(item.detail) : null,
      market: field(item.detail, "시장"),
      name,
      offerPrice: field(item.detail, "공모가"),
      product: field(item.detail, "주요제품")
    });
  }

  return [...byName.values()];
}

function field(detail, label) {
  const match = String(detail ?? "").split(" · ").find((part) => part.startsWith(`${label} `));

  return match ? match.slice(label.length + 1).trim() : null;
}

/*
 * 공모금액의 단위가 표마다 다릅니다. 공모기업현황은 `20,000백만원`, 신규상장기업현황은
 * 단위 없이 `20,000,000`(천원)으로 옵니다 -- 2026-09-21 네오사피엔스가 양쪽에서 200억.
 * 둘 다 억으로 바꿔 한 단위로 적습니다.
 */
function eok(amount) {
  if (!amount) return null;

  const number = Number(amount.replace(/[^0-9.]/g, ""));

  if (!Number.isFinite(number) || number <= 0) return null;

  const won = /백만원/.test(amount) ? number * 1e6 : number * 1e3;

  return `${Math.round(won / 1e8).toLocaleString("ko-KR")}억`;
}

// 신규상장기업현황 행의 detail: 시장 · 상장유형 · 증권종류 · 업종 · 국가 · 주관 … 순서입니다.
function industryOf(detail) {
  const parts = String(detail ?? "").split(" · ");
  const index = parts.findIndex((part) => /^(주권|외국주권|DR|수익증권)$/.test(part));

  return index >= 0 && parts[index + 1] && !/^(주관|공모가|대한민국)/.test(parts[index + 1]) ? parts[index + 1] : null;
}

/*
 * 수요예측·청약 경쟁률과 의무보유확약 -- 사용자가 상장 아침에 "어떤 회사인지, 확약은
 * 얼마인지"를 같이 받고 싶어 했습니다(2026-11-02, 영광). KIND 두 표에는 이 숫자가
 * 없어서 공모 기사 제목에서 읽습니다. 제목마다 싣는 숫자가 달라(영광은 기관 경쟁률과
 * 확약이 다른 기사에 있었습니다) 45일 치 제목을 모아 항목마다 가장 최근 값을 씁니다.
 * 못 찾은 칸은 비워 두고 알림에 ?로 적습니다 -- 추정으로 채우지 않습니다.
 *
 * 이름은 앞뒤가 한글이 아닐 때만 그 회사로 봅니다. '영광'이 '영광군' 기사에 붙지
 * 않게 하려는 것이고, 공모 낱말이 같이 있는 제목만 봅니다.
 */
const ipoWord = /(상장|공모|청약|수요예측|IPO|코스닥|코스피|증시 ?새내기)/;
const aboutWord = /(오늘상장|증시새내기|상장人터뷰|IPO챗|IPO레이더|\[현장\]|기자간담회)/;
// 주간 일정 기사('영광·래블업·이에스티 등 3개사')는 회사 소개가 아닙니다.
const manyWord = /(·[^ ]*·|등 ?\d+(개사|곳))/;

export async function loadIpoNews(config, name, day) {
  const empty = { about: null, deposit: null, institution: null, lockup: null, lockupNote: null, retail: null };

  if (!config.databaseUrl || !name) return empty;

  const { rows } = await query(config, `
    SELECT coalesce(original_headline, headline) AS title
      FROM market_news_items
     WHERE region = 'KR'
       AND published_at >= $2::date - 45
       AND published_at < ($2 || ' 07:30+09')::timestamptz
       AND coalesce(original_headline, headline) LIKE '%' || $1 || '%'
     ORDER BY published_at DESC
     LIMIT 300
  `, [name, day]);

  const own = new RegExp(`(^|[^가-힣])${escapeRegExp(name)}([^가-힣]|$)`);
  const titles = rows.map((row) => String(row.title ?? "")).filter((title) => own.test(title) && ipoWord.test(title));
  const pick = (pattern, format, only = /./) => {
    for (const title of titles.filter((text) => only.test(text))) {
      const match = title.match(pattern);

      if (match) return format(match);
    }

    return null;
  };
  const lockup = pick(/확약[^0-9%]{0,12}([\d.]+)\s?%/, (match) => `${match[1]}%`);
  const lockupRate = lockup ? Number.parseFloat(lockup) : null;

  return {
    about: aboutText(titles.find((title) => aboutWord.test(title) && !manyWord.test(title)), name),
    // '기관 주문 21조 몰려'(인텔리빅스 수요예측)는 청약 증거금이 아니라서 청약 기사에서만 읽습니다.
    deposit: pick(/([\d.,]+)\s?조\s?(원)?\s?(몰|운집|모여|유입)/, (match) => `${match[1]}조`, /(청약|증거금|공모주에)/),
    institution: pick(/(기관|수요예측)[^0-9]{0,10}([\d,.]+)\s?대\s?1/, (match) => `${match[2]}대 1`),
    lockup,
    lockupNote: lockupRate !== null && lockupRate < 5 ? "확약이 5% 아래 -- 첫날 바로 팔 수 있는 기관 물량이 대부분입니다." : null,
    retail: pick(/(청약|일반)[^0-9]{0,10}([\d,.]+)\s?대\s?1/, (match) => `${match[2]}대 1`)
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 회사 소개 기사 제목에서 꼬리표([오늘상장] 따위)와 매체 꼬리를 걷어 한 줄로 씁니다.
function aboutText(title, name) {
  if (!title) return null;

  const text = title
    .replace(/\[[^\]]*(\]|$)/g, "")
    .replace(/\s+-\s+[^-]+$/, "")
    .replace(/(…|\.\.\.)$/, "")
    .trim();

  return text && text !== name ? text.slice(0, 80) : null;
}
