/**
 * One-shot import of the legacy JSON file store into Postgres.
 * Reads:  ../agent/profiles.json   →  agent_profiles
 *         ../agent/decisions.jsonl →  agent_decisions
 *
 * Safe to re-run: profiles are ON CONFLICT DO UPDATE, decisions are
 * deduplicated by (ts, market, user_addr) so re-runs add only new rows.
 *
 * Run with: npm run db:import-json
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

import { promises as fs } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, and, eq, isNull } from "drizzle-orm";
import { agentProfiles, agentDecisions } from "../lib/db/schema";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROFILES_PATH = path.join(REPO_ROOT, "agent", "profiles.json");
const DECISIONS_PATH = path.join(REPO_ROOT, "agent", "decisions.jsonl");

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error("DATABASE_URL is not set");
        process.exit(1);
    }
    const client = postgres(url, { max: 2 });
    const db = drizzle(client);

    await importProfiles(db);
    await importDecisions(db);

    await client.end();
    console.log("Import complete.");
}

type ProfileStore = {
    version: number;
    profiles: Record<string, ProfileRow>;
};
type ProfileRow = {
    userAddr: string;
    pattern: string;
    cadenceMinutes: number;
    kellyMult: number;
    edgeThreshold: number;
    minConfidence: number;
    signals: string[];
    marketsMode: string;
    categories: string[];
    watchlist: string[];
    budgetTotal: number;
    budgetPerMarket: number;
    budgetPerDay: number;
    agentAddress: string | null;
    sessionKeyAddress: string | null;
    sessionValidUntil: number | null;
    sessionTotalCap: number | null;
    sessionPerCallCap: number | null;
    active: boolean;
    pausedUntil: string | null;
    createdAt: string;
    updatedAt: string;
};

async function importProfiles(db: ReturnType<typeof drizzle>) {
    let raw: string;
    try {
        raw = await fs.readFile(PROFILES_PATH, "utf-8");
    } catch {
        console.log("no profiles.json — skipping");
        return;
    }
    const store = JSON.parse(raw) as ProfileStore;
    const rows = Object.values(store.profiles ?? {});
    if (rows.length === 0) {
        console.log("profiles.json is empty");
        return;
    }
    for (const p of rows) {
        await db
            .insert(agentProfiles)
            .values({
                userAddr: p.userAddr.toLowerCase(),
                pattern: p.pattern,
                cadenceMinutes: p.cadenceMinutes,
                kellyMult: p.kellyMult.toString(),
                edgeThreshold: p.edgeThreshold.toString(),
                minConfidence: p.minConfidence.toString(),
                signals: p.signals,
                marketsMode: p.marketsMode,
                categories: p.categories,
                watchlist: p.watchlist,
                budgetTotal: p.budgetTotal.toString(),
                budgetPerMarket: p.budgetPerMarket.toString(),
                budgetPerDay: p.budgetPerDay.toString(),
                agentAddress: p.agentAddress,
                sessionKeyAddress: p.sessionKeyAddress,
                sessionValidUntil: p.sessionValidUntil,
                sessionTotalCap:
                    p.sessionTotalCap != null ? p.sessionTotalCap.toString() : null,
                sessionPerCallCap:
                    p.sessionPerCallCap != null ? p.sessionPerCallCap.toString() : null,
                active: p.active,
                pausedUntil: p.pausedUntil ? new Date(p.pausedUntil) : null,
                createdAt: new Date(p.createdAt),
                updatedAt: new Date(p.updatedAt),
            })
            .onConflictDoUpdate({
                target: agentProfiles.userAddr,
                set: {
                    pattern: sql`excluded.pattern`,
                    cadenceMinutes: sql`excluded.cadence_minutes`,
                    kellyMult: sql`excluded.kelly_mult`,
                    edgeThreshold: sql`excluded.edge_threshold`,
                    minConfidence: sql`excluded.min_confidence`,
                    signals: sql`excluded.signals`,
                    marketsMode: sql`excluded.markets_mode`,
                    categories: sql`excluded.categories`,
                    watchlist: sql`excluded.watchlist`,
                    budgetTotal: sql`excluded.budget_total`,
                    budgetPerMarket: sql`excluded.budget_per_market`,
                    budgetPerDay: sql`excluded.budget_per_day`,
                    agentAddress: sql`excluded.agent_address`,
                    sessionKeyAddress: sql`excluded.session_key_address`,
                    sessionValidUntil: sql`excluded.session_valid_until`,
                    sessionTotalCap: sql`excluded.session_total_cap`,
                    sessionPerCallCap: sql`excluded.session_per_call_cap`,
                    active: sql`excluded.active`,
                    pausedUntil: sql`excluded.paused_until`,
                    updatedAt: sql`excluded.updated_at`,
                },
            });
    }
    console.log(`imported ${rows.length} profile(s)`);
}

type DecisionLine = {
    ts: string;
    market: string;
    question: string;
    category: string;
    market_prob: number;
    polymarket_prob: number | null;
    polymarket_slug: string | null;
    ai_prob: number;
    ai_confidence: number;
    edge_pts: number;
    kelly_fraction: number;
    bankroll_usdc: number;
    action: string;
    pass_reason: string | null;
    shares: number;
    cost_usdc: number;
    max_cost_usdc: number;
    tx_hash: string | null;
    paper: boolean;
    reasoning: string;
    watch_for: string[];
    time_sensitivity: string;
    user_addr?: string | null;
    agent_addr?: string | null;
};

async function importDecisions(db: ReturnType<typeof drizzle>) {
    let raw: string;
    try {
        raw = await fs.readFile(DECISIONS_PATH, "utf-8");
    } catch {
        console.log("no decisions.jsonl — skipping");
        return;
    }
    const lines = raw.split("\n").filter(Boolean);
    let inserted = 0;
    let skipped = 0;
    for (const line of lines) {
        let d: DecisionLine;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        // Dedup on (ts, market, user_addr) — same agent shouldn't make two
        // identical decisions in the same second on the same market.
        const userAddr = d.user_addr?.toLowerCase() ?? null;
        const existing = await db
            .select({ id: agentDecisions.id })
            .from(agentDecisions)
            .where(
                and(
                    eq(agentDecisions.ts, new Date(d.ts)),
                    eq(agentDecisions.market, d.market),
                    userAddr === null
                        ? isNull(agentDecisions.userAddr)
                        : eq(agentDecisions.userAddr, userAddr),
                ),
            )
            .limit(1);
        if (existing.length > 0) {
            skipped++;
            continue;
        }

        await db.insert(agentDecisions).values({
            ts: new Date(d.ts),
            market: d.market,
            question: d.question,
            category: d.category,
            marketProb: d.market_prob.toString(),
            polymarketProb:
                d.polymarket_prob != null ? d.polymarket_prob.toString() : null,
            polymarketSlug: d.polymarket_slug,
            aiProb: d.ai_prob.toString(),
            aiConfidence: d.ai_confidence.toString(),
            edgePts: d.edge_pts.toString(),
            kellyFraction: d.kelly_fraction.toString(),
            bankrollUsdc: d.bankroll_usdc.toString(),
            action: d.action,
            passReason: d.pass_reason,
            shares: d.shares,
            costUsdc: d.cost_usdc.toString(),
            maxCostUsdc: d.max_cost_usdc.toString(),
            txHash: d.tx_hash,
            paper: d.paper,
            reasoning: d.reasoning,
            watchFor: d.watch_for ?? [],
            timeSensitivity: d.time_sensitivity,
            userAddr,
            agentAddr: d.agent_addr?.toLowerCase() ?? null,
        });
        inserted++;
    }
    console.log(`imported ${inserted} decision(s), skipped ${skipped} duplicate(s)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
