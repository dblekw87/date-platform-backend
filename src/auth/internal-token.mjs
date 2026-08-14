import { createHmac, timingSafeEqual } from "node:crypto";

const expectedAudience = "date-platform-backend";
const expectedIssuer = "date-platform-frontend";
const clockSkewSeconds = 60;

function decodeSegment(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function signaturesMatch(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verifies an HS256 token issued by the frontend for internal service calls.
 * Returns the claims, or null when the token is absent, malformed, or expired.
 */
export function verifyInternalToken(secret, token) {
  const segments = String(token ?? "").split(".");

  if (segments.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = segments;
  const header = decodeSegment(encodedHeader);

  // Reject "none" and any algorithm the signature check below does not cover.
  if (header?.alg !== "HS256" || header?.typ !== "JWT") return null;

  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  if (!signaturesMatch(expectedSignature, signature)) return null;

  const claims = decodeSegment(encodedPayload);

  if (!claims) return null;
  if (claims.aud !== expectedAudience || claims.iss !== expectedIssuer) return null;

  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.iat === "number" && claims.iat > now + clockSkewSeconds) return null;
  if (!claims.provider || !claims.sub) return null;

  return claims;
}
