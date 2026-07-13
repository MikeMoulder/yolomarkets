/**
 * POST /api/circle/tx-hash
 *   body: { userToken, walletId, sinceMs }
 *
 * After the Web SDK confirms a contract-execution challenge, the client polls
 * here for the resulting on-chain transaction hash. User-controlled wallets
 * don't return a transaction id at creation time, so we list the wallet's
 * recent transactions and wait for the one created after `sinceMs` to confirm.
 *
 * Each call is capped below the serverless time limit; the client retries if
 * confirmation takes longer than one window.
 */
import { NextResponse, type NextRequest } from "next/server";
import { waitForUserTransactionHash } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
    let body: { userToken?: string; walletId?: string; sinceMs?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const { userToken, walletId, sinceMs } = body;
    if (!userToken || !walletId) {
        return NextResponse.json(
            { error: "missing required fields" },
            { status: 400 },
        );
    }

    try {
        const txHash = await waitForUserTransactionHash({
            userToken,
            walletId,
            sinceMs: typeof sinceMs === "number" ? sinceMs : Date.now() - 120_000,
            maxWaitMs: 50_000,
        });
        return NextResponse.json({ txHash });
    } catch (e) {
        const detail = e instanceof Error ? e.message : "tx lookup failed";
        // 504 signals "not confirmed yet" so the client knows to retry.
        return NextResponse.json({ error: "tx lookup failed", detail }, { status: 504 });
    }
}
