import { loadShortVolume, saveShortVolume, storedShortVolumeDates } from "../src/providers/short-volume.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * FINRA 일별 공매도 거래량을 소급 수집합니다.
 *
 * 하루에 파일 하나이고 키가 없습니다. 이미 저장된 날짜는 건너뛰므로 매일 돌려도
 * 새 파일만 받습니다.
 *
 *   npm run us:short-volume
 *   npm run us:short-volume -- --days=60
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? Number(match.slice(prefix.length)) : fallback;
}

const config = readConfig();
const days = readOption("days", 30);
const stored = await storedShortVolumeDates(config);
const today = new Date();
let saved = 0;
let files = 0;

console.log(`\nFINRA 일별 공매도 · 최근 ${days}일 · 이미 있는 날 ${stored.size}일`);

for (let back = 1; back <= days; back += 1) {
  const date = new Date(today);

  date.setUTCDate(date.getUTCDate() - back);

  const sessionDate = date.toISOString().slice(0, 10);

  if (stored.has(sessionDate)) continue;

  const rows = await loadShortVolume(sessionDate);

  if (rows.length === 0) continue;

  const written = await saveShortVolume(config, rows);

  files += 1;
  saved += written;
  console.log(`  ${sessionDate}  ${rows.length.toLocaleString("ko-KR")}종목 · ${written}행`);
}

console.log(`\n  파일 ${files}개 · ${saved.toLocaleString("ko-KR")}행 저장\n`);
process.exit(0);
