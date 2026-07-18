/**
 * Completes Circle-native email OTP login after W3SSdk.verifyOtp().
 *
 * The SDK returns the authenticated userToken; this route resolves the Circle
 * user id from it and provisions a Developer-Controlled wallet for that user
 * (Arcana-style custodial flow: OTP in, wallet ready, no PIN).
 *
 * Why not User-Controlled wallets: Circle's PIN-setup challenges started
 * failing with 155118 ("Invalid encryption key") for every new user between
 * 2026-06-22 and 2026-07-17 — reproduced with provably matched token/key
 * pairs and spec-exact requests, i.e. broken outside this repo. The email-OTP
 * verification itself kept working, so it remains the auth layer while the
 * wallet + signing moved to the Developer-Controlled product the agent
 * already uses. Legacy user-controlled rows (walletProvider null) get a new
 * developer wallet on next login; their old PIN wallets remain on-chain.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import { createDeveloperEmailWallet, getCurrentUser } from "@/lib/circle";
import { appendServerDiag } from "@/lib/circle-diag";

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
        // The userToken proves a live Circle email-OTP session; its user id
        // is the stable identity we key wallets on.
        const user = await getCurrentUser(body.userToken);

        const existing = await db
            .select()
            .from(circleWallets)
            .where(eq(circleWallets.circleUserId, user.id))
            .limit(1);
        const row = existing[0] ?? null;

        if (
            row?.walletProvider === "developer" &&
            row.walletId &&
            row.walletAddress
        ) {
            appendServerDiag(
                `email/complete login user=${user.id.slice(0, 8)} dev-wallet=${row.walletAddress.slice(0, 10)}`,
            );
            return NextResponse.json({
                flow: "login",
                circleUserId: user.id,
                ready: true,
                address: row.walletAddress,
                wallets: [
                    { id: row.walletId, address: row.walletAddress, state: "LIVE" },
                ],
            });
        }

        // First login (or legacy user-controlled row) → provision a
        // developer wallet. Idempotent on Circle's side via uuid5 key.
        const wallet = await createDeveloperEmailWallet(user.id);
        const address = wallet.address.toLowerCase();
        appendServerDiag(
            `email/complete provisioned dev wallet user=${user.id.slice(0, 8)} wallet=${address.slice(0, 10)} (was provider=${row?.walletProvider ?? "none"})`,
        );

        try {
            await db
                .insert(circleWallets)
                .values({
                    circleUserId: user.id,
                    email,
                    walletId: wallet.id,
                    walletAddress: address,
                    walletProvider: "developer",
                    status: "provisioned",
                    provisionedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: circleWallets.circleUserId,
                    set: {
                        email,
                        walletId: wallet.id,
                        walletAddress: address,
                        walletProvider: "developer",
                        challengeId: null,
                        status: "provisioned",
                        provisionedAt: new Date(),
                    },
                });
        } catch (e) {
            console.error("[circle/email/complete] persist failed:", e);
        }

        return NextResponse.json({
            flow: "onboarding",
            circleUserId: user.id,
            ready: true,
            address,
            wallets: [{ id: wallet.id, address, state: "LIVE" }],
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendServerDiag(`email/complete FAIL ${msg.slice(0, 200)}`);
        return NextResponse.json(
            {
                error: "Circle email login completion failed",
                detail: msg.slice(0, 400),
            },
            { status: 503 },
        );
    }
}
