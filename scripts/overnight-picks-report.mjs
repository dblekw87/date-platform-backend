import { tierOf } from "../src/providers/overnight-rank.mjs";

/**
 * 터미널로 읽는 쪽.
 *
 * 알림 쪽 문구는 material-alert.mjs에 따로 있습니다. 한 벌로 합치려다 말았는데,
 * 터미널은 폭이 넓고 알림은 한 줄이 짧아야 해서 같은 글이 양쪽 다 나쁩니다.
 *
 * 근거를 후보 밑에 같이 적습니다. 종목 코드만 늘어놓은 목록은 다음 날 아침에
 * 왜 골랐는지 되짚을 수 없고, 되짚을 수 없으면 틀렸을 때 무엇을 고쳐야 하는지도
 * 알 수 없습니다.
 */

const won = (value) => (value === null || value === undefined ? "?" : Number(value).toLocaleString("ko-KR"));

export function printPicks(picks, window, target) {
  console.log("");
  console.log(`주말 재료 후보 · ${target} 장 대상`);
  console.log(`창 ${window.from.toISOString().slice(0, 16)}Z ~ ${window.to.toISOString().slice(0, 16)}Z (직전 거래일 ${window.previous} 15:40부터)`);
  console.log("");

  if (!picks.length) {
    console.log("  조건을 넘은 후보가 없습니다. 재료 없는 주말입니다.");

    return;
  }

  for (const [index, pick] of picks.entries()) {
    const listing = pick.listing;

    console.log(
      `${String(index + 1).padStart(2)}. [${tierOf(pick)}] ${listing.name} (${pick.symbol}) · ${listing.market}`
      + ` · 종가 ${won(listing.close_price)}원 ${listing.change_rate > 0 ? "+" : ""}${listing.change_rate}%`
      + ` · 거래대금 ${(listing.turnover / 1e8).toFixed(0)}억`
    );

    for (const filing of pick.good.slice(0, 3)) {
      console.log(`      공시 ${filing.title.split("·").pop().trim().slice(0, 62)}`);
    }

    for (const article of pick.material.slice(0, 3)) {
      console.log(`      뉴스 ${article.headline.slice(0, 62)}`);
    }

    if (pick.sourceCount > 1) console.log(`      매체 ${pick.sourceCount}곳`);

    console.log("");
  }
}
