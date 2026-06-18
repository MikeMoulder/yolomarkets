import "server-only";

import type { Address } from "viem";
import { publicClient } from "./markets";
import { marketAbi, Outcome } from "./contracts";

/**
 * An open on-chain position the agent wallet currently holds in a market.
 * Positions are per (market, outcome) — they aggregate every buy the agent
 * made on that side, so a manual exit always acts on the live net balance,
 * not on a single trade row in the feed.
 */
export type AgentPosition = {
    market: Address;
    outcome: Outcome.Yes | Outcome.No;
    /** Shares held, 6-dec micro units. */
    shares: bigint;
    /** Current full-exit proceeds from previewSell, 6-dec micro units. */
    exitProceeds: bigint;
};

const SIDES = [Outcome.Yes, Outcome.No] as const;

/**
 * Reads the agent wallet's open positions across `markets`. Skips resolved
 * markets (those are auto-claimed by the agent, not manually exited) and
 * sides with zero shares. All reads are batched into a single multicall.
 */
export async function loadAgentPositions(
    agentAddress: Address,
    markets: Address[],
): Promise<AgentPosition[]> {
    const unique = [...new Set(markets.map((m) => m.toLowerCase()))] as Address[];
    if (unique.length === 0) return [];

    // Phase 1 — resolved flag + share balances for both sides of every market.
    const probe = await publicClient.multicall({
        contracts: unique.flatMap((market) => [
            { address: market, abi: marketAbi, functionName: "resolved" } as const,
            {
                address: market,
                abi: marketAbi,
                functionName: "sharesYes",
                args: [agentAddress],
            } as const,
            {
                address: market,
                abi: marketAbi,
                functionName: "sharesNo",
                args: [agentAddress],
            } as const,
        ]),
        allowFailure: true,
    });

    type Held = { market: Address; outcome: Outcome.Yes | Outcome.No; shares: bigint };
    const held: Held[] = [];
    unique.forEach((market, i) => {
        const resolved = probe[i * 3];
        const yes = probe[i * 3 + 1];
        const no = probe[i * 3 + 2];
        if (resolved.status !== "success" || resolved.result === true) return;
        if (yes.status === "success" && (yes.result as bigint) > 0n) {
            held.push({ market, outcome: Outcome.Yes, shares: yes.result as bigint });
        }
        if (no.status === "success" && (no.result as bigint) > 0n) {
            held.push({ market, outcome: Outcome.No, shares: no.result as bigint });
        }
    });
    if (held.length === 0) return [];

    // Phase 2 — full-exit quote for each held side.
    const quotes = await publicClient.multicall({
        contracts: held.map(
            (h) =>
                ({
                    address: h.market,
                    abi: marketAbi,
                    functionName: "previewSell",
                    args: [h.outcome, h.shares],
                }) as const,
        ),
        allowFailure: true,
    });

    return held.map((h, i) => ({
        market: h.market,
        outcome: h.outcome,
        shares: h.shares,
        exitProceeds:
            quotes[i].status === "success" ? (quotes[i].result as bigint) : 0n,
    }));
}

/** Single previewSell quote for a partial/full exit amount. */
export async function quoteExit(
    market: Address,
    outcome: Outcome.Yes | Outcome.No,
    shares: bigint,
): Promise<bigint> {
    const received = await publicClient.readContract({
        address: market,
        abi: marketAbi,
        functionName: "previewSell",
        args: [outcome, shares],
    });
    return received as bigint;
}

export { SIDES };
