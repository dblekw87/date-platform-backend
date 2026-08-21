import { getAccessToken } from "./kis.mjs";
import { query } from "../db/client.mjs";

/**
 * 장중 외국인 순매수 추정.
 *
 * 확정 수급(`kr_investor_flow`)은 장이 끝나야 나옵니다. 프로그램매매가 장중에 볼 수
 * 있는 유일한 수급이었는데, 그건 주체가 아니라 매매 방식입니다. 이 엔드포인트는
 * 하루 다섯 구간의 외국인 누적 순매수를 추정으로 줘서, 장중에 "외국인이 사고 있나"에
 * 답할 수 있게 합니다.
 *
 * **방향만 쓰고 크기는 쓰지 마세요.** 2026-08-21 거래대금 상위 38종목을 확정치와
 * 맞춰본 결과입니다.
 *
 *     확정 |순매수| 10만주 이상  19종목 → 부호 일치 19/19
 *     확정 |순매수| 10만주 미만  19종목 → 부호 일치 14/19
 *     오차 중앙값 47% (SK증권은 추정 -888,000 대 확정 -6,296,745)
 *
 * 큰 흐름의 방향은 어긋난 적이 없고, 작은 흐름은 절반 가까이 뒤집힙니다. 규모를 그대로
 * 인용하면 두 배 틀리는 것이 보통입니다. 삼성전자 한 종목(추정 1,222,000 대 확정
 * 1,567,350)만 보면 규모까지 맞는 것처럼 보이는데, 그건 운이 좋은 표본이었습니다.
 *
 * 같은 응답의 기관은 추정 -11,000 대 확정 +1,306,652로 부호부터 틀려서 **일부러
 * 버립니다**. 응답에 들어 있다는 이유로 저장해 두면 언젠가 누가 씁니다.
 *
 * 이 엔드포인트를 한 번 폐기 판정했던 적이 있는데, 휴장일 새벽에 불러 0행을 받고
 * "원래 비어 있다"고 결론지었기 때문입니다. 장이 열린 날에는 옵니다. 죽은 엔드포인트와
 * 닫힌 시장을 구분하려면 열려 있을 때 확인해야 합니다.
 */

const batchSize = 2;
const batchSpacingMs = 200;

function numeric(value) {
  // 응답이 000000000001222000, -00000000000011000 꼴로 옵니다. 앞의 0은 Number가
  // 알아서 떨어뜨리지만, 빈 문자열은 0이 아니라 없는 값이라 갈라둡니다.
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (text === "") return null;

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readForeignEstimate(config, token, symbol) {
  const url = new URL("/uapi/domestic-stock/v1/quotations/investor-trend-estimate", config.kis.baseUrl);

  url.searchParams.set("MKSC_SHRN_ISCD", symbol);

  const response = await fetch(url, {
    headers: {
      appkey: config.kis.appKey ?? "",
      appsecret: config.kis.appSecret ?? "",
      authorization: `Bearer ${token}`,
      custtype: "P",
      tr_id: "HHPTJ04160200"
    }
  });

  if (!response.ok) return [];

  const data = await response.json();

  if (data?.rt_cd && data.rt_cd !== "0") return [];

  return (data.output2 ?? [])
    .map((row) => ({
      bucket: numeric(row.bsop_hour_gb),
      foreignQty: numeric(row.frgn_fake_ntby_qty),
      symbol
    }))
    .filter((row) => Number.isInteger(row.bucket) && row.bucket > 0 && row.foreignQty !== null);
}

export async function saveForeignEstimate(config, { rows, sessionDate }) {
  if (rows.length === 0) return 0;

  // 구간을 처음 본 시각은 고치지 않습니다. 그 값이 발표 시각표를 알아내는 유일한
  // 단서이고, 폴링할 때마다 갱신하면 마지막 폴링 시각이 되어 버립니다.
  const result = await query(config, `
    INSERT INTO kr_foreign_estimate (symbol, session_date, bucket, foreign_qty)
    SELECT symbol, $2::date, bucket, foreign_qty
    FROM unnest($1::text[], $3::int[], $4::numeric[]) AS t(symbol, bucket, foreign_qty)
    ON CONFLICT (symbol, session_date, bucket) DO UPDATE
      SET foreign_qty = EXCLUDED.foreign_qty,
          fetched_at = now()
      WHERE kr_foreign_estimate.foreign_qty IS DISTINCT FROM EXCLUDED.foreign_qty
  `, [
    rows.map((row) => row.symbol),
    sessionDate,
    rows.map((row) => row.bucket),
    rows.map((row) => row.foreignQty)
  ]);

  return result.rowCount;
}

export async function collectForeignEstimate(config, symbols) {
  if (symbols.length === 0) return { answered: 0, rows: [] };

  const token = await getAccessToken(config);
  const rows = [];
  const answered = new Set();

  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map((symbol) => readForeignEstimate(config, token, symbol)));

    for (const result of settled) {
      if (result.status !== "fulfilled" || result.value.length === 0) continue;

      answered.add(result.value[0].symbol);
      rows.push(...result.value);
    }

    if (index + batchSize < symbols.length) await sleep(batchSpacingMs);
  }

  return { answered: answered.size, rows };
}
