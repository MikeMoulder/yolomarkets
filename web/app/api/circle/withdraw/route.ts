/**
 * POST /api/circle/withdraw
 *   body: { userToken, walletId, destinationAddress, amountMicro }
 *   → { txId }
 *
 * Withdraws USDC from the user's Developer-Controlled wallet to any external
 * address. Same auth model as execute-tx: the userToken must be a live Circle
 * email-OTP session and the wallet must be the one provisioned for that
 * Circle user. The client polls /api/circle/tx-hash with the txId.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { isAddress } from "viem";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import { getCurrentUser, transferFromDeveloperWallet } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    let body: {
        userToken?: string;
        walletId?: string;
        destinationAddress?: string;
        amountMicro?: string;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const { userToken, walletId, destinationAddress, amountMicro } = body;
    if (!userToken || !walletId || !destinationAddress || !amountMicro) {
        return NextResponse.json(
            { error: "missing required fields" },
            { status: 400 },
        );
    }
    if (!isAddress(destinationAddress)) {
        return NextResponse.json(
            { error: "invalid destination address" },
            { status: 400 },
        );
    }
    let amount: bigint;
    try {
        amount = BigInt(amountMicro);
    } catch {
        return NextResponse.json({ error: "invalid amount" }, { status: 400 });
    }
    if (amount <= 0n) {
        return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
    }

    let circleUserId: string;
    try {
        circleUserId = (await getCurrentUser(userToken)).id;
    } catch {
        return NextResponse.json(
            { error: "circle session expired", needsReconnect: true },
            { status: 401 },
        );
    }

    const rows = await db
        .select()
        .from(circleWallets)
        .where(eq(circleWallets.circleUserId, circleUserId))
        .limit(1);
    const row = rows[0] ?? null;
    if (!row || row.walletProvider !== "developer" || row.walletId !== walletId) {
        return NextResponse.json(
            {
                error: "wallet not linked to this session — reconnect your wallet",
                needsReconnect: true,
            },
            { status: 403 },
        );
    }

    try {
        const { txId } = await transferFromDeveloperWallet({
            walletId,
            destinationAddress,
            amountMicro: amount,
        });
        return NextResponse.json({ txId });
    } catch (e) {
        const detail = e instanceof Error ? e.message : "withdraw failed";
        return NextResponse.json(
            { error: "withdraw failed", detail },
            { status: 502 },
        );
    }
}
