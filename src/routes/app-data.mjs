import { ensureMockUser } from "../db/mock-auth.mjs";
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

export async function getCurrentUser(config) {
  return ensureMockUser(config);
}

export async function handleAppDataRoute(config, request, url, body) {
  const user = await getCurrentUser(config);

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
      body: await createCommunityPost(config, user.id, body)
    };
  }

  const communityPostMatch = url.pathname.match(/^\/api\/community\/posts\/([^/]+)$/);

  if (communityPostMatch && request.method === "GET") {
    const post = await getCommunityPost(config, communityPostMatch[1]);

    return post ? { status: 200, body: post } : { status: 404, body: { error: "not_found" } };
  }

  if (communityPostMatch && request.method === "PATCH") {
    const post = await updateCommunityPost(config, communityPostMatch[1], user.id, body);

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
      body: await createTradeJournal(config, user.id, body)
    };
  }

  const tradeJournalMatch = url.pathname.match(/^\/api\/trade-journals\/([^/]+)$/);

  if (tradeJournalMatch && request.method === "GET") {
    const journal = await getTradeJournal(config, tradeJournalMatch[1]);

    return journal ? { status: 200, body: journal } : { status: 404, body: { error: "not_found" } };
  }

  if (tradeJournalMatch && request.method === "PATCH") {
    const journal = await updateTradeJournal(config, tradeJournalMatch[1], user.id, body);

    return journal ? { status: 200, body: journal } : { status: 404, body: { error: "not_found_or_not_owner" } };
  }

  if (url.pathname === "/api/me/trade-journals" && request.method === "GET") {
    return {
      status: 200,
      body: await listTradeJournals(config, {
        authorUserId: user.id,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        visibility: "public"
      })
    };
  }

  return null;
}
