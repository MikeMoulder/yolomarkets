/**
 * Drizzle schema — source of truth for the production Postgres database
 * that replaces agent/profiles.json + agent/decisions.jsonl.
 *
 * The Python runner reads the same database via psycopg (see
 * agent/db.py). Column names use snake_case to match Python idioms;
 * TS callers go through the typed Drizzle row mappers in lib/db/index.ts.
 */
import {
    pgTable,
    text,
    integer,
    bigint,
    numeric,
    boolean,
    timestamp,
    jsonb,
    bigserial,
    index,
    uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Profiles ───────────────────────────────────────────────────────────────

export const agentProfiles = pgTable("agent_profiles", {
    userAddr: text("user_addr").primaryKey(),
    pattern: text("pattern").notNull(),
    // ── Strategy preset + brain config ────────────────────────────────────
    preset: text("preset").notNull().default("quant"), // moonshot|quant|contrarian|news_trader|copycat|custom
    brainModel: text("brain_model").notNull().default("standard"), // economy|standard|premium
    reasoningDepth: text("reasoning_depth").notNull().default("balanced"), // fast|balanced|deep
    cadenceMinutes: integer("cadence_minutes").notNull(),
    kellyMult: numeric("kelly_mult").notNull(),
    edgeThreshold: numeric("edge_threshold").notNull(),
    minConfidence: numeric("min_confidence").notNull(),
    signals: jsonb("signals").$type<string[]>().notNull(),
    marketsMode: text("markets_mode").notNull(),
    categories: jsonb("categories").$type<string[]>().notNull(),
    watchlist: jsonb("watchlist").$type<string[]>().notNull(),
    budgetTotal: numeric("budget_total").notNull(),
    budgetPerMarket: numeric("budget_per_market").notNull(),
    budgetPerDay: numeric("budget_per_day").notNull(),
    drawdownPausePct: numeric("drawdown_pause_pct"),     // e.g. 30 → pause if down 30%
    // ── Market filters ────────────────────────────────────────────────────
    minLiquidityUsdc: numeric("min_liquidity_usdc").default("0"),
    minTteHours: integer("min_tte_hours"),               // skip markets closing < N hours
    maxTteHours: integer("max_tte_hours"),               // skip markets resolving > N hours out
    oddsRangeMin: numeric("odds_range_min").default("0.05"),
    oddsRangeMax: numeric("odds_range_max").default("0.95"),
    maxOpenPositions: integer("max_open_positions"),
    agentAddress: text("agent_address"),                 // Circle wallet's on-chain address
    // ── Circle Developer-Controlled Wallet (Phase A) ──────────────────────
    circleWalletId: text("circle_wallet_id"),            // Circle wallet UUID for agent execution
    // ── User notifications ───────────────────────────────────────────────
    telegramChatId: text("telegram_chat_id"),
    telegramEnabled: boolean("telegram_enabled").notNull().default(false),
    telegramEvents: jsonb("telegram_events")
        .$type<string[]>()
        .notNull()
        .default(["live_trade"]),
    active: boolean("active").notNull().default(true),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

// ── Agent wallet binding (server-owned trust anchor) ──────────────────────
// Maps a user's EOA → the Circle Developer-Controlled wallet provisioned for
// their agent. This is the ONLY trusted source of (userAddr → walletId) and is
// written exclusively by the authenticated /api/agent/circle-wallet creation
// route. Fund-moving routes and profile saves resolve wallet identity from
// here — NEVER from client-supplied input — which closes the cross-account
// wallet-takeover vector (a user pointing their profile at another user's
// walletId, then withdrawing/trading that wallet). `wallet_id` is UNIQUE so a
// single Circle wallet can never be bound to two different users.
export const agentWallets = pgTable(
    "agent_wallets",
    {
        userAddr: text("user_addr").primaryKey(),
        walletId: text("wallet_id").notNull(),
        agentAddress: text("agent_address").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (t) => [uniqueIndex("uq_agent_wallets_wallet_id").on(t.walletId)],
);

export type AgentWalletRow = typeof agentWallets.$inferSelect;

// One entry in the Claude tool-use trace stored on each decision row.
// Mirrors what agent/brain.py writes per tool call: name, input, result,
// timing. Rendered on /agent so judges can replay how the model reasoned.
export type ToolTraceEntry = {
    iteration: number;
    name: string;
    input: Record<string, unknown>;
    result: unknown;
    is_error: boolean;
    elapsed_ms: number;
};

// ── Decisions (append-only) ───────────────────────────────────────────────

export const agentDecisions = pgTable(
    "agent_decisions",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),
        ts: timestamp("ts", { withTimezone: true }).notNull(),
        market: text("market").notNull(),
        question: text("question").notNull(),
        category: text("category").notNull(),
        marketProb: numeric("market_prob").notNull(),
        polymarketProb: numeric("polymarket_prob"),
        polymarketSlug: text("polymarket_slug"),
        aiProb: numeric("ai_prob").notNull(),
        aiConfidence: numeric("ai_confidence").notNull(),
        edgePts: numeric("edge_pts").notNull(),
        kellyFraction: numeric("kelly_fraction").notNull(),
        bankrollUsdc: numeric("bankroll_usdc").notNull(),
        action: text("action").notNull(),       // pass | buy_yes | buy_no
        passReason: text("pass_reason"),
        shares: bigint("shares", { mode: "number" }).notNull(),  // 6-dec int
        costUsdc: numeric("cost_usdc").notNull(),
        maxCostUsdc: numeric("max_cost_usdc").notNull(),
        txHash: text("tx_hash"),
        paper: boolean("paper").notNull(),
        reasoning: text("reasoning").notNull(),
        watchFor: jsonb("watch_for").$type<string[]>().notNull(),
        timeSensitivity: text("time_sensitivity").notNull(),
        userAddr: text("user_addr"),          // null = dev/legacy
        agentAddr: text("agent_addr"),
        // Phase 5 — populated only when the Claude tool-use brain produced
        // this decision. Drives the judge-replayable trace on /agent.
        newsSummary: text("news_summary").notNull().default(""),
        toolTrace: jsonb("tool_trace")
            .$type<ToolTraceEntry[]>()
            .notNull()
            .default([]),
        brainModel: text("brain_model"),
        brainIterations: integer("brain_iterations"),
        promptHash: text("prompt_hash"),
        toolsCalled: jsonb("tools_called").$type<string[]>().notNull().default([]),
        externalOddsSnapshot: jsonb("external_odds_snapshot")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        policySnapshot: jsonb("policy_snapshot")
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        platformFeeUsdc: numeric("platform_fee_usdc").notNull().default("0"),
        notificationStatus: text("notification_status"),
    },
    (t) => [
        index("idx_agent_decisions_user_ts").on(t.userAddr, t.ts),
        index("idx_agent_decisions_ts").on(t.ts),
        index("idx_agent_decisions_market").on(t.market),
    ],
);


// ── Circle User-Controlled Wallets (Phase 5) ──────────────────────────────
// One row per Circle-onboarded user. The Circle "user_id" is generated
// server-side (UUID); the resulting wallet address (once provisioned) is
// what the rest of the app uses as the canonical user identifier — same
// shape as a wagmi-injected EOA, so existing code paths (agent_profiles,
// agent_decisions.user_addr) just work once the address is known.
//
// Why this table exists separately from a generic `users` table: Circle is
// one of several possible onboarding paths (the other being wagmi+MetaMask),
// and Circle-specific fields — wallet_id, challenge_id, status — don't
// belong on the shared user record. Join via address when needed.

export const circleWallets = pgTable(
    "circle_wallets",
    {
        // Stable, generated client-side per signup. Sent to Circle as
        // userId; Circle treats it as opaque. We store it so we can fetch
        // the wallet later via the same user token.
        circleUserId: text("circle_user_id").primaryKey(),
        // Email is optional — accommodates social signups too.
        email: text("email"),
        // Once Circle has provisioned the on-chain wallet (post-PIN), this
        // is the address. Until then it's null and the row represents a
        // pending onboarding.
        walletAddress: text("wallet_address"),
        walletId: text("wallet_id"),
        // Created at user-init; challenge ID is the one returned to the
        // Web SDK so the client can complete the PIN flow.
        challengeId: text("challenge_id"),
        status: text("status").notNull().default("pending"), // pending|provisioned|failed
        // "developer" → Dev-Controlled wallet, server signs (current flow).
        // null → legacy User-Controlled (PIN) wallet from before 2026-07-18;
        // those rows are re-provisioned with a developer wallet on next login.
        walletProvider: text("wallet_provider"),
        // When the welcome USDC transfer from the deployer landed (once ever).
        fundedAt: timestamp("funded_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
        provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    },
    (t) => [
        uniqueIndex("uq_circle_wallets_address").on(t.walletAddress),
        index("idx_circle_wallets_email").on(t.email),
    ],
);

export type CircleWalletRow = typeof circleWallets.$inferSelect;

// ── Agent credits (off-chain USDC credit balance) ─────────────────────────
// One row per user. Debited on every brain run; recharged via top-up or
// daily included quota reset. When balance reaches 0 the runner skips fresh
// model scans until refill/top-up so the user never gets a surprise.

export const agentCredits = pgTable("agent_credits", {
    userAddr: text("user_addr").primaryKey(),
    // Current spendable credit balance.
    balance: integer("balance").notNull().default(0),
    // Included scan quota resets daily.
    freeCreditsRefillAt: timestamp("free_credits_refill_at", { withTimezone: true }),
    // Deposited USDC cost basis for profit-share calculation on withdrawal.
    costBasisUsdc: numeric("cost_basis_usdc").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentCreditsRow = typeof agentCredits.$inferSelect;

// ── Agent subscriptions ────────────────────────────────────────────────────
// Tracks subscription tier and renewal state. The runner checks
// subscription_expires_at each tick; if expired + active it auto-debits
// the agent wallet and extends by 30 days. If debit fails it falls back to
// the Free tier.

export type SubscriptionTier = "free" | "pro" | "plus";

export const agentSubscriptions = pgTable("agent_subscriptions", {
    userAddr: text("user_addr").primaryKey(),
    tier: text("tier").$type<SubscriptionTier>().notNull().default("free"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),  // null = free forever
    autoRenew: boolean("auto_renew").notNull().default(true),
    // Price paid on last renewal (USDC, 6-dec as string for precision).
    lastRenewalUsdc: numeric("last_renewal_usdc"),
    lastRenewalTx: text("last_renewal_tx"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentSubscriptionRow = typeof agentSubscriptions.$inferSelect;
export type NewCircleWalletRow = typeof circleWallets.$inferInsert;

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type NewAgentProfileRow = typeof agentProfiles.$inferInsert;
export type AgentDecisionRow = typeof agentDecisions.$inferSelect;
export type NewAgentDecisionRow = typeof agentDecisions.$inferInsert;
