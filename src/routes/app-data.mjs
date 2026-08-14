import { resolveRequestIdentity } from "../auth/identity.mjs";
import { sanitizeHtml } from "../sanitize/html.mjs";
import { ensureUser } from "../db/users.mjs";
import {
  validateCommentInput,
  validateCommunityPostInput,
  validateProfileInput,
  validateTradeJournalInput
} from "../validate.mjs";
import {
  createCommunityComment,
  createCommunityPost,
  createTradeJournal,
  getCommunityPost,
  getProfile,
  getTradeJournal,
  listCommunityComments,
  listCommunityPosts,
  listTradeJournals,
  updateCommunityComment,
  updateCommunityPost,
  updateProfile,
  updateTradeJournal
} from "../db/repositories.mjs";

const communityPostPattern = /^\/api\/community\/posts\/([^/]+)$/;
const commentsPattern = /^\/api\/community\/posts\/([^/]+)\/comments$/;
const commentPattern = /^\/api\/community\/comments\/([^/]+)$/;
const tradeJournalPattern = /^\/api\/trade-journals\/([^/]+)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collectionPaths = new Set([
  "/api/community/posts",
  "/api/me",
  "/api/me/community-posts",
  "/api/me/profile",
  "/api/me/trade-journals",
  "/api/trade-journals"
]);

function isAppDataPath(pathname) {
  return collectionPaths.has(pathname)
    || communityPostPattern.test(pathname)
    || commentsPattern.test(pathname)
    || commentPattern.test(pathname)
    || tradeJournalPattern.test(pathname);
}

// Ids come from the URL and go straight into a uuid column, where a malformed
// value raises a database error instead of a clean 404.
function validId(value) {
  return uuidPattern.test(value);
}

const notFound = { status: 404, body: { error: "not_found" } };

// Reads of public collections stay open so signed-out visitors can browse.
// Everything else acts on behalf of a specific user and needs an identity.
function requiresIdentity(pathname, method) {
  return method !== "GET" || pathname.startsWith("/api/me");
}

// Leaves absent fields absent so PATCH keeps its COALESCE "unchanged" semantics.
function sanitizedField(value) {
  return typeof value === "string" ? sanitizeHtml(value) : value;
}

function sanitizeCommunityInput(input = {}) {
  return {
    ...input,
    contentHtml: sanitizedField(input.contentHtml)
  };
}

function sanitizeTradeJournalInput(input = {}) {
  return {
    ...input,
    badHtml: sanitizedField(input.badHtml),
    buyHtml: sanitizedField(input.buyHtml),
    goodHtml: sanitizedField(input.goodHtml),
    sellHtml: sanitizedField(input.sellHtml)
  };
}

// Rows written before sanitizing existed, so reads are cleaned on the way out too.
function sanitizeCommunityRow(row) {
  return row ? { ...row, content_html: sanitizedField(row.content_html) } : row;
}

function sanitizeTradeJournalRow(row) {
  if (!row) return row;

  return {
    ...row,
    bad_html: sanitizedField(row.bad_html),
    buy_html: sanitizedField(row.buy_html),
    good_html: sanitizedField(row.good_html),
    sell_html: sanitizedField(row.sell_html)
  };
}

export async function handleAppDataRoute(config, request, url, body) {
  if (!isAppDataPath(url.pathname)) return null;

  const identity = resolveRequestIdentity(config, request);

  if (!identity && requiresIdentity(url.pathname, request.method)) {
    return { status: 401, body: { error: "authentication_required" } };
  }

  const user = identity ? await ensureUser(config, identity) : null;

  if (url.pathname === "/api/me" && request.method === "GET") {
    return {
      status: 200,
      body: {
        user,
        profile: await getProfile(config, user.id)
      }
    };
  }

  if (url.pathname === "/api/me/profile" && request.method === "PATCH") {
    return {
      status: 200,
      body: await updateProfile(config, user.id, validateProfileInput(body))
    };
  }

  if (url.pathname === "/api/community/posts" && request.method === "GET") {
    return {
      status: 200,
      body: await listCommunityPosts(config, {
        category: url.searchParams.get("category"),
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit")
      })
    };
  }

  if (url.pathname === "/api/community/posts" && request.method === "POST") {
    return {
      status: 201,
      body: await createCommunityPost(config, user.id, sanitizeCommunityInput(validateCommunityPostInput(body)))
    };
  }

  const commentsMatch = url.pathname.match(commentsPattern);

  if (commentsMatch) {
    if (!validId(commentsMatch[1])) return notFound;

    if (request.method === "GET") {
      return { status: 200, body: await listCommunityComments(config, commentsMatch[1]) };
    }

    if (request.method === "POST") {
      const comment = await createCommunityComment(config, commentsMatch[1], user.id, validateCommentInput(body));

      return comment ? { status: 201, body: comment } : notFound;
    }
  }

  const commentMatch = url.pathname.match(commentPattern);

  if (commentMatch && request.method === "PATCH") {
    if (!validId(commentMatch[1])) return notFound;

    const comment = await updateCommunityComment(config, commentMatch[1], user.id, validateCommentInput(body, { partial: true }));

    return comment ? { status: 200, body: comment } : { status: 404, body: { error: "not_found_or_not_owner" } };
  }

  const communityPostMatch = url.pathname.match(communityPostPattern);

  if (communityPostMatch && !validId(communityPostMatch[1])) return notFound;

  if (communityPostMatch && request.method === "GET") {
    const post = sanitizeCommunityRow(await getCommunityPost(config, communityPostMatch[1], user?.id ?? null));

    return post ? { status: 200, body: post } : notFound;
  }

  if (communityPostMatch && request.method === "PATCH") {
    const post = await updateCommunityPost(
      config,
      communityPostMatch[1],
      user.id,
      sanitizeCommunityInput(validateCommunityPostInput(body, { partial: true }))
    );

    return post ? { status: 200, body: post } : { status: 404, body: { error: "not_found_or_not_owner" } };
  }

  if (url.pathname === "/api/me/community-posts" && request.method === "GET") {
    return {
      status: 200,
      body: await listCommunityPosts(config, {
        authorUserId: user.id,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit")
      })
    };
  }

  if (url.pathname === "/api/trade-journals" && request.method === "GET") {
    return {
      status: 200,
      body: await listTradeJournals(config, {
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        visibility: "public"
      })
    };
  }

  if (url.pathname === "/api/trade-journals" && request.method === "POST") {
    return {
      status: 201,
      body: await createTradeJournal(config, user.id, sanitizeTradeJournalInput(validateTradeJournalInput(body)))
    };
  }

  const tradeJournalMatch = url.pathname.match(tradeJournalPattern);

  if (tradeJournalMatch && !validId(tradeJournalMatch[1])) return notFound;

  if (tradeJournalMatch && request.method === "GET") {
    const journal = sanitizeTradeJournalRow(await getTradeJournal(config, tradeJournalMatch[1], user?.id ?? null));

    return journal ? { status: 200, body: journal } : notFound;
  }

  if (tradeJournalMatch && request.method === "PATCH") {
    const journal = await updateTradeJournal(
      config,
      tradeJournalMatch[1],
      user.id,
      sanitizeTradeJournalInput(validateTradeJournalInput(body, { partial: true }))
    );

    return journal ? { status: 200, body: journal } : { status: 404, body: { error: "not_found_or_not_owner" } };
  }

  if (url.pathname === "/api/me/trade-journals" && request.method === "GET") {
    return {
      status: 200,
      body: await listTradeJournals(config, {
        authorUserId: user.id,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit")
      })
    };
  }

  return { status: 405, body: { error: "method_not_allowed" } };
}
