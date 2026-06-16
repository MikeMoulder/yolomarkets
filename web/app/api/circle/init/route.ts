/**
 * Circle User-Controlled Wallets login/onboarding kickoff.
 *
 * POST /api/circle/init
 *   body: { email?: string }
 *   returns: { circleUserId, userToken, encryptionKey, challengeId, flow }
 *
 * The client hands userToken + encryptionKey + challengeId to Circle's Web
 * SDK, which renders the PIN UX. Existing emails get a sign-message
 * challenge for the provisioned wallet; new emails get initialization
 * with SCA wallet creation on Arc testnet. After completion, the client
 * polls GET /api/circle/wallet?userId=... to retrieve the address.
 *
 * Why an API route and not a Server Action: Circle's Web SDK runs on the
 * client and needs the userToken returned synchronously in the JSON
 * response — Server Actions don't compose with that flow as cleanly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { circleWallets, type CircleWalletRow } from "@/lib/db/schema";
import {
    createSignMessageChallenge,
    createUserToken,
    initOnboarding,
    listUserWallets,
} from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    email?: string;
};

function normalizeEmail(email: string | undefined) {
    const trimmed = email?.trim().toLowerCase();
    return trimmed || null;
}

async function findExistingCircleWallet(
    email: string,
): Promise<CircleWalletRow | null> {
    const provisioned = await db
        .select()
        .from(circleWallets)
        .where(
            and(
                sql`lower(${circleWallets.email}) = ${email}`,
                isNotNull(circleWallets.walletAddress),
            ),
        )
        .orderBy(desc(circleWallets.provisionedAt), desc(circleWallets.createdAt))
        .limit(1);
    if (provisioned[0]) return provisioned[0];

    const pending = await db
        .select()
        .from(circleWallets)
        .where(
            and(
                sql`lower(${circleWallets.email}) = ${email}`,
                eq(circleWallets.status, "pending"),
            ),
        )
        .orderBy(desc(circleWallets.createdAt))
        .limit(1);
    return pending[0] ?? null;
}

function buildSigninMessage(opts: {
    email: string;
    circleUserId: string;
    walletAddress: string;
}) {
    return [
        "Sign in to YOLO Markets.",
        "",
        `Email: ${opts.email}`,
        `Wallet: ${opts.walletAddress.toLowerCase()}`,
        `Circle user: ${opts.circleUserId}`,
        `Issued at: ${new Date().toISOString()}`,
    ].join("\n");
}

async function refreshProvisionedWallet(
    row: CircleWalletRow,
): Promise<CircleWalletRow> {
    if (row.walletAddress) return row;

    const { userToken } = await createUserToken(row.circleUserId);
    const wallets = await listUserWallets(userToken);
    const wallet = wallets.find((x) => x.state === "LIVE") ?? wallets[0] ?? null;
    if (!wallet?.address) return row;

    const walletAddress = wallet.address.toLowerCase();
    await db
        .update(circleWallets)
        .set({
            walletId: wallet.id,
            walletAddress,
            status: "provisioned",
            provisionedAt: new Date(),
        })
        .where(eq(circleWallets.circleUserId, row.circleUserId));

    return {
        ...row,
        walletId: wallet.id,
        walletAddress,
        status: "provisioned",
        provisionedAt: new Date(),
    };
}

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        body = {};
    }
    const email = normalizeEmail(body.email);

    let existing: Awaited<ReturnType<typeof findExistingCircleWallet>> = null;
    if (email) {
        try {
            existing = await findExistingCircleWallet(email);
            if (existing) {
                existing = await refreshProvisionedWallet(existing);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return NextResponse.json(
                {
                    error: "Circle login lookup failed",
                    detail: msg.slice(0, 400),
                },
                { status: 503 },
            );
        }
    }

    if (existing?.walletAddress) {
        try {
            const { userToken, encryptionKey } = await createUserToken(
                existing.circleUserId,
            );
            const { challengeId } = await createSignMessageChallenge({
                userToken,
                walletId: existing.walletId,
                walletAddress: existing.walletAddress,
                message: buildSigninMessage({
                    email: email ?? existing.email ?? "",
                    circleUserId: existing.circleUserId,
                    walletAddress: existing.walletAddress,
                }),
            });
            return NextResponse.json({
                circleUserId: existing.circleUserId,
                userToken,
                encryptionKey,
                challengeId,
                flow: "login",
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return NextResponse.json(
                {
                    error: "Circle login challenge failed",
                    detail: msg.slice(0, 400),
                },
                { status: 503 },
            );
        }
    }

    let result;
    try {
        result = await initOnboarding(existing?.circleUserId);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Distinguish "Console not configured" (user-fixable, prompt for
        // setup) from a transient API failure (retryable, no setup work
        // required). Both signal status-503 to the client but the message
        // differs so the UI can render the right call-to-action.
        const needsSetup =
            msg.includes("CIRCLE_API_KEY") ||
            msg.includes("CIRCLE_ENTITY_SECRET") ||
            msg.includes("see CIRCLE_SETUP.md");
        return NextResponse.json(
            {
                error: needsSetup
                    ? "Circle not configured — see CIRCLE_SETUP.md"
                    : "Circle onboarding init failed",
                detail: msg.slice(0, 400),
                needsSetup,
            },
            { status: 503 },
        );
    }

    // Persist a pending row so we can join the eventual on-chain address
    // back to the (optional) email. The Web SDK will hit `wallet/route.ts`
    // once it has the wallet provisioned to fill in walletAddress.
    try {
        if (existing) {
            await db
                .update(circleWallets)
                .set({
                    email,
                    challengeId: result.challengeId,
                    status: "pending",
                })
                .where(eq(circleWallets.circleUserId, result.circleUserId));
        } else {
            await db.insert(circleWallets).values({
                circleUserId: result.circleUserId,
                email,
                challengeId: result.challengeId,
                status: "pending",
            });
        }
    } catch (e) {
        // Best-effort persistence — if the DB write fails we still return
        // success because the user can still complete the PIN flow; we
        // just lose the email link. Log loudly.
        console.error("[circle/init] failed to persist row:", e);
    }

    return NextResponse.json({
        circleUserId: result.circleUserId,
        userToken: result.userToken,
        encryptionKey: result.encryptionKey,
        challengeId: result.challengeId,
        flow: "onboarding",
    });
}
