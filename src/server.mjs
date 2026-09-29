import { createServer } from "node:http";
import { query } from "./db/client.mjs";
import { startMarketCollector } from "./collector.mjs";
import { loadSymbolThemes } from "./providers/naver-themes.mjs";
import { naverThemeMap, setNaverThemes } from "./providers/themes.mjs";
import { startUsPipelineScheduler } from "./pipeline/scheduler.mjs";
import { readConfig, hasTossCredentials } from "./config.mjs";
import { HttpError, readJsonBody, sendJson, sendNoContent } from "./http.mjs";
import { handleAppDataRoute } from "./routes/app-data.mjs";
import { getMarketBoard } from "./routes/market-board.mjs";
import { readNewsHeadlineEvents } from "./providers/news.mjs";
import { readSecDisclosureEvents } from "./providers/sec.mjs";
import { handleMediaRoute, serveUploadedMedia } from "./routes/media.mjs";
import { loadTossExchangeRate, loadTossLeaders } from "./providers/toss.mjs";

const config = readConfig();

function corsHeaders(request) {
  const requestOrigin = request?.headers.origin;
  const allowOrigin = config.frontendOrigins.includes(requestOrigin)
    ? requestOrigin
    : config.frontendOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": [
      "Content-Type",
      "Authorization",
      "X-Date-User-Provider",
      "X-Date-User-Id",
      "X-Date-User-Name",
      "X-Date-User-Email"
    ].join(","),
    "Vary": "Origin"
  };
}

function providerUnavailable() {
  return {
    provider: "toss",
    status: "mock",
    message: "Toss credentials are not configured"
  };
}

async function route(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const headers = corsHeaders(request);

  if (request.method === "OPTIONS") {
    sendNoContent(response, headers);
    return;
  }

  if (await serveUploadedMedia(config, request, response, url, headers)) {
    return;
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" }, headers);
      return;
    }

    sendJson(response, 200, {
      ok: true,
      service: "date-platform-backend",
      timestamp: new Date().toISOString()
    }, headers);
    return;
  }

  const mediaResult = await handleMediaRoute(config, request, url);

  if (mediaResult) {
    sendJson(response, mediaResult.status, mediaResult.body, headers);
    return;
  }

  const body = request.method === "POST" || request.method === "PATCH"
    ? await readJsonBody(request, { limitBytes: 1_000_000 })
    : {};
  const appDataResult = await handleAppDataRoute(config, request, url, body);

  if (appDataResult) {
    sendJson(response, appDataResult.status, appDataResult.body, headers);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" }, headers);
    return;
  }

  if (url.pathname === "/api/market-board") {
    sendJson(response, 200, await getMarketBoard(config), headers);
    return;
  }

  /*
   * 종목 -> 테마 사전 통째로.
   *
   * 같은 기계의 TodayStock market_watch.py가 급등 알림에 테마를 붙이려고 읽습니다.
   * 그쪽은 표준 라이브러리만 쓰는 파이썬이라 DB에 직접 붙을 수 없고, 네이버 사전을
   * 저마다 긁으면 "여러 테마 중 어느 것을 대표로 고르는가"가 두 벌이 됩니다 --
   * 고르는 규칙은 themes.mjs 한 곳에만 둡니다. 2,300줄 60KB쯤이라 매 알림이 아니라
   * 한 시간에 한 번 받아 두는 크기입니다.
   */
  if (url.pathname === "/api/themes/symbols") {
    const symbols = Object.fromEntries(naverThemeMap());

    /*
     * 오늘 상장한 종목도 같이 줍니다.
     *
     * market_watch.py가 급등 알림에서 이들을 빼기 위해서입니다. 상장 첫날은 전일
     * 종가가 없어 등락률에 비교 대상이 없고, 그 값을 다른 종목과 같은 축에 놓으면
     * 알림이 그 종목으로 덮입니다 -- 2026-09-29에 빅웨이브로보틱스(+84%)와
     * 글로벌테크놀로지(+71%)가 급등 알림 여덟 통 중 셋을 차지했고, 거래대금 1조도
     * 첫날 회전율이었습니다. 사용자가 그 알림을 보고 지적했습니다.
     *
     * 판별은 **어제까지의 일봉이 있는가**로 합니다. kr_listings.listed_on은 장중에
     * 못 씁니다 -- 오늘 상장한 종목이 아직 그 표에 없습니다(2026-09-29 빅웨이브
     * 0035S0). 같은 규칙을 leader-alert.mjs도 씁니다.
     *
     * 파이썬 쪽은 표준 라이브러리만 쓰므로 DB에 못 붙습니다. 그래서 이미 한 시간에
     * 한 번 받아 가는 이 응답에 얹습니다 -- 엔드포인트를 늘리면 그쪽도 호출을
     * 늘려야 하고, 둘이 따로 늙으면 어느 쪽이 맞는지 알 수 없게 됩니다.
     */
    let listedToday = [];

    try {
      const { rows } = await query(config, `
        SELECT DISTINCT s.symbol
          FROM market_price_samples s
         WHERE s.market = 'KR' AND s.session_date = current_date
           AND NOT EXISTS (
             SELECT 1 FROM kr_daily_bars b
              WHERE b.symbol = s.symbol AND b.session_date < current_date
           )`);

      listedToday = rows.map((row) => row.symbol);
    } catch (error) {
      // 사전은 돌려줘야 합니다. 이 목록이 비면 예전처럼 동작할 뿐입니다.
      console.warn("listed-today lookup failed", error instanceof Error ? error.message : error);
    }

    sendJson(response, 200, { count: Object.keys(symbols).length, listedToday, symbols }, headers);
    return;
  }

  // Headlines and filings first seen since the last board refresh.
  if (url.pathname === "/api/market-board/news-events") {
    sendJson(response, 200, { events: await readNewsHeadlineEvents() }, headers);
    return;
  }

  if (url.pathname === "/api/market-board/sec-events") {
    sendJson(response, 200, { events: await readSecDisclosureEvents() }, headers);
    return;
  }

  if (url.pathname === "/api/toss/leaders") {
    if (!hasTossCredentials(config)) {
      sendJson(response, 200, providerUnavailable(), headers);
      return;
    }

    const market = url.searchParams.get("market") === "US" ? "US" : "KR";

    sendJson(response, 200, {
      provider: "toss",
      market,
      leaders: await loadTossLeaders(config, market)
    }, headers);
    return;
  }

  if (url.pathname === "/api/toss/exchange-rate") {
    if (!hasTossCredentials(config)) {
      sendJson(response, 200, providerUnavailable(), headers);
      return;
    }

    sendJson(response, 200, await loadTossExchangeRate(
      config,
      url.searchParams.get("baseCurrency") ?? "USD",
      url.searchParams.get("quoteCurrency") ?? "KRW"
    ), headers);
    return;
  }

  sendJson(response, 404, { error: "not_found" }, headers);
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, {
        error: error.code ?? "request_error",
        message: error.message,
        details: error.details
      }, corsHeaders(request));
      return;
    }

    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, corsHeaders(request));
  }
});

server.listen(config.port, () => {
  console.log(`date-platform-backend listening on http://localhost:${config.port}`);

  if (!config.internalJwtSecret) {
    console.warn("INTERNAL_JWT_SECRET is not set. Falling back to trusted X-Date-User-* headers, which any client can forge. Set it before exposing this server.");
  }

  // Primed before the collector starts, so the first tick classifies with the
  // same dictionary as the thousandth. A failure here is not fatal: an empty
  // map classifies exactly as this did before the dictionary existed.
  loadSymbolThemes(config)
    .then((themes) => {
      const count = setNaverThemes(themes);

      console.log(`theme dictionary · ${count} symbols`);
    })
    .catch((error) => console.warn("theme dictionary unavailable", error instanceof Error ? error.message : error))
    .finally(() => {
      if (config.marketCollector) startMarketCollector(config);
      startUsPipelineScheduler(config);
    });
});
