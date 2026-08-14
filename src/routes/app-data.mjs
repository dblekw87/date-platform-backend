import { resolveRequestIdentity } from "../auth/identity.mjs";
import { sanitizeHtml } from "../sanitize/html.mjs";
import { ensureUser } from "../db/users.mjs";
import {
  createCommunityPost,
  createTradeJournal,
  getCommunityPost,
  getProfile,
  getTradeJournal,
  listCommunityPosts,
  listTradeJournals,
  updateCommunityPost,
  updateProfile,
  updateTradeJournal
} from "../db/repositories.mjs";

const communityPostPattern = /^\/api\/community\/posts\/([^/]+)$/;
const tradeJournalPattern = /^\/api\/trade-journals\/([^/]+)$/;
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
    || tradeJournalPattern.test(pathname);
}

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
      body: await updateProfile(config, user.id, body)
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
      body: await createCommunityPost(config, user.id, sanitizeCommunityInput(body))
    };
  }

  const communityPostMatch = url.pathname.match(communityPostPattern);

  if (communityPostMatch && request.method === "GET") {
    const post = sanitizeCommunityRow(await getCommunityPost(config, communityPostMatch[1]));

    return post ? { status: 200, body: post } : { status: 404, body: { error: "not_found" } };
  }

  if (communityPostMatch && request.method === "PATCH") {
    const post = await updateCommunityPost(config, communityPostMatch[1], user.id, sanitizeCommunityInput(body));

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
      body: await createTradeJournal(config, user.id, sanitizeTradeJournalInput(body))
    };
  }

  const tradeJournalMatch = url.pathname.match(tradeJournalPattern);

  if (tradeJournalMatch && request.method === "GET") {
    const journal = sanitizeTradeJournalRow(await getTradeJournal(config, tradeJournalMatch[1], user?.id ?? null));

    return journal ? { status: 200, body: journal } : { status: 404, body: { error: "not_found" } };
  }

  if (tradeJournalMatch && request.method === "PATCH") {
    const journal = await updateTradeJournal(config, tradeJournalMatch[1], user.id, sanitizeTradeJournalInput(body));

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
