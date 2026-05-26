/**
 * Circle User-Controlled Wallets onboarding kickoff.
 *
 * POST /api/circle/init
 *   body: { email?: string }
 *   returns: { circleUserId, userToken, encryptionKey, challengeId }
 *
 * The client hands userToken + encryptionKey + challengeId to Circle's Web
 * SDK, which renders the PIN UX and completes the on-chain wallet creation
 * (an SCA wallet on Arc testnet). After completion, the client should poll
 * GET /api/circle/wallet?userId=... to retrieve the provisioned address.
 *
 * Why an API route and not a Server Action: Circle's Web SDK runs on the
 * client and needs the userToken returned synchronously in the JSON
 * response — Server Actions don't compose with that flow as cleanly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { circleWallets } from "@/lib/db/schema";
import { initOnboarding } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    email?: string;
};

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        body = {};
    }

    let result;
    try {
        result = await initOnboarding();
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
        await db.insert(circleWallets).values({
            circleUserId: result.circleUserId,
            email: body.email ?? null,
            challengeId: result.challengeId,
            status: "pending",
        });
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
    });
}
