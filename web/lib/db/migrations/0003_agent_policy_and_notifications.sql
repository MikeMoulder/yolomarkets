-- Phase 6: production policy telemetry + per-user Telegram notifications

ALTER TABLE agent_profiles
    ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT,
    ADD COLUMN IF NOT EXISTS telegram_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS telegram_events JSONB NOT NULL DEFAULT '["live_trade"]'::jsonb;

ALTER TABLE agent_decisions
    ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
    ADD COLUMN IF NOT EXISTS tools_called JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS external_odds_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS platform_fee_usdc NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notification_status TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_decisions_policy_bucket_ts
    ON agent_decisions ((policy_snapshot->>'risk_bucket'), ts);
