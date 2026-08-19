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

export async function listCommunityPosts(config, { category, authorUserId, cursor, limit, search }) {
  const decoded = decodeCursor(cursor);
  const params = ["published", pageLimit(limit)];
  const filters = ["community_posts.status = $1"];

  if (category && category !== "전체") {
    params.push(category);
    filters.push(`community_posts.category = $${params.length}`);
  }

  // Titles are what readers scan, so search matches those rather than markup.
  if (search) {
    params.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    filters.push(`community_posts.title ILIKE $${params.length}`);
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

export async function getCommunityPost(config, id, viewerUserId = null) {
  const result = await query(config, `
    SELECT
      community_posts.*,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      COALESCE(community_posts.author_user_id = $2, false) AS is_owner,
      (SELECT COUNT(*)::int FROM community_comments WHERE post_id = community_posts.id) AS reply_count
    FROM community_posts
    JOIN users ON users.id = community_posts.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    WHERE community_posts.id = $1
  `, [id, viewerUserId]);

  return result.rows[0] ?? null;
}

export async function listCommunityComments(config, postId, viewerUserId = null) {
  const result = await query(config, `
    SELECT
      community_comments.id,
      community_comments.body,
      community_comments.created_at,
      community_comments.updated_at,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      COALESCE(community_comments.author_user_id = $2, false) AS is_owner
    FROM community_comments
    JOIN users ON users.id = community_comments.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    WHERE community_comments.post_id = $1
    ORDER BY community_comments.created_at ASC
  `, [postId, viewerUserId]);

  return { items: result.rows };
}

export async function createCommunityComment(config, postId, userId, input) {
  const result = await query(config, `
    WITH inserted AS (
      INSERT INTO community_comments (post_id, author_user_id, body)
      SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM community_posts WHERE id = $1)
      RETURNING *
    )
    SELECT
      inserted.id,
      inserted.body,
      inserted.created_at,
      inserted.updated_at,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      true AS is_owner
    FROM inserted
    JOIN users ON users.id = inserted.author_user_id
    JOIN profiles ON profiles.user_id = users.id
  `, [postId, userId, input.body]);

  return result.rows[0] ?? null;
}

export async function deleteCommunityComment(config, id, userId) {
  const result = await query(config, `
    DELETE FROM community_comments
    WHERE id = $1 AND author_user_id = $2
    RETURNING id
  `, [id, userId]);

  return result.rows[0] ?? null;
}

/**
 * Counted on read, and never for the author, so opening your own post to check
 * it does not inflate the number.
 */
export async function recordCommunityPostView(config, id, viewerUserId) {
  await query(config, `
    UPDATE community_posts
    SET view_count = view_count + 1
    WHERE id = $1 AND ($2::uuid IS NULL OR author_user_id <> $2)
  `, [id, viewerUserId]);
}

export async function updateCommunityComment(config, id, userId, input) {
  const result = await query(config, `
    UPDATE community_comments
    SET body = COALESCE($3, body), updated_at = now()
    WHERE id = $1 AND author_user_id = $2
    RETURNING id, body, created_at, updated_at
  `, [id, userId, input.body]);

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

export async function getTradeJournal(config, id, viewerUserId = null) {
  const result = await query(config, `
    SELECT
      trade_journals.*,
      users.author_id,
      profiles.nickname,
      profiles.avatar_url,
      COALESCE(trade_journals.author_user_id = $2, false) AS is_owner
    FROM trade_journals
    JOIN users ON users.id = trade_journals.author_user_id
    JOIN profiles ON profiles.user_id = users.id
    WHERE trade_journals.id = $1
  `, [id, viewerUserId]);

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
      buy_time,
      sell_time,
      title,
      result,
      visibility,
      buy_html,
      sell_html,
      good_html,
      bad_html
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [
    userId,
    input.tradeDate,
    input.buyTime ?? null,
    input.sellTime ?? null,
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
  // COALESCE cannot express "clear this field", so the times carry an explicit
  // provided flag: absent means leave it alone, present-and-null means erase it.
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
      buy_time = CASE WHEN $11 THEN $12::time ELSE buy_time END,
      sell_time = CASE WHEN $13 THEN $14::time ELSE sell_time END,
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
    input.badHtml,
    "buyTime" in input,
    input.buyTime ?? null,
    "sellTime" in input,
    input.sellTime ?? null
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

/**
 * A snapshot is written on every refresh, so without this the table grows
 * without bound. The newest expired row per mode is kept as the fallback that
 * demo mode reads when no live snapshot exists.
 */
export async function pruneMarketBoardSnapshots(config, { keepPerMode = 1 } = {}) {
  const result = await query(config, `
    DELETE FROM market_board_snapshots
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id, row_number() OVER (PARTITION BY mode ORDER BY observed_at DESC) AS position
        FROM market_board_snapshots
      ) ranked
      WHERE ranked.position > $1
    )
  `, [keepPerMode]);

  return result.rowCount;
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

/**
 * Absent stays absent.
 *
 * Number(null) is 0 and so is Number(""), and both are finite, so the obvious
 * version of this turned every missing measurement into a measured zero. Found
 * when Yahoo reported no extended-hours volume and 432 rows landed claiming
 * nothing had traded in a pre-market where prices doubled.
 */
function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Appends one moment of the market to the time series.
 *
 * Written as a single multi-row insert because a sample covers sixty stocks and
 * a round trip each would take longer than the interval between samples. The
 * unique constraint absorbs a repeated tick rather than doubling a minute.
 *
 * `ranked` says whether the position in `stocks` means anything. The leader list
 * is an order and that is what it is for; the follower pass is not one, and
 * writing 1..37 into leader_rank would put a ranking in the column that nobody
 * produced.
 */
export async function saveMarketPriceSamples(config, { market, observedAt, ranked = true, sessionDate, source, stocks }) {
  if (!config.databaseUrl || stocks.length === 0) return 0;

  const columns = 11;
  const values = stocks.flatMap((stock, index) => [
    market,
    stock.symbol,
    stock.name ?? null,
    sessionDate,
    observedAt,
    numericOrNull(stock.changeRateValue),
    numericOrNull(stock.turnoverValue),
    numericOrNull(stock.volumeValue),
    stock.theme ?? null,
    ranked ? index + 1 : null,
    numericOrNull(stock.marketCapValue)
  ]);
  const rows = stocks
    .map((stock, index) => `($${index * columns + 1}, $${index * columns + 2}, $${index * columns + 3}, $${index * columns + 4}, $${index * columns + 5}, $${index * columns + 6}, $${index * columns + 7}, $${index * columns + 8}, $${index * columns + 9}, $${index * columns + 10}, $${index * columns + 11}, $${stocks.length * columns + 1})`)
    .join(", ");
  const result = await query(config, `
    INSERT INTO market_price_samples (
      market, symbol, name, session_date, observed_at,
      change_rate, turnover, volume, theme, leader_rank, market_cap, source
    )
    VALUES ${rows}
    ON CONFLICT (market, symbol, observed_at) DO NOTHING
  `, [...values, source ?? "unknown"]);

  return result.rowCount;
}

/**
 * Keeps the headlines the board showed, with the symbols and themes already
 * tagged onto them. Naming a theme from what was written about a stock needs
 * months of this, and until now every refresh discarded it.
 */
/**
 * The symbols this session already recorded, leaders and 짝꿍 candidates alike.
 *
 * The after-hours pass follows the day's names rather than ranking the evening
 * book. NXT after 15:40 is thin enough that a few hundred million won tops a
 * turnover ranking, which would surface a different cast every tick and none of
 * it the cast the day was about. What is worth knowing after the close is where
 * the stocks that led - and the ones that were supposed to follow them - ended
 * up before tomorrow opens.
 */
export async function loadSessionSymbols(config, { market, sessionDate }) {
  if (!config.databaseUrl) return [];

  const result = await query(config, `
    SELECT DISTINCT symbol
    FROM market_price_samples
    WHERE market = $1 AND session_date = $2 AND source NOT LIKE '%:after'
    ORDER BY symbol
  `, [market, sessionDate]);

  return result.rows.map((row) => row.symbol);
}

export async function saveMarketNewsItems(config, headlines) {
  if (!config.databaseUrl || headlines.length === 0) return 0;

  let saved = 0;

  for (const headline of headlines) {
    const result = await query(config, `
      INSERT INTO market_news_items (
        id, provider, source, source_detail, region, label,
        headline, original_headline, original_url, published_at,
        related_symbols, related_themes, raw_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        related_symbols = EXCLUDED.related_symbols,
        related_themes = EXCLUDED.related_themes,
        -- COALESCE rather than overwrite: a later sighting of the same story
        -- can arrive through a path that carries no payload - a snapshot, or a
        -- per-leader search - and that must not erase the one we captured.
        raw_payload = COALESCE(EXCLUDED.raw_payload, market_news_items.raw_payload),
        updated_at = now()
    `, [
      headline.id,
      headline.provider ?? "news",
      headline.source ?? "",
      headline.sourceDetail ?? null,
      headline.region ?? "GLOBAL",
      headline.label ?? "",
      headline.text ?? "",
      headline.originalText ?? null,
      headline.originalUrl ?? "",
      headline.publishedAt,
      headline.relatedSymbols ?? [],
      headline.relatedThemes ?? [],
      headline.raw ? JSON.stringify(headline.raw) : null
    ]);

    saved += result.rowCount;
  }

  return saved;
}

/**
 * 시장 지정 — one row per symbol per day.
 *
 * A designation belongs to the listing rather than to the tick, so writing it
 * per sample would repeat the same fact 190 times a day. It can change during
 * the session, though — 투자경고 is announced mid-day — so the row is updated
 * rather than left at its first reading.
 */
export async function saveSymbolFlags(config, { sessionDate, stocks }) {
  const rows = stocks.filter((stock) => stock.flags);

  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_symbol_flags
      (symbol, session_date, market_warn, status_code, managed, halted,
       liquidation, short_overheated, investment_caution, credit_allowed)
    SELECT symbol, $2::date, market_warn, status_code, managed, halted,
           liquidation, short_overheated, investment_caution, credit_allowed
    FROM unnest($1::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[],
                $7::boolean[], $8::boolean[], $9::boolean[], $10::boolean[])
      AS t(symbol, market_warn, status_code, managed, halted, liquidation,
           short_overheated, investment_caution, credit_allowed)
    ON CONFLICT (symbol, session_date) DO UPDATE
      SET market_warn = EXCLUDED.market_warn,
          status_code = EXCLUDED.status_code,
          managed = EXCLUDED.managed,
          halted = EXCLUDED.halted,
          liquidation = EXCLUDED.liquidation,
          short_overheated = EXCLUDED.short_overheated,
          investment_caution = EXCLUDED.investment_caution,
          credit_allowed = EXCLUDED.credit_allowed,
          observed_at = now()
  `, [
    rows.map((row) => row.symbol),
    sessionDate,
    rows.map((row) => row.flags.marketWarn),
    rows.map((row) => row.flags.statusCode),
    rows.map((row) => row.flags.managed),
    rows.map((row) => row.flags.halted),
    rows.map((row) => row.flags.liquidation),
    rows.map((row) => row.flags.shortOverheated),
    rows.map((row) => row.flags.investmentCaution),
    rows.map((row) => row.flags.creditAllowed)
  ]);

  return result.rowCount;
}

/** Today's designations, for the symbols the board is about to describe. */
export async function loadSymbolFlags(config, { sessionDate, symbols }) {
  if (!config.databaseUrl || symbols.length === 0) return new Map();

  const result = await query(config, `
    SELECT symbol, market_warn, status_code, managed, halted, liquidation,
           short_overheated, investment_caution, credit_allowed
    FROM kr_symbol_flags
    WHERE session_date = $1 AND symbol = ANY($2::text[])
  `, [sessionDate, symbols]);

  return new Map(result.rows.map((row) => [row.symbol, row]));
}
