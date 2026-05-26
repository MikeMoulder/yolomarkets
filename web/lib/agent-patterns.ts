/**
 * Five trading-pattern presets exposed to the user in /agent/setup.
 * Each preset compiles down to the same Decision-engine knobs the
 * Python loop already consumes (kelly mult, edge threshold, min confidence,
 * signal sources, cadence).
 *
 * Picking a pattern fills the agent profile; "custom" lets the user override
 * any knob individually.
 */

export type PatternId = "arb" | "value" | "event_hunter" | "slow_build" | "custom";
export type SignalSource = "ai" | "polymarket";

export type PatternDef = {
    id: PatternId;
    name: string;
    oneLiner: string;
    longCopy: string;
    cadenceMinutes: number;
    kellyMult: number;
    edgeThreshold: number;     // 0..1, as a fraction (0.05 = 5pt)
    minConfidence: number;     // 0..1
    signals: SignalSource[];
    /** Hard-coded per-market cap override (USDC) — null = use profile default */
    perMarketHardCap: number | null;
};

export const PATTERNS: Record<Exclude<PatternId, "custom">, PatternDef> = {
    arb: {
        id: "arb",
        name: "Crowd arbitrage",
        oneLiner:
            "Trade only when our AMM disagrees with Polymarket by more than 5pt.",
        longCopy:
            "Pure signal arbitrage — no LLM cost. The agent compares the on-chain price against Polymarket every 15 minutes and takes the side our market is mispricing. Best for users who trust crowd wisdom and want predictable, low-thinking trades.",
        cadenceMinutes: 15,
        kellyMult: 0.5,
        edgeThreshold: 0.05,
        minConfidence: 0.0,
        signals: ["polymarket"],
        perMarketHardCap: null,
    },
    value: {
        id: "value",
        name: "Calibrated value",
        oneLiner:
            "Claude estimates the probability from first principles, agent sizes by edge.",
        longCopy:
            "The default. Claude reads each market's resolution criteria and gives an independent probability, then Kelly-sizes the bet against the on-chain price. Conviction-aware: skips markets where confidence is below 45%. Trades every 30 minutes.",
        cadenceMinutes: 30,
        kellyMult: 0.5,
        edgeThreshold: 0.07,
        minConfidence: 0.45,
        signals: ["ai", "polymarket"],
        perMarketHardCap: null,
    },
    event_hunter: {
        id: "event_hunter",
        name: "Event hunter",
        oneLiner:
            "Watch markets resolving in under 24h. High cadence, high conviction only.",
        longCopy:
            "Fires every 5 minutes against markets within 24 hours of resolution. Demands tight edges (10pt+) and high confidence (60%+), but plays them at quarter-Kelly to ride volatility into settlement. Best for active periods with fresh catalysts.",
        cadenceMinutes: 5,
        kellyMult: 0.25,
        edgeThreshold: 0.10,
        minConfidence: 0.60,
        signals: ["ai", "polymarket"],
        perMarketHardCap: null,
    },
    slow_build: {
        id: "slow_build",
        name: "Slow build",
        oneLiner:
            "Daily run, quarter-Kelly, max $1 per market. Builds a diverse book passively.",
        longCopy:
            "Runs once a day with very conservative sizing. Designed to accumulate small positions across many uncorrelated markets — closer to portfolio construction than active trading. Lowest LLM cost, lowest variance.",
        cadenceMinutes: 1440,
        kellyMult: 0.25,
        edgeThreshold: 0.06,
        minConfidence: 0.40,
        signals: ["ai", "polymarket"],
        perMarketHardCap: 1,
    },
};

export const PATTERN_LIST: readonly PatternDef[] = Object.values(PATTERNS);

export type RiskOverride = {
    cadenceMinutes: number;
    kellyMult: number;
    edgeThreshold: number;
    minConfidence: number;
    signals: SignalSource[];
};

/** Resolve a pattern to its concrete engine knobs.
 *  For "custom", caller MUST supply an override. */
export function resolvePattern(
    pattern: PatternId,
    override?: RiskOverride,
): RiskOverride & { perMarketHardCap: number | null } {
    if (pattern === "custom") {
        if (!override) {
            throw new Error("custom pattern requires explicit risk override");
        }
        return { ...override, perMarketHardCap: null };
    }
    const def = PATTERNS[pattern];
    return {
        cadenceMinutes: def.cadenceMinutes,
        kellyMult: def.kellyMult,
        edgeThreshold: def.edgeThreshold,
        minConfidence: def.minConfidence,
        signals: [...def.signals],
        perMarketHardCap: def.perMarketHardCap,
    };
}
