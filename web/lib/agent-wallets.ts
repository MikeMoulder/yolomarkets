/**
 * Server-owned binding of a user's EOA → their Circle Developer-Controlled
 * agent wallet. This module is the single trusted source of (userAddr →
 * walletId / agentAddress).
 *
 * Security invariant: wallet identity NEVER comes from client input. Only the
 * authenticated creation route writes a binding, and `wallet_id` is UNIQUE so
 * one Circle wallet can never be bound to two users. Fund-moving routes and
 * profile saves resolve the wallet from here — see audit findings C-1 / H-3.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentWallets } from "./db/schema";

export type AgentWalletBinding = {
    userAddr: `0x${string}`;
    walletId: string;
    agentAddress: `0x${string}`;
};

function norm(addr: string): `0x${string}` {
    return addr.toLowerCase() as `0x${string}`;
}

export async function getAgentWallet(
    userAddr: string,
): Promise<AgentWalletBinding | null> {
    const rows = await db
        .select()
        .from(agentWallets)
        .where(eq(agentWallets.userAddr, norm(userAddr)))
        .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
        userAddr: r.userAddr as `0x${string}`,
        walletId: r.walletId,
        agentAddress: r.agentAddress as `0x${string}`,
    };
}

/**
 * Persist the binding for a freshly-provisioned wallet. Idempotent per user.
 * The UNIQUE(wallet_id) constraint makes this throw if the wallet is already
 * bound to a *different* user — a hard signal of an attempted cross-account
 * binding. Callers should surface that as an error, not silently succeed.
 */
export async function bindAgentWallet(
    b: AgentWalletBinding,
): Promise<AgentWalletBinding> {
    const now = new Date();
    const [saved] = await db
        .insert(agentWallets)
        .values({
            userAddr: norm(b.userAddr),
            walletId: b.walletId,
            agentAddress: norm(b.agentAddress),
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: agentWallets.userAddr,
            set: {
                walletId: b.walletId,
                agentAddress: norm(b.agentAddress),
                updatedAt: now,
            },
        })
        .returning();
    return {
        userAddr: saved.userAddr as `0x${string}`,
        walletId: saved.walletId,
        agentAddress: saved.agentAddress as `0x${string}`,
    };
}
