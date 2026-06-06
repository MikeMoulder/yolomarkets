-- Phase 5: decision-trace columns + Circle wallet onboarding table
-- Adds:
--   · New trace/debug columns on agent_decisions
--   · circle_wallets table used by Circle onboarding flow

ALTER TABLE agent_decisions
    ADD COLUMN IF NOT EXISTS news_summary TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS tool_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS brain_model TEXT,
    ADD COLUMN IF NOT EXISTS brain_iterations INTEGER;

CREATE TABLE IF NOT EXISTS circle_wallets (
    circle_user_id TEXT PRIMARY KEY,
    email TEXT,
    wallet_address TEXT,
    wallet_id TEXT,
    challenge_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_wallets_address
    ON circle_wallets (wallet_address);

CREATE INDEX IF NOT EXISTS idx_circle_wallets_email
    ON circle_wallets (email);
