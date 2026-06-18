-- Remove dead exit knobs: stop_loss_pct / take_profit_pct.
--
-- These columns were never written by the app (not in the setup wizard, profile
-- API, or agent-profiles.ts) and never read by any decision logic — there is no
-- sell/exit path in the agent loop (actions are pass | buy_yes | buy_no). They
-- were promising behavior that did not exist, so they are removed.
--
-- NOTE: applied directly via SQL (this DB is not managed by drizzle migrate();
-- see 0005). Kept here for repo history.

ALTER TABLE agent_profiles DROP COLUMN IF EXISTS stop_loss_pct;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS take_profit_pct;
