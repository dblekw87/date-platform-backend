import { query } from "./client.mjs";

function normalizeProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();

  return provider || "mock";
}

function normalizeProviderUserId(value, provider) {
  const providerUserId = String(value ?? "").trim();

  if (providerUserId) return providerUserId;

  return provider === "mock" ? "mock-trader" : `${provider}-user`;
}

function normalizeDisplayName(value, provider) {
  const rawDisplayName = String(value ?? "").trim();
  let displayName = rawDisplayName;

  try {
    displayName = decodeURIComponent(rawDisplayName);
  } catch {
    displayName = rawDisplayName;
  }

  if (displayName) return displayName;

  return provider === "mock" ? "Mock Trader" : "DATE 회원";
}

function authorIdFrom(provider, providerUserId) {
  if (provider === "mock") return "date_user";

  return `${provider}_${providerUserId}`
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || `${provider}_user`;
}

export async function ensureUser(config, input = {}) {
  const provider = normalizeProvider(input.provider);
  const providerUserId = normalizeProviderUserId(input.providerUserId, provider);
  const displayName = normalizeDisplayName(input.displayName, provider);
  const authorId = authorIdFrom(provider, providerUserId);
  const result = await query(config, `
    INSERT INTO users (provider, provider_user_id, email, display_name, author_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, provider_user_id)
    DO UPDATE SET
      email = COALESCE(EXCLUDED.email, users.email),
      display_name = EXCLUDED.display_name,
      updated_at = now()
    RETURNING id, provider, display_name, author_id
  `, [provider, providerUserId, input.email ?? null, displayName, authorId]);
  const user = result.rows[0];

  await query(config, `
    INSERT INTO profiles (user_id, nickname)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO NOTHING
  `, [user.id, user.author_id]);

  return user;
}
