import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";
import { loadListingsOn } from "../src/providers/kr-listing-alert.mjs";

/**
 * 장 초반 테마별 거래대금 쏠림 -- 어느 테마로 돈이 몰리고 있나.
 *
 *   node scripts/theme-flow-check.mjs [YYYY-MM-DD] [HH:MM]
 *
 * 2026-10-30 사용자가 보안주를 찾은 순서(memory trader-brain): 판을 읽고 →
 * 거래대금이 쏠리는 테마를 보고 → 뉴스로 이유를 확인 → 누적 거래대금으로 대장 서열.
 * "주도주는 보통 09:10~09:20~30에 결정난다"고 해서 그 시각에 돌리는 확인용입니다.
 *
 * 시점까지의 종목별 마지막 표본(순위 1분·전 종목 6분)만 씁니다. 테마는 네이버 테마
 * 멤버십이고, 테마별로 상위 3종목 거래대금 합과 최근 10분 증가분, 상위 3종목 등락
 * 중앙값을 봅니다. 한 종목이 여러 테마에 들어 있어 같은 돈이 여러 테마에 잡힙니다.
 * 오르는 종목(+0% 초과)만 셉니다 -- 빠지는 대형주 거래대금이 테마를 부풀렸습니다
 * (10/30 09:33 삼성전자 -4.4% 8,983억이 '의료기기' 1위를 만듦). 그날 상장한 종목은
 * 테마가 없어서 '신규상장' 묶음으로 따로 넣습니다(10/30 인텔리빅스). 그날 상장 종목은
 * KIND 일정에서 이름으로 찾습니다 -- kr_listings는 일봉이 들어온 뒤에 차서 상장 당일
 * 장중엔 비어 있고, 11/02 영광(누적 3,700억, 그날 최대)이 이 표에서 빠졌습니다.
 * 11/03 09:13엔 래블업(그날 최대)이 또 빠졌습니다 -- 상장 당일 아침 표본은 이름 자리에
 * 코드("0147B0", 영광은 "359410")가 찍혀 이름 대조가 안 됩니다. 그래서 이름이 곧 코드인
 * 종목도 신규상장으로 넣고, KIND 조회는 한 번 더 묻습니다(시한 실패로 빈 목록이 됨).
 * 판정이 아니라 사람이 보는 표입니다. 진입 권유로 쓰지 않습니다.
 *
 * 아래에 **업종 큰 묶음**을 따로 붙입니다(11/05). 네이버 테마는 잘게 나뉘어 있어
 * 바이오처럼 돈이 업종 전체로 들어온 날엔 바이오시밀러·제약·항암·비만으로 흩어지고
 * 어느 하나도 상위에 못 올라옵니다 -- 11/05 셀트리온 +7·한미약품 +12·알테오젠 +7이
 * 그날 주도였는데 표에 안 나왔습니다. 큰 묶음은 아래 테마들의 합집합이고, 한 종목은
 * 한 묶음에 한 번만 셉니다. 테마 이름은 네이버가 바꿀 수 있어 없는 이름은 경고합니다.
 */
const sectorGroups = {
  "2차전지": ["2차전지", "2차전지(LFP/리튬인산철)", "2차전지(나트륨이온)", "2차전지(생산)", "2차전지(소재/부품)", "2차전지(장비)", "2차전지(전고체)", "리튬", "폐배터리"],
  "건설": ["건설 대표주", "건설 중소형", "건설기계", "시멘트/레미콘"],
  "금융": ["생명보험", "손해보험", "은행", "인터넷은행", "증권"],
  "로봇": ["로봇(산업용/협동로봇 등)", "피지컬 AI/휴머노이드 로봇"],
  "반도체": ["CXL(컴퓨트익스프레스링크)", "HBM(고대역폭메모리)", "반도체 기판(FC-BGA/PCB/MLB 등)", "반도체 대표주(생산)", "반도체 장비", "반도체 재료/부품", "소캠(SOCAMM)", "시스템반도체", "유리 기판", "전력반도체"],
  "방산·우주": ["드론(Drone)", "방위산업/전쟁 및 테러", "우주항공산업(누리호/인공위성 등)", "항공기부품"],
  "바이오·제약": ["mRNA(메신저 리보핵산)", "마이크로바이옴", "면역항암제", "바이오시밀러(복제 바이오의약품)", "백신/진단시약/방역(신종플루, AI 등)", "보톡스(보툴리눔톡신)", "비만치료제", "오가노이드", "유전자 치료제/분석", "의료AI", "의료기기", "제약업체", "줄기세포", "치매", "치아 치료(임플란트 등)", "탈모 치료"],
  "신재생": ["고체산화물 연료전지(SOFC)", "수소에너지(수소차/연료전지 등)", "우주태양광(페로브스카이트 등)", "전력저장장치(ESS)", "태양광에너지", "풍력에너지"],
  "엔터·게임": ["게임", "모바일게임(스마트폰)", "영상콘텐츠", "영화", "웹툰", "엔터테인먼트", "음원/음반"],
  "자동차": ["자동차 대표주", "자동차부품", "자율주행차", "전기차", "스마트카(SMART CAR)", "타이어"],
  "전력·원전": ["스마트그리드(지능형전력망)", "원자력발전", "원자력발전소 해체", "전력설비", "전선", "핵융합에너지"],
  "조선": ["조선", "조선기자재"],
  "화장품·미용": ["면세점", "미용기기", "화장품"]
};
const config = readConfig();
const kst = new Date(Date.now() + 9 * 3600_000).toISOString();
const day = process.argv[2] ?? kst.slice(0, 10);
const at = process.argv[3] ?? kst.slice(11, 16);

async function listedNamesOn() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const names = (await loadListingsOn(config, day).catch(() => [])).map((stock) => stock.name);

    if (names.length) return names;
  }

  return [];
}

const listedNames = await listedNamesOn();

/*
 * 대장 등락 문턱. 테마를 걸러 낼 때(대장 중앙)와 돈을 셀 때 같은 값을 씁니다.
 *
 * 돈은 이 문턱을 스스로 넘은 대장 것만 셉니다(11/09). 0% 초과만 보던 때에는
 * 11/09 09:13·09:23·09:33 세 번 모두 1~3위(의료기기·5G·VR, 스마트폰·갤럭시·폴더블)가
 * 삼성전자 +0.2~0.6%, 5,756~8,715억 한 종목의 돈이었고, 대장 중앙 +3%는 같이 묶인
 * 몇억짜리 두 종목이 넘겨 줬습니다. 대장 목록에는 그대로 남겨 끼어 있는 것은 보이게 둡니다.
 */
const leaderRate = 3;
const flowSql = (members) => `
  WITH s AS (
    SELECT symbol, name, change_rate::float8 r, turnover::float8 t, observed_at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1 AND source LIKE 'kis:krx%'
       AND observed_at <= ($1::date + $2::time) AT TIME ZONE 'Asia/Seoul'
       AND observed_at >= ($1::date + time '09:00') AT TIME ZONE 'Asia/Seoul'
  ),
  now AS (SELECT DISTINCT ON (symbol) symbol, name, r, t FROM s ORDER BY symbol, observed_at DESC),
  ago AS (
    SELECT DISTINCT ON (symbol) symbol, t FROM s
     WHERE observed_at <= ($1::date + $2::time - interval '10 minutes') AT TIME ZONE 'Asia/Seoul'
     ORDER BY symbol, observed_at DESC
  ),
  j AS (
    SELECT tm.theme_name, n.symbol, n.name, n.r, n.t, n.t - coalesce(a.t, 0) dt,
           row_number() OVER (PARTITION BY tm.theme_name ORDER BY n.t DESC) k
      FROM now n
      JOIN (${members}) tm USING (symbol)
      LEFT JOIN ago a USING (symbol)
     WHERE n.r > 0
  )
  SELECT theme_name, count(*) n,
         coalesce(sum(t) FILTER (WHERE k <= 3 AND r >= ${leaderRate}), 0) / 1e8 top3_t,
         coalesce(sum(dt) FILTER (WHERE k <= 3 AND r >= ${leaderRate}), 0) / 1e8 top3_dt,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE k <= 3) top3_r,
         string_agg(name || ' ' || round(r::numeric, 1) || '% ' || round((t / 1e8)::numeric) || '억', ' > ' ORDER BY k) FILTER (WHERE k <= 3) leaders
    FROM j GROUP BY theme_name
   HAVING percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE k <= 3) >= ${leaderRate}
   ORDER BY 4 DESC NULLS LAST
   LIMIT $4`;
const themeMembers = `SELECT DISTINCT theme_name, symbol FROM kr_theme_members
            UNION SELECT '신규상장', symbol FROM kr_listings WHERE listed_on = $1
            UNION SELECT '신규상장', symbol FROM now WHERE name = ANY($3::text[]) OR name = symbol`;
/*
 * 한 종목은 한 묶음에만 넣습니다 -- 그 종목이 가장 많은 테마에 들어 있는 묶음으로요.
 * 네이버 테마가 넓어서 현대차가 수소·휴머노이드에, NAVER가 자율주행에 들어 있고,
 * 합집합 그대로 두면 11/05 09:33 자동차·로봇·신재생 세 묶음의 대장이 전부 현대차였습니다.
 */
const sectorMembers = `SELECT DISTINCT ON (m.symbol) g.key theme_name, m.symbol
              FROM jsonb_each($3::jsonb) g
              CROSS JOIN jsonb_array_elements_text(g.value) t(theme)
              JOIN kr_theme_members m ON m.theme_name = t.theme
             GROUP BY g.key, m.symbol
             ORDER BY m.symbol, count(DISTINCT t.theme) DESC, g.key`;
const { rows } = await query(config, flowSql(themeMembers), [day, at, listedNames, 8]);
const { rows: sectors } = await query(config, flowSql(sectorMembers), [day, at, JSON.stringify(sectorGroups), 6]);
const { rows: known } = await query(config, "SELECT DISTINCT theme_name FROM kr_theme_members WHERE theme_name = ANY($1::text[])", [Object.values(sectorGroups).flat()]);
const missing = Object.values(sectorGroups).flat().filter((name) => !known.some((row) => row.theme_name === name));
const { rows: [market] } = await query(config, `
  SELECT symbol, change_rate FROM macro_samples
   WHERE symbol IN ('KOSPI', 'KOSDAQ') AND observed_at <= ($1::date + $2::time) AT TIME ZONE 'Asia/Seoul'
   ORDER BY observed_at DESC LIMIT 1`, [day, at]);

console.log(`${day} ${at} 테마 쏠림 (상위 3종목 · 최근 10분 거래대금 증가 순 · 대장 등락 중앙 +${leaderRate}% 이상만 · 거래대금은 +${leaderRate}% 넘은 대장만)${market ? ` · ${market.symbol} ${market.change_rate}%` : ""}`);
for (const row of rows) {
  console.log(`${row.theme_name} | 10분 +${Math.round(row.top3_dt)}억 · 누적 ${Math.round(row.top3_t)}억 · 대장 중앙 ${Number(row.top3_r).toFixed(1)}% | ${row.leaders}`);
}
console.log("");
console.log("업종 큰 묶음 (네이버 테마 합집합 · 같은 기준)");
for (const row of sectors) {
  console.log(`[${row.theme_name}] | 10분 +${Math.round(row.top3_dt)}억 · 누적 ${Math.round(row.top3_t)}억 · 대장 중앙 ${Number(row.top3_r).toFixed(1)}% | ${row.leaders}`);
}
if (missing.length) console.log(`(경고: 네이버 테마에 없는 이름 ${missing.join(", ")})`);
process.exit(0);
