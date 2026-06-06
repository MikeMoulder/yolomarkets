-- Phase A: Circle Developer-Controlled Wallet + Economics layer
-- Adds:
--   · New columns on agent_profiles (preset, brain_model, reasoning_depth,
--     market filter params, position management params, circle_wallet_id)
--   · agent_credits table
--   · agent_subscriptions table

-- ── agent_profiles new columns ────────────────────────────────────────────

ALTER TABLE agent_profiles
    ADD COLUMN IF NOT EXISTS preset              TEXT        NOT NULL DEFAULT 'quant',
    ADD COLUMN IF NOT EXISTS brain_model         TEXT        NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS reasoning_depth     TEXT        NOT NULL DEFAULT 'balanced',
    ADD COLUMN IF NOT EXISTS drawdown_pause_pct  NUMERIC,
    ADD COLUMN IF NOT EXISTS min_liquidity_usdc  NUMERIC     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS min_tte_hours       INTEGER,
    ADD COLUMN IF NOT EXISTS max_tte_hours       INTEGER,
    ADD COLUMN IF NOT EXISTS odds_range_min      NUMERIC     NOT NULL DEFAULT 0.05,
    ADD COLUMN IF NOT EXISTS odds_range_max      NUMERIC     NOT NULL DEFAULT 0.95,
    ADD COLUMN IF NOT EXISTS max_open_positions  INTEGER,
    ADD COLUMN IF NOT EXISTS stop_loss_pct       NUMERIC,
    ADD COLUMN IF NOT EXISTS take_profit_pct     NUMERIC,
    ADD COLUMN IF NOT EXISTS circle_wallet_id    TEXT;

-- ── agent_credits ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_credits (
    user_addr               TEXT        PRIMARY KEY,
    balance                 INTEGER     NOT NULL DEFAULT 0,
    free_credits_refill_at  TIMESTAMPTZ,
    cost_basis_usdc         NUMERIC     NOT NULL DEFAULT 0,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── agent_subscriptions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_subscriptions (
    user_addr           TEXT        PRIMARY KEY,
    tier                TEXT        NOT NULL DEFAULT 'free',
    expires_at          TIMESTAMPTZ,
    auto_renew          BOOLEAN     NOT NULL DEFAULT TRUE,
    last_renewal_usdc   NUMERIC,
    last_renewal_tx     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
