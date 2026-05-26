/**
 * GET /api/circle/wallet?userId=<circleUserId>
 *
 * Polls Circle for the user's provisioned wallets. After the client
 * completes the Web SDK PIN flow, the SCA wallet on Arc takes a few
 * seconds to land — the client polls this endpoint until it gets back
 * an address (status: "provisioned").
 *
 * POST /api/circle/wallet
 *   body: { circleUserId, userToken }
 *
 * Same data, but uses a userToken supplied by the client instead of
 * minting a fresh one. Use POST while the client still has the token in
 * memory (saves a round-trip and avoids spamming /users/token).
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import { createUserToken, listUserWallets } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveAndPersist(opts: {
    circleUserId: string;
    userToken: string;
}) {
    const wallets = await listUserWallets(opts.userToken);
    // We only ever request one chain (Arc) so we expect 0 or 1 wallet.
    // If Circle returns multiple due to a re-init we keep the first one
    // marked LIVE / available; the rest are noise for our purposes.
    const w = wallets.find((x) => x.state === "LIVE") ?? wallets[0] ?? null;
    if (w && w.address) {
        try {
            await db
                .update(circleWallets)
                .set({
                    walletId: w.id,
                    walletAddress: w.address.toLowerCase(),
                    status: "provisioned",
                    provisionedAt: new Date(),
                })
                .where(eq(circleWallets.circleUserId, opts.circleUserId));
        } catch (e) {
            console.error("[circle/wallet] persist failed:", e);
        }
    }
    return { wallets, primary: w };
}

export async function GET(req: NextRequest) {
    const userId = req.nextUrl.searchParams.get("userId");
    if (!userId)
        return NextResponse.json({ error: "userId required" }, { status: 400 });

    try {
        const { userToken } = await createUserToken(userId);
        const { wallets, primary } = await resolveAndPersist({
            circleUserId: userId,
            userToken,
        });
        return NextResponse.json({
            userId,
            wallets,
            address: primary?.address ?? null,
            ready: !!(primary && primary.state === "LIVE"),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: "Circle wallet lookup failed", detail: msg.slice(0, 400) },
            { status: 503 },
        );
    }
}

export async function POST(req: NextRequest) {
    let body: { circleUserId?: string; userToken?: string };
    try {
        body = await req.json();
    } catch {
        body = {};
    }
    if (!body.circleUserId || !body.userToken) {
        return NextResponse.json(
            { error: "circleUserId and userToken required" },
            { status: 400 },
        );
    }

    try {
        const { wallets, primary } = await resolveAndPersist({
            circleUserId: body.circleUserId,
            userToken: body.userToken,
        });
        return NextResponse.json({
            userId: body.circleUserId,
            wallets,
            address: primary?.address ?? null,
            ready: !!(primary && primary.state === "LIVE"),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: "Circle wallet lookup failed", detail: msg.slice(0, 400) },
            { status: 503 },
        );
    }
}
