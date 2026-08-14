export class HttpError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new HttpError(response.status, `HTTP ${response.status}`, data);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new HttpError(response.status, `HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

export function sendNoContent(response, headers = {}) {
  response.writeHead(204, headers);
  response.end();
}

export async function readJsonBody(request, options = {}) {
  const limitBytes = options.limitBytes ?? 1_000_000;
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > limitBytes) {
      throw new HttpError(413, "Request body is too large", { limitBytes }, "payload_too_large");
    }

    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", undefined, "invalid_json");
  }
}
