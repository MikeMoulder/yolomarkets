import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";

// Agent v2 · M3 — record a user-confirmed chat trade to the agent's journal.
// Fire-and-forget from the client after the on-chain buy confirms; forwards to
// the Python agent service with the internal shared secret.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_URL = process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:8080";

export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    const userAddr = String(body.userAddr ?? "");
    if (!isAddress(userAddr)) {
        return NextResponse.json({ error: "a connected wallet is required" }, { status: 400 });
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.AGENT_CHAT_SHARED_SECRET) {
        headers["X-Agent-Secret"] = process.env.AGENT_CHAT_SHARED_SECRET;
    }

    try {
        const upstream = await fetch(`${AGENT_URL}/chat/record`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                user_addr: userAddr,
                market: body.market,
                question: body.question,
                side: body.side,
                shares_human: body.sharesHuman,
                cost_usdc: body.costUsdc,
                tx_hash: body.txHash,
            }),
        });
        const data = await upstream.json().catch(() => ({}));
        return NextResponse.json(data, { status: upstream.ok ? 200 : 502 });
    } catch {
        return NextResponse.json({ error: "agent service unreachable" }, { status: 502 });
    }
}
