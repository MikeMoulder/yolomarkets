import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getProfile } from "@/lib/agent-profiles";
import { verifyProfileAuth } from "@/lib/auth-sig";
import { createDeveloperAgentWallet } from "@/lib/circle";

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

    const existing = await getProfile(body.userAddr);
    if (existing?.circleWalletId && existing.agentAddress) {
        return NextResponse.json({
            walletId: existing.circleWalletId,
            address: existing.agentAddress,
            reused: true,
        });
    }

    try {
        const wallet = await createDeveloperAgentWallet(body.userAddr);
        return NextResponse.json({
            walletId: wallet.id,
            address: wallet.address.toLowerCase(),
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
