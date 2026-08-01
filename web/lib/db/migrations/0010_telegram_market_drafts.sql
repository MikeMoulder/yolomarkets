-- Telegram admin command center — state for the multi-step `/create` wizard.
--
-- The webhook is stateless (Telegram delivers each update as its own HTTP
-- request, and the app may run on more than one instance), so a half-finished
-- market has to live in Postgres between messages. `id` is a short hex token
-- so it fits inside Telegram's 64-byte callback_data, and `step` is also the
-- double-deploy guard: the confirm button only deploys if it can atomically
-- flip the row from 'confirm' to 'deploying'.
--
-- Applied directly (this DB is partly hand-migrated — see CLAUDE.md); every
-- statement is idempotent so re-running is safe and mirrors lib/db/schema.ts.

CREATE TABLE IF NOT EXISTS telegram_market_drafts (
    id              text PRIMARY KEY,
    chat_id         text NOT NULL,
    user_id         text,
    step            text NOT NULL DEFAULT 'question',
    question        text,
    category        text,
    criteria        text,
    deadline        bigint,
    seed_usdc       numeric,
    card_message_id integer,
    market_address  text,
    tx_hash         text,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_drafts_chat_updated
    ON telegram_market_drafts (chat_id, updated_at);
