CREATE TABLE IF NOT EXISTS market_data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  dataset text NOT NULL,
  market text,
  mode text NOT NULL DEFAULT 'demo',
  source_url text,
  source_license text,
  payload jsonb NOT NULL,
  raw_payload jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_data_snapshots_latest_idx
  ON market_data_snapshots(provider, dataset, market, observed_at DESC);

CREATE INDEX IF NOT EXISTS market_data_snapshots_expires_idx
  ON market_data_snapshots(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_board_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL DEFAULT 'demo',
  payload jsonb NOT NULL,
  provider_statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_board_snapshots_latest_idx
  ON market_board_snapshots(mode, observed_at DESC);

CREATE TABLE IF NOT EXISTS market_calendar_events (
  id text PRIMARY KEY,
  event_date date NOT NULL,
  day_label text,
  event_type text NOT NULL,
  title text NOT NULL,
  market text NOT NULL,
  check_text text,
  detail text,
  source text NOT NULL,
  original_url text,
  published_at timestamptz,
  raw_payload jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_calendar_events_date_idx
  ON market_calendar_events(event_date, event_type, title);

CREATE TABLE IF NOT EXISTS market_news_items (
  id text PRIMARY KEY,
  provider text NOT NULL,
  source text NOT NULL,
  source_detail text,
  region text NOT NULL,
  label text NOT NULL,
  headline text NOT NULL,
  original_headline text,
  original_url text NOT NULL,
  published_at timestamptz NOT NULL,
  related_symbols text[] NOT NULL DEFAULT '{}',
  related_themes text[] NOT NULL DEFAULT '{}',
  raw_payload jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_news_items_published_idx
  ON market_news_items(published_at DESC);

CREATE INDEX IF NOT EXISTS market_news_items_region_idx
  ON market_news_items(region, published_at DESC);

CREATE TABLE IF NOT EXISTS market_disclosures (
  id text PRIMARY KEY,
  market text NOT NULL,
  source text NOT NULL,
  urgency text,
  company_name text,
  symbol text,
  issuer_type text,
  event_type text,
  accession_number text,
  form_type text NOT NULL,
  title text NOT NULL,
  filed_at timestamptz NOT NULL,
  original_url text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  action text,
  raw_payload jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_disclosures_filed_idx
  ON market_disclosures(market, filed_at DESC);

CREATE INDEX IF NOT EXISTS market_disclosures_symbol_idx
  ON market_disclosures(symbol, filed_at DESC)
  WHERE symbol IS NOT NULL;
