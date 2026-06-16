/**
 * Completes Circle-native email OTP login after W3SSdk.verifyOtp().
 *
 * The SDK returns the authenticated userToken/encryptionKey. This route
 * resolves the Circle user id, stores the email link, and reports whether
 * the user already has a wallet. If not, it creates an initialization
 * challenge using the authenticated session so the client can provision one.
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import {
    CIRCLE_BLOCKCHAIN,
    createUserWalletChallenge,
    getCurrentUser,
    initializeUserPin,
    listUserWallets,
} from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    email?: string;
    userToken?: string;
};

function normalizeEmail(email: string | undefined) {
    const trimmed = email?.trim().toLowerCase();
    return trimmed || null;
}

async function persistCircleWallet(opts: {
    circleUserId: string;
    email: string | null;
    walletId?: string | null;
    walletAddress?: string | null;
    challengeId?: string | null;
    status: "pending" | "provisioned";
}) {
    await db
        .insert(circleWallets)
        .values({
            circleUserId: opts.circleUserId,
            email: opts.email,
            walletId: opts.walletId ?? null,
            walletAddress: opts.walletAddress ?? null,
            challengeId: opts.challengeId ?? null,
            status: opts.status,
            provisionedAt: opts.status === "provisioned" ? new Date() : null,
        })
        .onConflictDoUpdate({
            target: circleWallets.circleUserId,
            set: {
                email: opts.email,
                walletId: opts.walletId ?? null,
                walletAddress: opts.walletAddress ?? null,
                challengeId: opts.challengeId ?? null,
                status: opts.status,
                provisionedAt:
                    opts.status === "provisioned" ? new Date() : null,
            },
        });
}

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        body = {};
    }

    const email = normalizeEmail(body.email);
    if (!email || !body.userToken) {
        return NextResponse.json(
            { error: "email and userToken required" },
            { status: 400 },
        );
    }

    try {
        const user = await getCurrentUser(body.userToken);
        const wallets = await listUserWallets(body.userToken);
        const wallet =
            wallets.find(
                (x) => x.blockchain === CIRCLE_BLOCKCHAIN && x.state === "LIVE",
            ) ??
            wallets.find((x) => x.blockchain === CIRCLE_BLOCKCHAIN) ??
            null;

        if (wallet?.address) {
            const address = wallet.address.toLowerCase();
            try {
                await persistCircleWallet({
                    circleUserId: user.id,
                    email,
                    walletId: wallet.id,
                    walletAddress: address,
                    status: "provisioned",
                });
            } catch (e) {
                console.error("[circle/email/complete] persist failed:", e);
            }
            return NextResponse.json({
                flow: "login",
                circleUserId: user.id,
                ready: wallet.state === "LIVE",
                address,
                wallets,
            });
        }

        const { challengeId } =
            user.pinStatus === "ENABLED"
                ? await createUserWalletChallenge({ userToken: body.userToken })
                : await initializeUserPin({ userToken: body.userToken });
        try {
            await persistCircleWallet({
                circleUserId: user.id,
                email,
                challengeId,
                status: "pending",
            });
        } catch (e) {
            console.error("[circle/email/complete] persist pending failed:", e);
        }
        return NextResponse.json({
            flow: "onboarding",
            circleUserId: user.id,
            challengeId,
            ready: false,
            wallets,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            {
                error: "Circle email login completion failed",
                detail: msg.slice(0, 400),
            },
            { status: 503 },
        );
    }
}
