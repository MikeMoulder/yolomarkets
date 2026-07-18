/**
 * POST /api/circle/tx-hash
 *   body: { txId }
 *   → { txHash } once mined, { pending: true } (202) while in flight
 *
 * Status lookup for a Developer-Controlled transaction started by
 * /api/circle/execute-tx. Returns immediately; the client polls. A FAILED or
 * CANCELLED transaction returns 502 with the state so the UI can surface it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDeveloperTransaction } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    let body: { txId?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    if (!body.txId) {
        return NextResponse.json({ error: "txId required" }, { status: 400 });
    }

    try {
        const { state, txHash } = await getDeveloperTransaction(body.txId);
        if (state === "FAILED" || state === "CANCELLED") {
            return NextResponse.json(
                { error: `transaction ${state.toLowerCase()}`, state },
                { status: 502 },
            );
        }
        if ((state === "CONFIRMED" || state === "COMPLETE") && txHash) {
            return NextResponse.json({ txHash, state });
        }
        return NextResponse.json({ pending: true, state }, { status: 202 });
    } catch (e) {
        const detail = e instanceof Error ? e.message : "tx lookup failed";
        return NextResponse.json({ error: "tx lookup failed", detail }, { status: 502 });
    }
}
