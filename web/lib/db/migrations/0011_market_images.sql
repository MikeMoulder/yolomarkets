-- Admin-supplied market cover art.
--
-- The contract has no image field (createMarket takes question/category/
-- criteria/deadline/liquidity and nothing else), and the catalog otherwise
-- *derives* card art by fuzzy-matching the question back to Polymarket event
-- imagery. This table is the override: one row per market whose art the admin
-- set explicitly from Telegram, served by /api/markets/<address>/image.
--
-- Bytes live in Postgres rather than object storage on purpose — Telegram
-- photos are small, and it keeps the feature free of new cloud credentials.
--
-- The draft columns hold the image between "admin sent a photo" and "market
-- deployed", since the market address doesn't exist until the tx lands.
--
-- Applied directly (this DB is partly hand-migrated — see CLAUDE.md); every
-- statement is idempotent so re-running is safe and mirrors lib/db/schema.ts.

CREATE TABLE IF NOT EXISTS market_images (
    address    text PRIMARY KEY,             -- lowercased 0x market address
    mime       text NOT NULL,
    bytes      bytea NOT NULL,
    byte_size  integer NOT NULL DEFAULT 0,
    source     text NOT NULL DEFAULT 'telegram',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_market_drafts ADD COLUMN IF NOT EXISTS image_data bytea;
ALTER TABLE telegram_market_drafts ADD COLUMN IF NOT EXISTS image_mime text;
ALTER TABLE telegram_market_drafts ADD COLUMN IF NOT EXISTS image_size integer;
