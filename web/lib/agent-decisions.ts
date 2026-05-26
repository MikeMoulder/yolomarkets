/**
 * Postgres-backed reader for the agent's decision log. Drop-in replacement
 * for the Tier-0 JSONL file at agent/decisions.jsonl. Public API preserved
 * so /agent page rendering doesn't change.
 */
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { db } from "./db";
import {
    agentDecisions,
    type AgentDecisionRow,
    type ToolTraceEntry,
} from "./db/schema";

export type AgentAction = "pass" | "buy_yes" | "buy_no";

export type AgentDecision = {
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
    action: AgentAction;
    pass_reason: string | null;
    shares: number;
    cost_usdc: number;
    max_cost_usdc: number;
    tx_hash: string | null;
    paper: boolean;
    reasoning: string;
    watch_for: string[];
    time_sensitivity: "low" | "medium" | "high" | string;
    user_addr?: string | null;
    agent_addr?: string | null;
    // Phase-5 brain fields. Empty/null on legacy single-shot decisions.
    news_summary: string;
    tool_trace: ToolTraceEntry[];
    brain_model: string | null;
    brain_iterations: number | null;
};

export type { ToolTraceEntry };

export type DecisionFilter = {
    marketAddresses?: Set<string>;
    categories?: Set<string>;
    userAddr?: string;
};

export type DecisionsFeed = {
    decisions: AgentDecision[];
    counts: Record<AgentAction, number>;
    totalEdgePts: number;
    bankroll: number | null;
    lastTs: string | null;
    paperOnly: boolean;
};

function rowToDecision(r: AgentDecisionRow): AgentDecision {
    return {
        ts: r.ts.toISOString(),
        market: r.market,
        question: r.question,
        category: r.category,
        market_prob: Number(r.marketProb),
        polymarket_prob:
            r.polymarketProb != null ? Number(r.polymarketProb) : null,
        polymarket_slug: r.polymarketSlug,
        ai_prob: Number(r.aiProb),
        ai_confidence: Number(r.aiConfidence),
        edge_pts: Number(r.edgePts),
        kelly_fraction: Number(r.kellyFraction),
        bankroll_usdc: Number(r.bankrollUsdc),
        action: r.action as AgentAction,
        pass_reason: r.passReason,
        shares: r.shares,
        cost_usdc: Number(r.costUsdc),
        max_cost_usdc: Number(r.maxCostUsdc),
        tx_hash: r.txHash,
        paper: r.paper,
        reasoning: r.reasoning,
        watch_for: r.watchFor ?? [],
        time_sensitivity: r.timeSensitivity,
        user_addr: r.userAddr,
        agent_addr: r.agentAddr,
        news_summary: r.newsSummary ?? "",
        tool_trace: r.toolTrace ?? [],
        brain_model: r.brainModel,
        brain_iterations: r.brainIterations,
    };
}

export async function readDecisions(
    limit = 200,
    filter?: DecisionFilter,
): Promise<DecisionsFeed> {
    try {
        const conditions = [];
        if (filter?.userAddr !== undefined) {
            const want = filter.userAddr.toLowerCase();
            if (want === "demo") {
                conditions.push(isNull(agentDecisions.userAddr));
            } else {
                conditions.push(eq(agentDecisions.userAddr, want));
            }
        }
        if (filter?.categories && filter.categories.size > 0) {
            conditions.push(
                inArray(agentDecisions.category, Array.from(filter.categories)),
            );
        }
        if (filter?.marketAddresses && filter.marketAddresses.size > 0) {
            conditions.push(
                inArray(
                    agentDecisions.market,
                    Array.from(filter.marketAddresses),
                ),
            );
        }

        const whereClause =
            conditions.length === 0
                ? undefined
                : conditions.length === 1
                    ? conditions[0]
                    : and(...conditions);

        const rows = await db
            .select()
            .from(agentDecisions)
            .where(whereClause)
            .orderBy(desc(agentDecisions.ts))
            .limit(limit);

        const decisions = rows.map(rowToDecision);

        const counts: Record<AgentAction, number> = {
            pass: 0,
            buy_yes: 0,
            buy_no: 0,
        };
        let totalEdgePts = 0;
        for (const d of decisions) {
            counts[d.action] = (counts[d.action] ?? 0) + 1;
            if (d.action !== "pass") totalEdgePts += Math.abs(d.edge_pts);
        }

        return {
            decisions,
            counts,
            totalEdgePts,
            bankroll: decisions[0]?.bankroll_usdc ?? null,
            lastTs: decisions[0]?.ts ?? null,
            paperOnly: decisions.every((d) => d.paper),
        };
    } catch (e) {
        // Defensive: a missing/unreachable DB shouldn't take down the /agent
        // page during local dev. Return an empty feed and log.
        console.error("[agent-decisions] read failed:", e);
        return emptyFeed();
    }
}

function emptyFeed(): DecisionsFeed {
    return {
        decisions: [],
        counts: { pass: 0, buy_yes: 0, buy_no: 0 },
        totalEdgePts: 0,
        bankroll: null,
        lastTs: null,
        paperOnly: true,
    };
}
