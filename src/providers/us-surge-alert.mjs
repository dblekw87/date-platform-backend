import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadDelistRisk, riskLine } from "./us-delist-risk.mjs";
import { loadUsMarketGainers } from "./us-market-gainers.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { usMarketPhase } from "./premarket.mjs";

/**
 * 미국 정규장에서 시장 전체가 급등하는 종목을 잡아 카톡 한 통.
 *
 * `[미국 개장]` 알림과 겹치지 않습니다. 그쪽은 **프리마켓에서 이미 갭을 띄운**
 * 종목이 개장 첫 5분봉을 양봉으로 여는 자리를 봅니다. 이쪽은 **프리마켓이 조용했던**
 * 종목이 장중에 터지는 자리입니다. 2026-08-31에 둘 다 필요하다는 것이 드러났습니다.
 *
 *   RDHL  프리 +116% → 정규장 +139%   감시 목록에 없어 개장 알림이 못 울렸습니다
 *   CLGN  프리   +4% → 정규장 +187%   목록엔 있었지만 프리 갭이 없어 대상이 아니었습니다
 *
 * 둘 다 정규장에서 크게 올랐으므로, 시장 전체를 정규장에 훑는 이 알림 하나가
 * 두 구멍을 같이 메웁니다. 프리마켓 커버리지를 따로 뚫는 것보다 단순합니다.
 *
 * **문턱은 아직 실측이 아닙니다.** 이 종류의 사건이 하루에 몇 번 일어나는지를
 * 우리가 한 번도 본 적이 없기 때문입니다 -- 시장 전체 스캔 자체가 오늘 처음
 * 생겼습니다. 그래서 아래 값은 2026-08-31 밤 한 세션에서 다섯 종목이 걸리도록
 * 잡은 것이고, 근거가 아니라 출발점입니다. 걸린 것과 안 걸린 것을 전부 로그에
 * 남기니 몇 주 뒤 기저율을 재서 다시 정하세요.
 */

// 한밤중에 울리는 알림입니다. 미국 정규장은 한국 시간 22:30~05:00이라 전부
// 자는 시간에 옵니다 -- 넓게 잡으면 매일 밤 여러 통이 됩니다.
const minChangePercent = 60;
// 거래대금이 문턱입니다. 회전율이 미국 급등에서 유일하게 살아남은 신호였고
// 뉴스·차트·공시는 전부 반증됐습니다. 호가만 뛴 종목을 거르는 역할도 합니다.
const minTurnover = 20_000_000;
// 하루 상한. 조건이 잘못 잡혀 있어도 밤새 스무 통이 오는 일은 없어야 합니다.
const maxPerSession = 5;

let running = false;

/*
 * 상폐 위험 표식을 같이 적습니다. 급등 6,893건 중 24%가 상장유지 미달 통지를 받은
 * 종목이었고(전체는 3%), 그것이 "왜 튀는가"의 절반을 설명합니다 -- us-delist-risk.mjs.
 * 표식이 있다고 사지 말라는 뜻도 사라는 뜻도 아닙니다. 다만 그 급등의 성격이 다릅니다.
 */
function line(row, risk) {
  const cap = row.marketCap ? `$${(row.marketCap / 1e6).toFixed(1)}M` : "시총 미상";

  return [
    `[미국 급등] ${row.symbol}`,
    row.name === row.symbol ? null : row.name,
    `+${row.changePercent.toFixed(1)}% · $${row.price.toFixed(2)}`,
    `거래대금 $${(row.turnover / 1e6).toFixed(1)}M · 시총 ${cap}`,
    riskLine(risk) || null
  ].filter(Boolean).join("\n");
}

/**
 * 절대 던지지 않습니다 -- 알림 때문에 수집 틱이 멈추면 그 분의 분봉을 잃고,
 * 그것은 다시 받을 수 없습니다.
 */
export async function notifyUsSurges(config, { day, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  // 정규장에만. percentchange가 정규장 기준이라 장 밖에서는 직전 세션 값이
  // 그대로 나오고, 그것을 오늘 급등으로 읽으면 매일 아침 같은 종목이 옵니다.
  if (usMarketPhase() !== "regular") return 0;

  running = true;

  try {
    const sent = new Set((await loadAlertSent(config, "us_surge", day)).keys());
    const rows = await loadUsMarketGainers(config, { minPercent: 20 });
    const risks = await loadDelistRisk(config, rows.map((row) => row.symbol)).catch(() => new Map());

    // 걸린 것만이 아니라 후보 전부를 남깁니다. 문턱을 실측으로 다시 정하려면
    // 안 걸린 쪽이 있어야 합니다.
    console.log(`us surge scan · ${rows.length} candidates · ${rows.slice(0, 8).map((r) => `${r.symbol} ${r.changePercent.toFixed(0)}%/$${(r.turnover / 1e6).toFixed(0)}M`).join(" ")}`);

    let posted = 0;

    for (const row of rows) {
      if (sent.size >= maxPerSession) break;
      if (sent.has(row.symbol)) continue;
      if (row.changePercent < minChangePercent || row.turnover < minTurnover) continue;

      // 보낸 것만 기록합니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
      if (!await notify(config, { text: line(row, risks.get(row.symbol)), url })) continue;

      await markAlertSent(config, "us_surge", day, row.symbol, { note: `+${row.changePercent.toFixed(0)}%` });
      sent.add(row.symbol);
      posted += 1;
      console.log(`알림: 미국 급등 · ${row.symbol} +${row.changePercent.toFixed(0)}% · 거래대금 $${(row.turnover / 1e6).toFixed(0)}M`);
    }

    return posted;
  } catch (error) {
    console.warn("us surge alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
