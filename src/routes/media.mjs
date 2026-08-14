import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "../http.mjs";
import { createMediaAsset } from "../db/repositories.mjs";
import { resolveRequestIdentity } from "../auth/identity.mjs";
import { ensureUser } from "../db/users.mjs";

const allowedMimeTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);
const extensionMimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);
const maxUploadBytes = 5 * 1024 * 1024;

// The declared Content-Type is attacker-controlled, so the bytes decide.
const magicNumbers = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] }
];

function detectMimeType(buffer) {
  const matched = magicNumbers.find(({ bytes }) =>
    bytes.every((byte, index) => buffer[index] === byte));

  if (matched) return matched.mimeType;

  // WebP is "RIFF" + 4 size bytes + "WEBP".
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }

  return undefined;
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);

  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }

  parts.push(buffer.subarray(start));

  return parts;
}

function parseContentDisposition(value) {
  const fields = {};

  for (const part of value.split(";").map((item) => item.trim())) {
    const [key, rawValue] = part.split("=");

    if (!rawValue) continue;

    fields[key.toLowerCase()] = rawValue.replace(/^"|"$/g, "");
  }

  return fields;
}

async function readRequestBuffer(request, limitBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > limitBytes) {
      throw new HttpError(413, "Upload is too large", { limitBytes }, "payload_too_large");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function parseMultipart(request) {
  const contentType = request.headers["content-type"] ?? "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    throw new HttpError(400, "Multipart boundary is missing", undefined, "invalid_multipart");
  }

  const buffer = await readRequestBuffer(request, maxUploadBytes + 128 * 1024);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, boundaryBuffer);
  const fields = {};
  let file;

  for (const rawPart of parts) {
    let part = rawPart;

    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));

    if (headerEnd === -1) continue;

    const headersText = part.subarray(0, headerEnd).toString("latin1");
    const body = part.subarray(headerEnd + 4);
    const headers = Object.fromEntries(
      headersText.split("\r\n").map((line) => {
        const separatorIndex = line.indexOf(":");

        return [
          line.slice(0, separatorIndex).trim().toLowerCase(),
          line.slice(separatorIndex + 1).trim()
        ];
      })
    );
    const disposition = parseContentDisposition(headers["content-disposition"] ?? "");

    if (!disposition.name) continue;

    if (disposition.filename) {
      file = {
        buffer: body,
        filename: disposition.filename,
        mimeType: headers["content-type"] ?? "application/octet-stream"
      };
    } else {
      fields[disposition.name] = body.toString("utf8");
    }
  }

  return { fields, file };
}

function safeUsageType(value) {
  const usageType = String(value ?? "community").trim().toLowerCase();

  if (["profile", "community", "trade-journal"].includes(usageType)) return usageType;

  return "community";
}

function safeOriginalName(value) {
  return String(value ?? "upload")
    .replace(/[^\w.\-가-힣 ]+/g, "")
    .trim()
    .slice(0, 120) || "upload";
}

function publicUrl(config, storageKey) {
  return `${config.publicBaseUrl.replace(/\/+$/g, "")}/uploads/${storageKey}`;
}

function uploadPath(config, storageKey) {
  const uploadRoot = resolve(config.uploadDir);
  const targetPath = resolve(join(uploadRoot, storageKey));

  if (targetPath !== uploadRoot && !targetPath.startsWith(`${uploadRoot}${sep}`)) {
    throw new HttpError(400, "Invalid upload path", undefined, "invalid_upload_path");
  }

  return { targetPath, uploadRoot };
}

export async function handleMediaRoute(config, request, url) {
  if (url.pathname !== "/api/media") return null;

  if (request.method !== "POST") {
    return {
      status: 405,
      body: { error: "method_not_allowed" }
    };
  }

  const identity = resolveRequestIdentity(config, request);

  if (!identity) {
    return {
      status: 401,
      body: { error: "authentication_required" }
    };
  }

  const { fields, file } = await parseMultipart(request);

  if (!file) {
    throw new HttpError(400, "File field is required", undefined, "file_required");
  }

  const detectedMimeType = detectMimeType(file.buffer);
  const extension = detectedMimeType ? allowedMimeTypes.get(detectedMimeType) : undefined;

  if (!extension) {
    throw new HttpError(
      415,
      "Only image uploads are supported",
      { declared: file.mimeType, detected: detectedMimeType ?? "unknown" },
      "unsupported_media_type"
    );
  }

  if (file.buffer.length > maxUploadBytes) {
    throw new HttpError(413, "Upload is too large", { limitBytes: maxUploadBytes }, "payload_too_large");
  }

  const user = await ensureUser(config, identity);
  const usageType = safeUsageType(fields.usageType);
  const storageKey = `${usageType}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
  const { targetPath } = uploadPath(config, storageKey);

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, file.buffer);

  const asset = await createMediaAsset(config, user.id, {
    mimeType: detectedMimeType,
    originalName: safeOriginalName(file.filename),
    publicUrl: publicUrl(config, storageKey),
    storageKey,
    usageType
  });

  return {
    status: 201,
    body: {
      asset
    }
  };
}

export async function serveUploadedMedia(config, request, response, url, headers) {
  if (!url.pathname.startsWith("/uploads/")) return false;

  if (request.method !== "GET") {
    response.writeHead(405, headers);
    response.end();
    return true;
  }

  const storageKey = decodeURIComponent(url.pathname.replace(/^\/uploads\/+/, ""));
  const { targetPath } = uploadPath(config, storageKey);
  const mimeType = extensionMimeTypes.get(extname(targetPath).toLowerCase()) ?? "application/octet-stream";

  try {
    const fileStat = await stat(targetPath);
    const data = await readFile(targetPath);

    response.writeHead(200, {
      ...headers,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": fileStat.size,
      "Content-Type": mimeType,
      // Stops a browser from re-interpreting a stored file as markup.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline"
    });
    response.end(data);
  } catch {
    response.writeHead(404, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify({ error: "not_found" }));
  }

  return true;
}
