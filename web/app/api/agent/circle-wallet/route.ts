import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { verifyProfileAuth } from "@/lib/auth-sig";
import {
    createDeveloperAgentWallet,
    createDeveloperPaymentsWallet,
} from "@/lib/circle";
import { bindAgentWallet, getAgentWallet } from "@/lib/agent-wallets";
import { db } from "@/lib/db";
import { agentProfiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    userAddr?: string;
};

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        body = {};
    }

    if (!body.userAddr || !isAddress(body.userAddr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }

    const auth = await verifyProfileAuth(
        req.headers,
        body.userAddr,
        "agent.wallet.create",
    );
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // Wallet identity is resolved from the server-owned binding store, never
    // from the (client-writable) profile — see audit C-1 / H-3.
    const existing = await getAgentWallet(body.userAddr);
    if (existing) {
        return NextResponse.json({
            walletId: existing.walletId,
            address: existing.agentAddress,
            reused: true,
        });
    }

    try {
        // Circle creation is idempotent per user (uuid5(`agent-<addr>`)) so a
        // double-submit returns the same wallet; bindAgentWallet then upserts.
        const wallet = await createDeveloperAgentWallet(body.userAddr);
        const bound = await bindAgentWallet({
            userAddr: body.userAddr.toLowerCase() as `0x${string}`,
            walletId: wallet.id,
            agentAddress: wallet.address.toLowerCase() as `0x${string}`,
        });

        // Also provision the EOA the agent pays its running costs from. This is
        // best effort on purpose: if it fails the agent still trades, it just
        // settles fees by plain transfer instead of on the payment rail. A
        // wallet failure here must not block someone from onboarding.
        try {
            const payments = await createDeveloperPaymentsWallet(body.userAddr);
            await db
                .update(agentProfiles)
                .set({
                    paymentsWalletId: payments.id,
                    paymentsAddress: payments.address.toLowerCase(),
                    updatedAt: new Date(),
                })
                .where(eq(agentProfiles.userAddr, body.userAddr.toLowerCase()));
        } catch (e) {
            console.warn(
                "[circle-wallet] payments wallet not provisioned:",
                e instanceof Error ? e.message : e,
            );
        }
        return NextResponse.json({
            walletId: bound.walletId,
            address: bound.agentAddress,
            reused: false,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const needsSetup =
            msg.includes("CIRCLE_API_KEY") ||
            msg.includes("CIRCLE_ENTITY_SECRET") ||
            msg.includes("CIRCLE_WALLET_SET_ID") ||
            msg.includes("walletSetId") ||
            msg.includes("see CIRCLE_SETUP.md");
        return NextResponse.json(
            {
                error: needsSetup
                    ? "Circle not configured — see CIRCLE_SETUP.md"
                    : "Circle agent wallet creation failed",
                detail: msg.slice(0, 400),
                needsSetup,
            },
            { status: 503 },
        );
    }
}
