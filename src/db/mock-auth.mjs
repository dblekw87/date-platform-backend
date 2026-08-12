import { query } from "./client.mjs";

export async function ensureMockUser(config) {
  const result = await query(config, `
    INSERT INTO users (provider, provider_user_id, display_name, author_id)
    VALUES ('mock', 'mock-trader', 'Mock Trader', 'date_user')
    ON CONFLICT (provider, provider_user_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      updated_at = now()
    RETURNING id, provider, display_name, author_id
  `);
  const user = result.rows[0];

  await query(config, `
    INSERT INTO profiles (user_id, nickname)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO NOTHING
  `, [user.id, user.author_id]);

  return user;
}
