import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { verifyProfileAuth } from "@/lib/auth-sig";
import { createDeveloperAgentWallet } from "@/lib/circle";
import { bindAgentWallet, getAgentWallet } from "@/lib/agent-wallets";

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
