import { query } from "../db/client.mjs";
import { sendKakaoMemo, kakaoConfigured } from "./kakao.mjs";

/**
 * 오늘의 주도 섹터와 그 안의 주도주를 카톡으로.
 *
 * 09:20부터 봅니다. 개장 20분이면 첫 매물이 소화되고 그날 돈이 어디로 가는지가
 * 대강 드러납니다. 그보다 이르면 시가 잔상이고, 늦으면 이미 다 간 뒤입니다.
 *
 * 거래대금 100위를 섹터로 묶습니다. 5위만 보면 삼성전자와 SK하이닉스가 늘 위에
 * 있어 그날 무엇이 달랐는지가 안 보입니다.
 *
 * **개별 종목의 테마 라벨은 흔들립니다** -- 2026-08-28에 212종목이 장중에 갈아탔습니다.
 * 그런데 묶어서 세면 그 흔들림이 씻깁니다. 반도체 다섯 종목이 100위 안에 있으면
 * 그중 하나가 잘못 붙었어도 "돈이 반도체로 갔다"는 사실은 남습니다. 개별 라벨을
 * 못 믿는 것과 섹터 순위를 못 믿는 것은 다릅니다.
 *
 * 수급에 대해:
 *
 *   외국인   장중 추정치가 나옵니다. 확정과 다릅니다.
 *   프로그램  장중에 나오지만 하루 다섯 구간뿐입니다.
 *   기관     **장중에 없습니다.** KIS가 주지 않고 마감 뒤 확정치만 들어옵니다.
 *
 * 그리고 이 값들은 판단 근거가 아니라 참고입니다. 외국인 순매수 상위를 재봤을 때
 * 익일 갭이 순매도 상위와 다르지 않았습니다 -- 사는 쪽이나 파는 쪽이나 같았습니다.
 * 보여는 주되 순위를 매기지 않습니다.
 */

const startMinute = 9 * 60 + 20;
const poolSize = 100;
// 섹터 안에서 셋까지. 넷째부터는 거래대금이 급히 작아져 같은 얘기를 반복합니다.
const perSector = 3;
// 100위 안에 둘 이상 있어야 섹터입니다. 하나뿐이면 그 종목 얘기지 섹터 얘기가
// 아니고, 그런 것이 목록의 대부분입니다.
const minMembers = 2;
const showSectors = 3;
/*
 * 시가총액 문턱. 이보다 큰 회사는 섹터를 대표하지 않습니다.
 *
 * 삼성전자와 SK하이닉스는 거래대금이 늘 1조 안팎이라, 그냥 두면 반도체가 매일
 * 1위입니다. 그것은 그날에 대해 아무것도 말하지 않습니다 -- 어제도 오늘도 내일도
 * 같은 답이니까요. 물어보는 것은 "오늘 돈이 어디로 갔나"이므로, 늘 거기 있는
 * 것들은 대표에서 뺍니다.
 *
 * 20조입니다. 삼성전자·SK하이닉스·현대차 같은 지수 종목이 걸리고, 오늘 크게 움직인
 * 1,000억대 종목은 남습니다. 2026-08-28에 참고한 화면이 건설·MLCC·소부장을
 * 1·2·3위로 놓았는데 그 셋의 대표 종목이 전부 1,000억대였습니다.
 *
 * 섹터 **구성원**에서는 빼지 않습니다. 반도체에 삼성전자가 있다는 사실은 맞고,
 * 다만 그것이 오늘의 주도를 정하지 않을 뿐입니다.
 */
const maximumLeadCap = 20e12;

// 섹터가 아닌 라벨. 이것으로 묶으면 "미분류가 오늘의 주도 섹터"가 됩니다.
const notSectors = new Set(["ETF", "미분류", "개별 이슈", "거래대금 급증", "소형주 급등"]);

let sentDay = null;
let sentKey = "";
let running = false;

const eok = (won) => `${Math.round(Number(won) / 1e8).toLocaleString("ko-KR")}억`;

async function snapshot(config, day) {
  const { rows } = await query(config, `
    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol, name, change_rate, turnover, theme, market_cap
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:krx%'
         AND turnover IS NOT NULL
       ORDER BY symbol, observed_at DESC
    ),
    -- 외국인은 추정치이고 구간별로 들어옵니다. 가장 최근 구간만 씁니다.
    foreign_flow AS (
      SELECT DISTINCT ON (symbol) symbol, foreign_qty
        FROM kr_foreign_estimate WHERE session_date = $1::date
       ORDER BY symbol, bucket DESC
    ),
    program AS (
      SELECT DISTINCT ON (symbol) symbol, net_amount
        FROM kr_program_trade WHERE session_date = $1::date
       ORDER BY symbol, observed_time DESC
    )
    SELECT l.symbol, l.name, l.change_rate, l.turnover, l.theme, l.market_cap,
           f.foreign_qty, p.net_amount AS program_amount
      FROM latest l
      LEFT JOIN foreign_flow f ON f.symbol = l.symbol
      LEFT JOIN program p ON p.symbol = l.symbol
     ORDER BY l.turnover DESC
     LIMIT ${poolSize}
  `, [day]);

  return rows;
}

/**
 * 섹터 순위.
 *
 * **대표 종목의 거래대금**으로 매깁니다. 소속 종목 합으로 하면 삼성전자와
 * SK하이닉스가 든 섹터가 언제나 1위이고, 그것은 매일 같은 답이라 알 값어치가
 * 없습니다. 그날 돈이 몰린 곳을 묻는 것이므로 가장 굵은 한 종목이 기준입니다.
 */
function bySector(rows) {
  const groups = new Map();

  for (const row of rows) {
    const sector = String(row.theme ?? "").trim();

    if (!sector || notSectors.has(sector)) continue;
    if (!groups.has(sector)) groups.set(sector, []);

    groups.get(sector).push(row);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length >= minMembers)
    .map(([sector, members]) => {
      // 대표는 지수 종목이 아닌 것 중 가장 굵은 것. 하나도 없으면 그 섹터는
      // 오늘 대형주만 거래된 것이므로 순위에서 뺍니다.
      const representable = members.filter((member) =>
        !Number.isFinite(Number(member.market_cap)) || Number(member.market_cap) < maximumLeadCap);

      return {
        count: members.length,
        lead: representable.length > 0 ? Number(representable[0].turnover) : 0,
        members: (representable.length > 0 ? representable : members).slice(0, perSector),
        sector
      };
    })
    .filter((group) => group.lead > 0)
    .sort((left, right) => right.lead - left.lead)
    .slice(0, showSectors);
}

function flowOf(member) {
  const parts = [];

  if (member.foreign_qty !== null && Number(member.foreign_qty) !== 0) {
    parts.push(`외인${Number(member.foreign_qty) > 0 ? "+" : ""}${Math.round(Number(member.foreign_qty) / 1000).toLocaleString("ko-KR")}천주`);
  }
  if (member.program_amount !== null && Math.abs(Number(member.program_amount)) >= 1e8) {
    parts.push(`프로그램${Number(member.program_amount) > 0 ? "+" : ""}${eok(member.program_amount)}`);
  }

  return parts.join(" ");
}

/*
 * 섹터 하나에 한 통.
 *
 * 카카오 텍스트 템플릿은 200자입니다. 셋을 한 통에 담으면 2026-08-28에 그랬듯
 * "#2 전력"에서 잘립니다 -- 잘린 알림은 안 온 것보다 나쁩니다. 뒤에 뭐가 있었는지
 * 모르니까요.
 *
 * 섹터 이름의 괄호는 뗍니다. "수자원(양적/질적 개선)"에서 뒷부분은 그날의 이유와
 * 아무 상관이 없고, 200자 중 열두 자를 씁니다.
 */
function line(group, rank, at) {
  const names = group.members.map((member, i) => {
    const move = Number(member.change_rate);
    const flow = flowOf(member);

    return `${i + 1}등 ${member.name} ${move > 0 ? "+" : ""}${move.toFixed(2)}% ${eok(member.turnover)}${flow ? "\n   " + flow : ""}`;
  }).join("\n");

  const sector = group.sector.replace(/\s*\(.*?\)\s*/g, "").trim() || group.sector;

  return `[주도 섹터 #${rank + 1}] ${sector} · ${at}\n${group.count}종목 · 거래대금 100위\n\n${names}`;
}

/** 절대 던지지 않습니다 -- 알림 때문에 수집 틱이 멈추면 그 분의 분봉을 잃습니다. */
export async function notifyLeaders(config, { day, minute, url } = {}) {
  if (running || !kakaoConfigured(config) || minute < startMinute) return 0;

  running = true;

  try {
    if (sentDay !== day) { sentDay = day; sentKey = ""; }

    const groups = bySector(await snapshot(config, day));

    if (groups.length === 0) return 0;

    /*
     * 섹터 구성이 바뀔 때만. 같은 섹터 안에서 순위만 뒤집히는 것은 하루에도 여러 번
     * 있고, 그때마다 보내면 알림이 소음이 됩니다. 순서까지 보므로 1·2위가 자리를
     * 바꾸면 다시 나갑니다 -- 그것은 그날의 주도가 바뀌었다는 뜻입니다.
     */
    const key = groups.map((group) => group.sector).join("|");

    if (key === sentKey) return 0;

    const at = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

    let posted = 0;

    for (const [rank, group] of groups.entries()) {
      if (await sendKakaoMemo(config, { text: line(group, rank, at), url })) posted += 1;
    }

    // 한 통이라도 나갔으면 보낸 것으로 칩니다. 전부 실패했을 때만 다시 시도합니다.
    if (posted === 0) return 0;

    sentKey = key;
    console.log(`kakao: 주도 섹터 ${posted}통 · ${groups.map((group) => group.sector).join(" > ")}`);

    return posted;
  } catch (error) {
    console.warn("leader alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
