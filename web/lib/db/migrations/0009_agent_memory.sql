-- Agent memory & narrative (Agent v2 · M1) —
--   agent_theses      : the agent's live view per market/bucket, carried across
--                       ticks so a pass revisits a stance instead of re-deriving
--                       it from scratch. One row per (user, scope), upserted.
--   agent_journal     : append-only first-person account of what the agent did
--                       and why, tagged by trigger. Feeds the /agent feed + chat.
--                       Additive to agent_decisions (which the risk gate reads).
--   agent_preferences : durable preferences learned from chat ("no sports",
--                       "cap me at $2"). One row per (user, key), upserted.
--
-- Applied directly (this DB is partly hand-migrated — see CLAUDE.md); every
-- statement is idempotent so re-running is safe and mirrors lib/db/schema.ts.

CREATE TABLE IF NOT EXISTS agent_theses (
    id          bigserial PRIMARY KEY,
    user_addr   text NOT NULL,
    scope       text NOT NULL,             -- lower(market addr) OR 'bucket:<name>'
    market      text,                       -- set when the thesis is market-level
    bucket      text,                       -- risk bucket (see policy.risk_bucket)
    subject     text NOT NULL,              -- human label (question or bucket)
    stance      text NOT NULL,              -- long_yes | long_no | watch | avoid
    conviction  numeric NOT NULL DEFAULT '0.5',   -- 0..1
    rationale   text NOT NULL DEFAULT '',
    evidence    jsonb NOT NULL DEFAULT '[]',       -- ["<url>", ...]
    status      text NOT NULL DEFAULT 'active',    -- active | closed | expired
    revisit_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_theses_user_scope ON agent_theses (user_addr, scope);
CREATE INDEX IF NOT EXISTS idx_agent_theses_user_status ON agent_theses (user_addr, status);
CREATE INDEX IF NOT EXISTS idx_agent_theses_revisit ON agent_theses (revisit_at);

CREATE TABLE IF NOT EXISTS agent_journal (
    id          bigserial PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    user_addr   text NOT NULL,
    trigger     text NOT NULL,             -- autonomous | chat | trade | reflect
    kind        text NOT NULL DEFAULT 'note',  -- plan|decision|reflection|trade|message|note
    market      text,
    title       text NOT NULL DEFAULT '',
    body        text NOT NULL,
    meta        jsonb NOT NULL DEFAULT '{}',
    decision_id bigint,                     -- loose link to agent_decisions.id
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_journal_user_ts ON agent_journal (user_addr, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_journal_ts ON agent_journal (ts);
CREATE INDEX IF NOT EXISTS idx_agent_journal_market ON agent_journal (market);

CREATE TABLE IF NOT EXISTS agent_preferences (
    id          bigserial PRIMARY KEY,
    user_addr   text NOT NULL,
    key         text NOT NULL,
    value       jsonb NOT NULL,
    source      text NOT NULL DEFAULT 'chat',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_preferences_user_key ON agent_preferences (user_addr, key);
