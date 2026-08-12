import { createServer } from "node:http";
import { readConfig, hasTossCredentials } from "./config.mjs";
import { HttpError, readJsonBody, sendJson, sendNoContent } from "./http.mjs";
import { handleAppDataRoute } from "./routes/app-data.mjs";
import { getMarketBoard } from "./routes/market-board.mjs";
import { loadTossExchangeRate, loadTossLeaders } from "./providers/toss.mjs";

const config = readConfig();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": config.frontendOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
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
  const headers = corsHeaders();

  if (request.method === "OPTIONS") {
    sendNoContent(response, headers);
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

  const body = request.method === "POST" || request.method === "PATCH"
    ? await readJsonBody(request)
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
        error: "upstream_error",
        message: error.message,
        details: error.details
      }, corsHeaders());
      return;
    }

    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, corsHeaders());
  }
});

server.listen(config.port, () => {
  console.log(`date-platform-backend listening on http://localhost:${config.port}`);
});
