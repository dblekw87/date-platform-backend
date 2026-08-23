import { query } from "../db/client.mjs";

/**
 * 후보 종목마다 "밤에 볼 미국 지표"를 붙입니다.
 *
 * 종가배팅도 짝꿍매매도 오늘 종가에 사서 밤을 넘깁니다. 그런데 화면이 밤 맥락으로
 * 내놓는 것은 나스닥 선물 하나뿐이었습니다. 나스닥은 시장 전체의 밤이지 이 종목의
 * 밤이 아닙니다 -- 반도체 후보에게는 SOX가, 코인 후보에게는 비트코인이 더 맞는
 * 지표라는 것을 이미 재 놨는데도 화면은 그 답을 모르고 있었습니다.
 *
 * 여기 있는 두 갈래는 측정된 것만입니다. 나머지 테마는 `null`이고 화면은 나스닥만
 * 말합니다 -- 근거 없는 짝을 지어 주는 것보다 아무 말도 안 하는 편이 낫습니다.
 *
 * **강도가 서로 다릅니다.** 반도체는 2년 500거래일에 상관 0.42로 제법 단단하고,
 * 코인은 상관 0.24에 BTC +5% 표본이 14일뿐입니다. 화면이 그 차이를 같이 말하도록
 * `strength`를 함께 내보냅니다.
 */

/**
 * 반도체 — SOX가 나스닥보다 큽니다.
 *
 *   하이닉스 ~ SOX 0.423   vs   ~ NASDAQ 0.357
 *   삼성전자 ~ SOX 0.341   vs   ~ NASDAQ 0.280
 *
 * 더 쓸모 있는 것은 **둘이 갈릴 때**입니다. 동반 상승한 밤 다음 하이닉스가 +2.01%인데
 * 갈린 밤 다음에는 +0.93%·+0.25%로 반토막 이하입니다.
 */
const soxThemes = /반도체|시스템반도체|웨이퍼|파운드리/;

/**
 * 가상화폐 — 미국 코인주가 아니라 BTC 자체입니다.
 *
 *   BTC +5%↑     14일   국내 중앙값 +1.41%   상승 64%
 *   미국 코인주 +5%↑  68일   국내 중앙값 +0.56%   상승 51%
 *
 * 전자결제·핀테크·NFT는 뺐습니다. 사전 101종목으로 재면 미국 코인주가 오른 다음날
 * 국내 상승 3위가 **삼성전자**로 나옵니다 -- 그냥 시장이 좋은 날이었다는 뜻입니다.
 * 실제로 반응하는 것은 지분·창투사·발행 계열이고, 뱅크웨어글로벌·형지글로벌 같은
 * 결제 쪽은 반응이 없습니다.
 */
const btcThemes = /가상화폐|블록체인|스테이블코인|토큰증권|두나무/;

const triggers = [
  { id: "sox", pattern: soxThemes, strength: "measured" },
  { id: "btc", pattern: btcThemes, strength: "thin" }
];

/**
 * 종목별 트리거. 테마를 하나만 고르지 않고 붙어 있는 것을 전부 봅니다 --
 * `classifyTheme`은 종목당 대표 테마 하나만 주는데, 우리기술투자는 STO·가상화폐·
 * 두나무·창투사를 달고 있어도 대표 하나만 보면 놓칠 수 있습니다.
 */
export async function loadNightTriggers(config, symbols) {
  const wanted = [...new Set(symbols.filter(Boolean))];

  if (!config.databaseUrl || wanted.length === 0) return new Map();

  const { rows } = await query(
    config,
    "SELECT symbol, array_agg(theme_name) AS themes FROM kr_theme_members WHERE symbol = ANY($1::text[]) GROUP BY symbol",
    [wanted]
  );

  return new Map(rows.flatMap((row) => {
    const joined = (row.themes ?? []).join(" ");
    const hit = triggers.find((trigger) => trigger.pattern.test(joined));

    return hit ? [[row.symbol, { id: hit.id, strength: hit.strength }]] : [];
  }));
}
