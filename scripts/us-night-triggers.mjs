import fs from "node:fs";
import path from "node:path";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";
import { fetchJson } from "../src/http.mjs";

/**
 * 미국 밤 → 국내 다음날, 매일 장부.
 *
 *   node scripts/us-night-triggers.mjs            아침: 어젯밤 방아쇠와 기대값
 *   node scripts/us-night-triggers.mjs score [YYYY-MM-DD]   오후: 같은 날 채점
 *
 * 2026-11-01 사용자와 정한 미국 쪽 매일 학습. 전이 숫자들은 전부 과거 2년 백테스트이고
 * 실전에서 매일 맞는지는 한 번도 채점한 적이 없었습니다. 아침 학습 크론이 이걸 돌려
 * story-inference-log에 적고, 오후 채점 크론이 score로 같은 줄을 채점합니다.
 *
 * 방아쇠는 측정해서 살아남은 것만 넣었습니다(memory 메모 이름은 괄호):
 *
 *   SOX·나스닥 같은 방향/갈림 → 하이닉스·삼성     (us-to-kr-semis)
 *   미국 전력 바스켓 +3%      → 전력설비·원자력      (us-ai-infra-to-kr)
 *   미국 광통신 바스켓 +5%    → 국내 광통신 16종목   (us-ai-infra-to-kr 10-02 정정)
 *   BTC +5%                  → 가상화폐·블록체인    (us-to-kr-crypto, 표본 14일로 얇음)
 *
 * NVDA·미국 코인주는 방아쇠가 아니라고 반증됐으므로 넣지 않습니다.
 * 미국 일봉 표(us_daily_bars)는 하루 늦게 차는 날이 있어서 야후 일봉을 바로 읽습니다.
 * 판정이 아니라 기록입니다. 진입 권유로 쓰지 않습니다.
 */
const config = readConfig();
const logDir = path.resolve(import.meta.dirname, "..", "logs");
const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const baskets = {
  btc: ["BTC-USD"],
  nasdaq: ["^IXIC"],
  optical: ["AAOI", "LITE", "COHR", "CIEN", "FN", "CRDO", "POET"],
  power: ["VST", "CEG", "TLN", "NRG", "GEV", "PWR", "ETN"],
  sox: ["^SOX"]
};

const krGroups = {
  btc: { label: "가상화폐·블록체인", themes: /^(가상화폐|블록체인)/ },
  optical: { label: "국내 광통신", themes: /^광통신/ },
  power: { label: "전력설비·원자력", themes: /^(전력설비|원자력발전\()/ },
  semis: { label: "하이닉스·삼성전자", symbols: ["000660", "005930"] }
};

/* Expected next-day numbers from the backtests, so the log can compare live against them. */
const semisTable = {
  bothDown: "동반 하락 → 하이닉스 −1.40%, 삼성 −0.68%",
  bothUp: "동반 상승 → 하이닉스 +2.01%, 삼성 +1.17%",
  soxDownNasdaqUp: "갈림(SOX↓ 나스닥↑) → 하이닉스 +0.25%, 삼성 +0.57%",
  soxUpNasdaqDown: "갈림(SOX↑ 나스닥↓) → 하이닉스 +0.93%, 삼성 +0.28%"
};

async function lastSessionChange(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`;
  const data = await fetchJson(url, { headers: { "User-Agent": browserUserAgent }, timeoutMs: 8000 });
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const stamps = result?.timestamp ?? [];
  const bars = stamps.map((stamp, index) => ({ close: closes[index], stamp })).filter((bar) => typeof bar.close === "number");

  if (bars.length < 2) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  return {
    change: (last.close / prev.close - 1) * 100,
    day: new Date(last.stamp * 1000).toISOString().slice(0, 10),
    symbol
  };
}

async function basketChange(symbols) {
  const settled = await Promise.allSettled(symbols.map(lastSessionChange));
  const rows = settled.filter((item) => item.status === "fulfilled" && item.value).map((item) => item.value);

  if (rows.length === 0) return null;

  const day = rows.map((row) => row.day).sort().at(-1);
  const fresh = rows.filter((row) => row.day === day);
  const mean = fresh.reduce((sum, row) => sum + row.change, 0) / fresh.length;

  return { change: Number(mean.toFixed(2)), count: fresh.length, day, of: symbols.length };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length === 0) return null;

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function signed(value) {
  if (value === null || value === undefined) return "—";

  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

async function morning() {
  const entries = await Promise.all(Object.entries(baskets).map(async ([id, symbols]) => [id, await basketChange(symbols)]));
  const night = Object.fromEntries(entries);
  const fired = [];

  if (night.sox && night.nasdaq) {
    const soxUp = night.sox.change > 0;
    const nasdaqUp = night.nasdaq.change > 0;
    const key = soxUp && nasdaqUp ? "bothUp" : !soxUp && !nasdaqUp ? "bothDown" : soxUp ? "soxUpNasdaqDown" : "soxDownNasdaqUp";

    fired.push({ expect: semisTable[key], group: "semis", key });
  }

  if (night.power?.change >= 3) {
    fired.push({ expect: "전력설비 +0.49%p(65%), 원자력 +0.79%p, 하이닉스 +1.65%p(75%) — 시장 대비", group: "power", key: "power+3" });
  }

  if (night.optical?.change >= 5) {
    const soxStrong = (night.sox?.change ?? 0) > 0;

    fired.push({
      expect: soxStrong ? "광통신 강·반도체 강 → 국내 광통신 +1.67%p(70%)" : "광통신 강·반도체 약 → 국내 광통신 +2.43%p(78%) ← 가장 선명",
      group: "optical",
      key: "optical+5"
    });
  }

  if (night.btc?.change >= 5) {
    fired.push({ expect: "국내 코인 지분·발행 계열 중앙 +1.41%(64%) — 표본 14일, 얇음", group: "btc", key: "btc+5" });
  }

  const record = { fired, krDay: kstToday, night, writtenAt: new Date().toISOString() };

  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `us-triggers-${kstToday}.json`), JSON.stringify(record, null, 2));

  const usDay = night.sox?.day ?? night.nasdaq?.day ?? "?";

  console.log(`미국 밤(${usDay}) → 국내 ${kstToday}`);
  console.log(`  SOX ${signed(night.sox?.change)}% · 나스닥 ${signed(night.nasdaq?.change)}% · 전력 바스켓 ${signed(night.power?.change)}% (${night.power?.count ?? 0}/${baskets.power.length}) · 광통신 바스켓 ${signed(night.optical?.change)}% (${night.optical?.count ?? 0}/${baskets.optical.length}) · BTC ${signed(night.btc?.change)}%`);

  for (const item of fired) console.log(`  ▶ ${krGroups[item.group].label}: ${item.expect}`);

  if (!fired.some((item) => item.group !== "semis")) console.log("  전력·광통신·BTC 방아쇠 없음");
}

async function score(day) {
  const file = path.join(logDir, `us-triggers-${day}.json`);

  if (!fs.existsSync(file)) {
    console.log(`${day}: 아침 기록(${path.basename(file)})이 없어 채점할 것이 없습니다.`);
    return;
  }

  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const { rows: universe } = await query(config, `
    SELECT symbol, change_rate::float8 r FROM kr_daily_universe
     WHERE session_date = $1 AND NOT trade_halted AND close_price > 0 AND change_rate IS NOT NULL
  `, [day]);

  if (universe.length === 0) {
    console.log(`${day}: kr_daily_universe가 아직 비어 있습니다(15:50 수집 전이거나 휴장).`);
    return;
  }

  const market = universe.reduce((sum, row) => sum + row.r, 0) / universe.length;
  const bySymbol = new Map(universe.map((row) => [row.symbol, row.r]));
  const { rows: members } = await query(config, "SELECT DISTINCT symbol, theme_name FROM kr_theme_membership");

  console.log(`${day} 채점 · 시장(전 종목 평균 ${universe.length}개) ${signed(market)}%`);

  for (const item of record.fired) {
    const group = krGroups[item.group];
    const symbols = group.symbols ?? [...new Set(members.filter((row) => group.themes.test(row.theme_name)).map((row) => row.symbol))];
    const changes = symbols.map((symbol) => bySymbol.get(symbol)).filter((value) => typeof value === "number");
    const mid = median(changes);
    const excess = mid === null ? null : mid - market;
    const detail = group.symbols ? group.symbols.map((symbol) => `${symbol} ${signed(bySymbol.get(symbol))}`).join(", ") : `${changes.length}종목 중앙 ${signed(mid)}`;

    console.log(`  ${group.label}: ${detail} → 시장 대비 ${signed(excess)}%p · 기대 ${item.expect}`);
  }
}

if (process.argv[2] === "score") {
  await score(process.argv[3] ?? kstToday);
} else {
  await morning();
}

process.exit(0);
