-- Per-user EOA payments wallet for Circle Nanopayments.
--
-- Why a SECOND wallet rather than changing the existing one: nanopayments
-- settle as an EIP-3009 signature, which Circle SCA (smart-contract) wallets
-- cannot produce. Account type is fixed at creation, so paying natively means
-- an EOA — but the existing SCA wallets hold open market positions, and shares
-- can only be claimed by the address that bought them. Repointing the profile
-- would strand them until those markets resolve (months, for several).
--
-- So the SCA wallet keeps trading and holding positions, and this EOA exists
-- purely to pay for services. Both belong to the same user's agent.
--
-- Applied directly, following 0008–0011 (this DB is not managed by drizzle
-- migrate() — there is no __drizzle_migrations table).

ALTER TABLE agent_profiles
    ADD COLUMN IF NOT EXISTS payments_wallet_id text,
    ADD COLUMN IF NOT EXISTS payments_address text;

COMMENT ON COLUMN agent_profiles.payments_wallet_id IS
    'Circle wallet id (EOA) used to sign nanopayments; NULL = user cannot pay natively';
COMMENT ON COLUMN agent_profiles.payments_address IS
    'On-chain address of the payments EOA; funds a Circle Gateway balance';
