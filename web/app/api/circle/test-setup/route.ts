/**
 * TEMPORARY 155118 isolation probe — remove after diagnosis.
 *
 * POST → creates a fresh developer-created Circle user, mints a matched
 * { userToken, encryptionKey } via /users/token, and creates a PIN-setup
 * challenge with that exact token. Returns everything the Web SDK needs.
 *
 * If the SDK still throws 155118 on this provably-clean pair, PIN challenges
 * are broken at the app/Console/backend level (nothing in our login flow can
 * fix it). If it succeeds, the breakage is specific to email-OTP sessions.
 */
import { NextResponse } from "next/server";
import {
    createCircleUser,
    createUserToken,
    initializeUserPin,
} from "@/lib/circle";
import { appendServerDiag, circlePairFingerprint } from "@/lib/circle-diag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
    try {
        const userId = await createCircleUser();
        const { userToken, encryptionKey } = await createUserToken(userId);
        const { challengeId } = await initializeUserPin({ userToken });
        appendServerDiag(
            `test-setup dev-user=${userId.slice(0, 8)} pair=[${circlePairFingerprint(
                userToken,
                encryptionKey,
            )}] challengeId=${challengeId.slice(0, 8)}`,
        );
        return NextResponse.json({ userId, userToken, encryptionKey, challengeId });
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        appendServerDiag(`test-setup FAIL ${detail.slice(0, 200)}`);
        return NextResponse.json({ error: detail.slice(0, 400) }, { status: 502 });
    }
}
