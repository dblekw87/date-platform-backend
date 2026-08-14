import { createServer } from "node:http";
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
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
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
});
