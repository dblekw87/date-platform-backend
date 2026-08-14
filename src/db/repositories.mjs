import { query } from "./client.mjs";

function encodeCursor(row) {
  if (!row) return null;

  return Buffer.from(JSON.stringify({
    createdAt: row.created_at,
    id: row.id
  })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;

  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function pageLimit(value, fallback = 20) {
  const limit = Number(value);

  if (!Number.isFinite(limit)) return fallback;

  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}

export async function getProfile(config, userId) {
  const result = await query(config, `
    SELECT
      users.id,
      users.display_name,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      profiles.bio,
      profiles.interests,
      profiles.public_memo
    FROM users
    JOIN profiles ON profiles.user_id = users.id
    WHERE users.id = $1
  `, [userId]);

  return result.rows[0] ?? null;
}

export async function updateProfile(config, userId, input) {
  const result = await query(config, `
    UPDATE profiles
    SET
      nickname = COALESCE($2, nickname),
      avatar_url = COALESCE($3, avatar_url),
      bio = COALESCE($4, bio),
      interests = COALESCE($5, interests),
      public_memo = COALESCE($6, public_memo),
      updated_at = now()
    WHERE user_id = $1
    RETURNING user_id, nickname, avatar_url, bio, interests, public_memo
  `, [
    userId,
    input.nickname,
    input.avatarUrl,
    input.bio,
    input.interests,
    input.publicMemo
  ]);

  return result.rows[0] ?? null;
}

export async function createMediaAsset(config, userId, input) {
  const result = await query(config, `
    INSERT INTO media_assets (
      owner_user_id,
      usage_type,
      original_name,
      mime_type,
      storage_key,
      public_url
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, usage_type, original_name, mime_type, storage_key, public_url, created_at
  `, [
    userId,
    input.usageType,
    input.originalName,
    input.mimeType,
    input.storageKey,
    input.publicUrl
  ]);

  return result.rows[0];
}

export async function listCommunityPosts(config, { category, authorUserId, cursor, limit }) {
  const decoded = decodeCursor(cursor);
  const params = ["published", pageLimit(limit)];
  const filters = ["community_posts.status = $1"];

  if (category && category !== "전체") {
    params.push(category);
    filters.push(`community_posts.category = $${params.length}`);
  }

  if (authorUserId) {
    params.push(authorUserId);
    filters.push(`community_posts.author_user_id = $${params.length}`);
  }

  if (decoded?.createdAt && decoded?.id) {
    params.push(decoded.createdAt, decoded.id);
    filters.push(`(community_posts.created_at, community_posts.id) < ($${params.length - 1}, $${params.length})`);
  }

  const result = await query(config, `
    SELECT
      community_posts.id,
      community_posts.category,
      community_posts.title,
      community_posts.content_html,
      community_posts.view_count,
      community_posts.created_at,
      community_posts.updated_at,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      COUNT(community_comments.id)::int AS reply_count
    FROM community_posts
    JOIN users ON users.id = community_posts.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    LEFT JOIN community_comments ON community_comments.post_id = community_posts.id
    WHERE ${filters.join(" AND ")}
    GROUP BY community_posts.id, users.author_id, profiles.nickname, profiles.avatar_url
    ORDER BY community_posts.created_at DESC, community_posts.id DESC
    LIMIT $2
  `, params);
  const rows = result.rows;

  return {
    items: rows,
    nextCursor: rows.length === params[1] ? encodeCursor(rows.at(-1)) : null
  };
}

export async function getCommunityPost(config, id) {
  const result = await query(config, `
    SELECT
      community_posts.*,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url
    FROM community_posts
    JOIN users ON users.id = community_posts.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    WHERE community_posts.id = $1
  `, [id]);

  return result.rows[0] ?? null;
}

export async function createCommunityPost(config, userId, input) {
  const result = await query(config, `
    INSERT INTO community_posts (author_user_id, category, title, content_html)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [userId, input.category, input.title, input.contentHtml]);

  return result.rows[0];
}

export async function updateCommunityPost(config, id, userId, input) {
  const result = await query(config, `
    UPDATE community_posts
    SET
      category = COALESCE($3, category),
      title = COALESCE($4, title),
      content_html = COALESCE($5, content_html),
      updated_at = now()
    WHERE id = $1 AND author_user_id = $2
    RETURNING *
  `, [id, userId, input.category, input.title, input.contentHtml]);

  return result.rows[0] ?? null;
}

export async function listTradeJournals(config, { authorUserId, cursor, limit, visibility }) {
  const decoded = decodeCursor(cursor);
  const params = [pageLimit(limit)];
  const filters = [];

  if (visibility) {
    params.push(visibility);
    filters.push(`trade_journals.visibility = $${params.length}`);
  }

  if (authorUserId) {
    params.push(authorUserId);
    filters.push(`trade_journals.author_user_id = $${params.length}`);
  }

  if (decoded?.createdAt && decoded?.id) {
    params.push(decoded.createdAt, decoded.id);
    filters.push(`(trade_journals.created_at, trade_journals.id) < ($${params.length - 1}, $${params.length})`);
  }

  const result = await query(config, `
    SELECT
      trade_journals.*,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url
    FROM trade_journals
    JOIN users ON users.id = trade_journals.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY trade_journals.created_at DESC, trade_journals.id DESC
    LIMIT $1
  `, params);
  const rows = result.rows;

  return {
    items: rows,
    nextCursor: rows.length === params[0] ? encodeCursor(rows.at(-1)) : null
  };
}

export async function getTradeJournal(config, id, viewerUserId) {
  const result = await query(config, `
    SELECT
      trade_journals.*,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url
    FROM trade_journals
    JOIN users ON users.id = trade_journals.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    WHERE trade_journals.id = $1
  `, [id]);

  const journal = result.rows[0] ?? null;

  if (!journal) return null;
  if (journal.visibility === "private" && journal.author_user_id !== viewerUserId) return null;

  return journal;
}

export async function createTradeJournal(config, userId, input) {
  const result = await query(config, `
    INSERT INTO trade_journals (
      author_user_id,
      trade_date,
      title,
      result,
      visibility,
      buy_html,
      sell_html,
      good_html,
      bad_html
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    userId,
    input.tradeDate,
    input.title,
    input.result,
    input.visibility ?? "public",
    input.buyHtml,
    input.sellHtml,
    input.goodHtml,
    input.badHtml
  ]);

  return result.rows[0];
}

export async function updateTradeJournal(config, id, userId, input) {
  const result = await query(config, `
    UPDATE trade_journals
    SET
      trade_date = COALESCE($3, trade_date),
      title = COALESCE($4, title),
      result = COALESCE($5, result),
      visibility = COALESCE($6, visibility),
      buy_html = COALESCE($7, buy_html),
      sell_html = COALESCE($8, sell_html),
      good_html = COALESCE($9, good_html),
      bad_html = COALESCE($10, bad_html),
      updated_at = now()
    WHERE id = $1 AND author_user_id = $2
    RETURNING *
  `, [
    id,
    userId,
    input.tradeDate,
    input.title,
    input.result,
    input.visibility,
    input.buyHtml,
    input.sellHtml,
    input.goodHtml,
    input.badHtml
  ]);

  return result.rows[0] ?? null;
}

export async function getLatestMarketBoardSnapshot(config, mode = "licensed-live") {
  const result = await query(config, `
    SELECT payload
    FROM market_board_snapshots
    WHERE mode = $1
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY observed_at DESC
    LIMIT 1
  `, [mode]);

  return result.rows[0]?.payload ?? null;
}

export async function saveMarketBoardSnapshot(config, { mode, payload, ttlSeconds = 60 }) {
  const result = await query(config, `
    INSERT INTO market_board_snapshots (mode, payload, provider_statuses, expires_at)
    VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
    RETURNING id, observed_at, expires_at
  `, [
    mode,
    JSON.stringify(payload),
    JSON.stringify(payload.providerStatuses ?? []),
    String(ttlSeconds)
  ]);

  return result.rows[0];
}

export async function saveMarketDataSnapshot(config, input) {
  const result = await query(config, `
    INSERT INTO market_data_snapshots (
      provider,
      dataset,
      market,
      mode,
      source_url,
      source_license,
      payload,
      raw_payload,
      expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval)
    RETURNING id, observed_at, expires_at
  `, [
    input.provider,
    input.dataset,
    input.market ?? null,
    input.mode ?? "demo",
    input.sourceUrl ?? null,
    input.sourceLicense ?? null,
    JSON.stringify(input.payload),
    input.rawPayload ? JSON.stringify(input.rawPayload) : null,
    String(input.ttlSeconds ?? 60)
  ]);

  return result.rows[0];
}
