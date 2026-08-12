CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  email text,
  display_name text NOT NULL,
  author_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  avatar_url text,
  bio text,
  interests text,
  public_memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  content_html text NOT NULL,
  status text NOT NULL DEFAULT 'published',
  view_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_posts_author_idx ON community_posts(author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS community_posts_status_created_idx ON community_posts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_comments_post_idx ON community_comments(post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS trade_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date date NOT NULL,
  title text NOT NULL,
  result text NOT NULL,
  visibility text NOT NULL DEFAULT 'public',
  buy_html text NOT NULL,
  sell_html text NOT NULL,
  good_html text NOT NULL,
  bad_html text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_journals_author_idx ON trade_journals(author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_journals_visibility_created_idx ON trade_journals(visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_type text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  public_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_assets_owner_idx ON media_assets(owner_user_id, created_at DESC);
