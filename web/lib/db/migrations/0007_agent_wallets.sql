-- 0007_agent_wallets.sql
--
-- Server-owned binding of user EOA -> Circle Developer-Controlled agent wallet.
-- This is the trust anchor for every fund-moving route. It closes the
-- cross-account wallet-takeover vector (audit C-1 / H-3) in which
-- agent_profiles.circle_wallet_id was client-asserted via PUT /api/agent/profile
-- and publicly readable via GET, letting one user point their profile at
-- another user's Circle wallet and then withdraw/trade it.
--
-- After this migration:
--   • the creation route (POST /api/agent/circle-wallet) is the ONLY writer,
--   • profile saves + withdraw/exit routes resolve wallet identity from here,
--   • client-supplied circle_wallet_id / agent_address are ignored.

CREATE TABLE IF NOT EXISTS agent_wallets (
    user_addr     text PRIMARY KEY,
    wallet_id     text NOT NULL,
    agent_address text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Backfill existing bindings from agent_profiles. On a clean DB these are the
-- legitimate current wallets. If the UNIQUE(wallet_id) index below FAILS to
-- build, the same Circle wallet is bound to multiple users — direct evidence
-- the takeover was already exploited. Investigate before forcing the index:
--   SELECT circle_wallet_id, count(*) FROM agent_profiles
--    WHERE circle_wallet_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
INSERT INTO agent_wallets (user_addr, wallet_id, agent_address)
SELECT lower(user_addr), circle_wallet_id, lower(agent_address)
  FROM agent_profiles
 WHERE circle_wallet_id IS NOT NULL
   AND agent_address   IS NOT NULL
ON CONFLICT (user_addr) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_wallets_wallet_id
    ON agent_wallets (wallet_id);
