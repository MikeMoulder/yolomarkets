-- Migrate fully to Circle Wallets — remove the legacy AgentAccount/session-key system.
--
-- NOTE: This database is not managed by drizzle's migrate() (no
-- __drizzle_migrations table; the journal is incomplete). This file is kept for
-- repo history and was applied directly via SQL, matching how this DB is managed.

-- Drop the legacy session-key columns from agent_profiles.
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS session_key_address;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS session_valid_until;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS session_total_cap;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS session_per_call_cap;

-- Drop the unused per-user session-key table (was reserved for Tier 1b).
DROP TABLE IF EXISTS agent_session_keys;

-- Clean slate: wipe all existing profiles (all were on the legacy path with no
-- Circle wallet). Users re-onboard through the Circle-based setup wizard.
DELETE FROM agent_profiles;
