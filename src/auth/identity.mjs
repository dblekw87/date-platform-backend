import { HttpError } from "../http.mjs";
import { verifyInternalToken } from "./internal-token.mjs";

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);

  const value = headers?.[name.toLowerCase()];

  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(request) {
  const authorization = String(headerValue(request.headers, "authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);

  return match?.[1];
}

function legacyHeaderIdentity(request) {
  const provider = headerValue(request.headers, "x-date-user-provider");

  if (!provider) return null;

  return {
    displayName: headerValue(request.headers, "x-date-user-name"),
    email: headerValue(request.headers, "x-date-user-email"),
    provider,
    providerUserId: headerValue(request.headers, "x-date-user-id")
  };
}

/**
 * Resolves the caller identity for a request.
 *
 * When INTERNAL_JWT_SECRET is configured the caller must present a valid
 * frontend-issued bearer token; the X-Date-User-* headers are ignored. Without
 * the secret the server falls back to those headers, which is only safe for
 * local development because any client can set them.
 *
 * Returns null for anonymous callers and throws 401 for a rejected token.
 */
export function resolveRequestIdentity(config, request) {
  if (!config.internalJwtSecret) {
    return legacyHeaderIdentity(request);
  }

  const token = bearerToken(request);

  if (!token) return null;

  const claims = verifyInternalToken(config.internalJwtSecret, token);

  if (!claims) {
    throw new HttpError(401, "Internal token is invalid or expired", undefined, "invalid_internal_token");
  }

  return {
    displayName: claims.name,
    email: claims.email,
    provider: claims.provider,
    providerUserId: claims.sub
  };
}
