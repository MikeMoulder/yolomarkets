-- Rename paid subscription tiers:
--   active -> pro
--   pro    -> plus

UPDATE agent_subscriptions
SET tier = 'plus', updated_at = NOW()
WHERE tier = 'pro';

UPDATE agent_subscriptions
SET tier = 'pro', updated_at = NOW()
WHERE tier = 'active';
