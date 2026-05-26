import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyMessage, type Hex } from "viem";
import {
    ADMIN_CHALLENGE_COOKIE,
    ADMIN_SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    buildLoginMessage,
    isAdminAddress,
    issueAdminSessionJwt,
    verifyChallengeJwt,
} from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    address?: string;
    signature?: string;
};

export async function POST(req: Request) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }

    const address = body.address?.toLowerCase();
    const signature = body.signature as Hex | undefined;
    if (!address || !signature) {
        return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return NextResponse.json({ error: "bad address" }, { status: 400 });
    }
    if (!signature.startsWith("0x")) {
        return NextResponse.json({ error: "bad signature" }, { status: 400 });
    }

    // 1. Pull the challenge from the cookie set by /api/admin/nonce.
    const jar = await cookies();
    const challengeToken = jar.get(ADMIN_CHALLENGE_COOKIE)?.value;
    if (!challengeToken) {
        return NextResponse.json(
            { error: "no challenge — request a new nonce first" },
            { status: 400 },
        );
    }
    const challenge = await verifyChallengeJwt(challengeToken);
    if (!challenge) {
        return NextResponse.json(
            { error: "challenge expired — request a new nonce" },
            { status: 400 },
        );
    }

    // 2. Authorization check BEFORE bothering with crypto — short-circuit
    //    for addresses not on the whitelist regardless of signature validity.
    if (!isAdminAddress(address)) {
        return NextResponse.json(
            { error: "address not authorized" },
            { status: 403 },
        );
    }

    // 3. Verify the signature against the canonical message.
    const message = buildLoginMessage(
        address as `0x${string}`,
        challenge.nonce,
        challenge.issuedAt,
    );
    const ok = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature,
    });
    if (!ok) {
        return NextResponse.json({ error: "signature invalid" }, { status: 401 });
    }

    // 4. Issue session.
    const sessionJwt = await issueAdminSessionJwt(address as `0x${string}`);
    const res = NextResponse.json({ ok: true, address });
    res.cookies.set(ADMIN_SESSION_COOKIE, sessionJwt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: SESSION_TTL_SECONDS,
        path: "/",
    });
    // Burn the challenge cookie so it can't be reused.
    res.cookies.set(ADMIN_CHALLENGE_COOKIE, "", {
        httpOnly: true,
        path: "/",
        maxAge: 0,
    });
    return res;
}
