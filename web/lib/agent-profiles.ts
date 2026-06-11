/**
 * Postgres-backed agent profile store. Drop-in replacement for the
 * Tier-0 JSON file at agent/profiles.json — public API is preserved so
 * call sites in API routes / wizard / settings don't change.
 *
 * Row shape lives in lib/db/schema.ts; conversion to/from the AgentProfile
 * shape happens here so consumers stay typed in domain terms.
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentProfiles, type AgentProfileRow } from "./db/schema";
import type { PatternId, SignalSource } from "./agent-patterns";

export type AgentProfile = {
    userAddr: `0x${string}`;
    pattern: PatternId;
    cadenceMinutes: number;
    kellyMult: number;
    edgeThreshold: number;
    minConfidence: number;
    signals: SignalSource[];
    marketsMode: "all" | "categories" | "watchlist";
    categories: string[];
    watchlist: `0x${string}`[];
    budgetTotal: number;
    budgetPerMarket: number;
    budgetPerDay: number;
    agentAddress: `0x${string}` | null;
    sessionKeyAddress: `0x${string}` | null;
    sessionValidUntil: number | null;
    sessionTotalCap: number | null;
    sessionPerCallCap: number | null;
    telegramChatId: string | null;
    telegramEnabled: boolean;
    telegramEvents: string[];
    active: boolean;
    pausedUntil: string | null;
    createdAt: string;
    updatedAt: string;
};

function normalizeAddr(addr: string): `0x${string}` {
    return addr.toLowerCase() as `0x${string}`;
}

function rowToProfile(r: AgentProfileRow): AgentProfile {
    return {
        userAddr: r.userAddr as `0x${string}`,
        pattern: r.pattern as PatternId,
        cadenceMinutes: r.cadenceMinutes,
        kellyMult: Number(r.kellyMult),
        edgeThreshold: Number(r.edgeThreshold),
        minConfidence: Number(r.minConfidence),
        signals: (r.signals ?? []) as SignalSource[],
        marketsMode: r.marketsMode as AgentProfile["marketsMode"],
        categories: r.categories ?? [],
        watchlist: (r.watchlist ?? []) as `0x${string}`[],
        budgetTotal: Number(r.budgetTotal),
        budgetPerMarket: Number(r.budgetPerMarket),
        budgetPerDay: Number(r.budgetPerDay),
        agentAddress: r.agentAddress as `0x${string}` | null,
        sessionKeyAddress: r.sessionKeyAddress as `0x${string}` | null,
        sessionValidUntil: r.sessionValidUntil,
        sessionTotalCap:
            r.sessionTotalCap != null ? Number(r.sessionTotalCap) : null,
        sessionPerCallCap:
            r.sessionPerCallCap != null ? Number(r.sessionPerCallCap) : null,
        telegramChatId: r.telegramChatId,
        telegramEnabled: r.telegramEnabled,
        telegramEvents: r.telegramEvents ?? [],
        active: r.active,
        pausedUntil: r.pausedUntil ? r.pausedUntil.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
    };
}

export async function getProfile(
    userAddr: string,
): Promise<AgentProfile | null> {
    const rows = await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.userAddr, normalizeAddr(userAddr)))
        .limit(1);
    return rows[0] ? rowToProfile(rows[0]) : null;
}

export async function listProfiles(): Promise<AgentProfile[]> {
    const rows = await db.select().from(agentProfiles);
    return rows.map(rowToProfile);
}

export async function upsertProfile(
    profile: Omit<AgentProfile, "createdAt" | "updatedAt"> &
        Partial<Pick<AgentProfile, "createdAt" | "updatedAt">>,
): Promise<AgentProfile> {
    const key = normalizeAddr(profile.userAddr);
    const now = new Date();

    const values = {
        userAddr: key,
        pattern: profile.pattern,
        cadenceMinutes: profile.cadenceMinutes,
        kellyMult: profile.kellyMult.toString(),
        edgeThreshold: profile.edgeThreshold.toString(),
        minConfidence: profile.minConfidence.toString(),
        signals: profile.signals,
        marketsMode: profile.marketsMode,
        categories: profile.categories,
        watchlist: profile.watchlist,
        budgetTotal: profile.budgetTotal.toString(),
        budgetPerMarket: profile.budgetPerMarket.toString(),
        budgetPerDay: profile.budgetPerDay.toString(),
        agentAddress: profile.agentAddress,
        sessionKeyAddress: profile.sessionKeyAddress,
        sessionValidUntil: profile.sessionValidUntil,
        sessionTotalCap:
            profile.sessionTotalCap != null
                ? profile.sessionTotalCap.toString()
                : null,
        sessionPerCallCap:
            profile.sessionPerCallCap != null
                ? profile.sessionPerCallCap.toString()
                : null,
        telegramChatId: profile.telegramChatId ?? null,
        telegramEnabled: profile.telegramEnabled ?? false,
        telegramEvents: profile.telegramEvents ?? ["live_trade"],
        active: profile.active,
        pausedUntil: profile.pausedUntil ? new Date(profile.pausedUntil) : null,
        updatedAt: now,
    };

    const [saved] = await db
        .insert(agentProfiles)
        .values({
            ...values,
            createdAt: profile.createdAt ? new Date(profile.createdAt) : now,
        })
        .onConflictDoUpdate({
            target: agentProfiles.userAddr,
            set: values,
        })
        .returning();

    return rowToProfile(saved);
}

export async function deleteProfile(userAddr: string): Promise<boolean> {
    const result = await db
        .delete(agentProfiles)
        .where(eq(agentProfiles.userAddr, normalizeAddr(userAddr)))
        .returning({ userAddr: agentProfiles.userAddr });
    return result.length > 0;
}

export async function setActive(
    userAddr: string,
    active: boolean,
    pausedUntil: string | null = null,
): Promise<AgentProfile | null> {
    const key = normalizeAddr(userAddr);
    const [updated] = await db
        .update(agentProfiles)
        .set({
            active,
            pausedUntil: pausedUntil ? new Date(pausedUntil) : null,
            updatedAt: new Date(),
        })
        .where(eq(agentProfiles.userAddr, key))
        .returning();
    return updated ? rowToProfile(updated) : null;
}
