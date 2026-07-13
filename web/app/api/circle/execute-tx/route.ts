/**
 * POST /api/circle/execute-tx
 *   body: { userToken, walletId, contractAddress, abiFunctionSignature, abiParameters }
 *
 * Initiates a contract call from a User-Controlled Circle wallet and returns
 * the { challengeId } the Web SDK confirms with the user's PIN. The on-chain
 * hash is fetched separately via /api/circle/tx-hash once the challenge
 * completes.
 *
 * The userToken comes from the user's own login session (email-OTP users are
 * Circle-managed, so we can't re-mint one server-side from circleUserId). The
 * token plus the PIN authorize every signature; we additionally pin the
 * callable surface to the handful of trade/insight functions the app needs,
 * to keep this from being a generic "sign anything" endpoint.
 */
import { NextResponse, type NextRequest } from "next/server";
import { executeUserContractCall } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_SIGNATURES = new Set([
    "transfer(address,uint256)",
    "approve(address,uint256)",
    "buy(uint8,uint256,uint256)",
    "sell(uint8,uint256,uint256)",
    "claim()",
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

    const {
        userToken,
        walletId,
        contractAddress,
        abiFunctionSignature,
        abiParameters,
    } = body;

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

    try {
        const { challengeId } = await executeUserContractCall({
            userToken,
            walletId,
            contractAddress,
            abiFunctionSignature,
            abiParameters: abiParameters ?? [],
        });
        return NextResponse.json({ challengeId });
    } catch (e) {
        const detail = e instanceof Error ? e.message : "circle execute failed";
        return NextResponse.json(
            { error: "circle execute failed", detail },
            { status: 502 },
        );
    }
}
