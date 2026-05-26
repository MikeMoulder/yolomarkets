import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
    ADMIN_CHALLENGE_COOKIE,
    CHALLENGE_TTL_SECONDS,
    issueChallengeJwt,
} from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issue a one-shot challenge nonce. Bound to the requesting browser via a
 *  short-lived (5min) httpOnly signed cookie. */
export async function GET() {
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();

    const challengeToken = await issueChallengeJwt({ nonce, issuedAt });

    const res = NextResponse.json({ nonce, issuedAt });
    res.cookies.set(ADMIN_CHALLENGE_COOKIE, challengeToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: CHALLENGE_TTL_SECONDS,
        path: "/",
    });
    return res;
}
