/**
 * POST /api/circle/execute-tx
 *   body: { userToken, walletId, contractAddress, abiFunctionSignature, abiParameters }
 *   → { txId }
 *
 * Executes a contract call from the user's Developer-Controlled wallet.
 * The server signs via Circle's entity secret — no PIN challenge, no Web SDK.
 * The client polls /api/circle/tx-hash with the returned txId for the
 * on-chain hash.
 *
 * Authorization: the userToken must be a live Circle email-OTP session, and
 * the wallet must be the one provisioned for THAT Circle user in our DB.
 * Without this check the endpoint would sign for any wallet id passed in.
 * The callable surface is pinned to the app's trade functions.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import { executeDeveloperContractCall, getCurrentUser } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_SIGNATURES = new Set([
    "transfer(address,uint256)",
    "approve(address,uint256)",
    "buy(uint8,uint256,uint256)",
    "sell(uint8,uint256,uint256)",
    "claim()",
    "claimRefund()",
]);

export async function POST(req: NextRequest) {
    let body: {
        userToken?: string;
        walletId?: string;
        contractAddress?: string;
        abiFunctionSignature?: string;
        abiParameters?: unknown[];
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const { userToken, walletId, contractAddress, abiFunctionSignature, abiParameters } = body;

    if (!userToken || !walletId || !contractAddress || !abiFunctionSignature) {
        return NextResponse.json(
            { error: "missing required fields" },
            { status: 400 },
        );
    }

    if (!ALLOWED_SIGNATURES.has(abiFunctionSignature)) {
        return NextResponse.json(
            { error: "function not allowed" },
            { status: 403 },
        );
    }

    // Auth: resolve the Circle user behind the session token. An expired or
    // invalid token throws → 401 → client asks the user to reconnect.
    let circleUserId: string;
    try {
        const user = await getCurrentUser(userToken);
        circleUserId = user.id;
    } catch {
        return NextResponse.json(
            {
                error: "circle session expired",
                needsReconnect: true,
            },
            { status: 401 },
        );
    }

    // Authorization: the wallet must belong to this Circle user and be one of
    // our developer-controlled wallets.
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
        const { txId } = await executeDeveloperContractCall({
            walletId,
            contractAddress,
            abiFunctionSignature,
            abiParameters: abiParameters ?? [],
        });
        return NextResponse.json({ txId });
    } catch (e) {
        const detail = e instanceof Error ? e.message : "circle execute failed";
        return NextResponse.json(
            { error: "circle execute failed", detail },
            { status: 502 },
        );
    }
}
