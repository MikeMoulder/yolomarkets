-- Catalog index — persistent cache of every market minted by the factories,
-- maintained by scripts/catalog-indexer.ts so the web catalog no longer reads
-- the full (~1k and growing) v2 market set on-chain per refresh.
--
-- Applied directly (this DB is partly hand-migrated — see CLAUDE.md); the
-- indexer also runs these as CREATE TABLE IF NOT EXISTS on boot, so this file
-- is documentation + parity with lib/db/schema.ts.

CREATE TABLE IF NOT EXISTS market_index (
    address text PRIMARY KEY,
    factory text NOT NULL,
    legacy boolean NOT NULL DEFAULT false,
    question text NOT NULL,
    category text NOT NULL,
    deadline bigint NOT NULL,
    initial_liquidity numeric NOT NULL DEFAULT '0',
    price_yes numeric NOT NULL DEFAULT '0',
    total_liquidity numeric NOT NULL DEFAULT '0',
    total_shares_yes numeric NOT NULL DEFAULT '0',
    total_shares_no numeric NOT NULL DEFAULT '0',
    resolved boolean NOT NULL DEFAULT false,
    outcome integer NOT NULL DEFAULT 0,
    dynamic_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_index_catalog ON market_index (legacy, resolved, deadline);

CREATE TABLE IF NOT EXISTS catalog_meta (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
