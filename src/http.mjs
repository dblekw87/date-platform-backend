export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
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

export async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  return text ? JSON.parse(text) : {};
}
