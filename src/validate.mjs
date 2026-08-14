import { HttpError } from "./http.mjs";

/**
 * Request body validation.
 *
 * Without this the database constraints do the rejecting, which surfaces as a
 * 500 for what is really a client mistake. Each validator returns only the
 * fields it recognizes, so unexpected keys cannot reach the SQL layer.
 *
 * `partial` mode is for PATCH: absent fields stay absent so the repository's
 * COALESCE keeps the stored value.
 */

const communityCategories = new Set(["질문", "조언", "시황", "뉴스", "테마", "잡담"]);
const journalVisibilities = new Set(["public", "private"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
// 24-hour only, no meridiem. 24:00 is accepted for midnight at the close of a
// session, which PostgreSQL's time type stores as-is.
const timePattern = /^(([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?|24:00(:00)?)$/;

function fail(field, message) {
  throw new HttpError(400, message, { field }, "invalid_request");
}

function requiredText(value, field, { max, min = 1 }) {
  if (typeof value !== "string") fail(field, `${field} is required`);

  const text = value.trim();

  if (text.length < min) fail(field, `${field} must not be empty`);
  if (text.length > max) fail(field, `${field} must be at most ${max} characters`);

  return text;
}

function optionalText(value, field, { max }) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(field, `${field} must be a string`);
  if (value.length > max) fail(field, `${field} must be at most ${max} characters`);

  return value;
}

function enumValue(value, field, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(field, `${field} must be one of ${[...allowed].join(", ")}`);
  }

  return value;
}

function isoDate(value, field) {
  if (typeof value !== "string" || !datePattern.test(value)) {
    fail(field, `${field} must be a YYYY-MM-DD date`);
  }

  // Catches 2026-02-31, which matches the pattern but is not a real date.
  const parsed = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    fail(field, `${field} is not a valid date`);
  }

  return value;
}

// Optional: an author may not remember the exact minute, and an empty input
// submits "". Both mean "no time recorded" rather than a validation failure.
function optionalTime(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !timePattern.test(value.trim())) {
    fail(field, `${field} must be a 24-hour HH:MM time`);
  }

  return value.trim().slice(0, 5);
}

function withField(target, key, value) {
  if (value !== undefined) target[key] = value;

  return target;
}

export function validateCommunityPostInput(body = {}, { partial = false } = {}) {
  const input = {};

  if (!partial || body.category !== undefined) {
    input.category = enumValue(body.category, "category", communityCategories);
  }

  if (!partial || body.title !== undefined) {
    input.title = requiredText(body.title, "title", { max: 200 });
  }

  if (!partial || body.contentHtml !== undefined) {
    input.contentHtml = requiredText(body.contentHtml, "contentHtml", { max: 200_000 });
  }

  return input;
}

export function validateTradeJournalInput(body = {}, { partial = false } = {}) {
  const input = {};

  if (!partial || body.tradeDate !== undefined) input.tradeDate = isoDate(body.tradeDate, "tradeDate");
  if (!partial || body.title !== undefined) input.title = requiredText(body.title, "title", { max: 200 });
  if (!partial || body.result !== undefined) input.result = requiredText(body.result, "result", { max: 50 });

  if (body.visibility !== undefined) {
    input.visibility = enumValue(body.visibility, "visibility", journalVisibilities);
  } else if (!partial) {
    input.visibility = "public";
  }

  if (!partial || body.buyTime !== undefined) input.buyTime = optionalTime(body.buyTime, "buyTime");
  if (!partial || body.sellTime !== undefined) input.sellTime = optionalTime(body.sellTime, "sellTime");

  ["badHtml", "buyHtml", "goodHtml", "sellHtml"].forEach((field) => {
    if (partial && body[field] === undefined) return;

    input[field] = requiredText(body[field], field, { max: 200_000 });
  });

  return input;
}

export function validateProfileInput(body = {}) {
  const input = {};

  withField(input, "avatarUrl", optionalText(body.avatarUrl, "avatarUrl", { max: 2000 }));
  withField(input, "bio", optionalText(body.bio, "bio", { max: 300 }));
  withField(input, "interests", optionalText(body.interests, "interests", { max: 300 }));
  withField(input, "publicMemo", optionalText(body.publicMemo, "publicMemo", { max: 2000 }));

  if (body.nickname !== undefined) {
    input.nickname = requiredText(body.nickname, "nickname", { max: 40 });
  }

  return input;
}

export function validateCommentInput(body = {}, { partial = false } = {}) {
  const input = {};

  if (!partial || body.body !== undefined) {
    input.body = requiredText(body.body, "body", { max: 2000 });
  }

  return input;
}
