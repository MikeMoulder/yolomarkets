import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { setActive } from "@/lib/agent-profiles";
import { verifyProfileAuth } from "@/lib/auth-sig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    userAddr: string;
    active: boolean;
    pausedUntil?: string | null;
};

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    if (!body.userAddr || !isAddress(body.userAddr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }
    const auth = await verifyProfileAuth(
        req.headers,
        body.userAddr,
        "profile.active",
    );
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const updated = await setActive(
        body.userAddr,
        Boolean(body.active),
        body.pausedUntil ?? null,
    );
    if (!updated) {
        return NextResponse.json({ error: "no profile" }, { status: 404 });
    }
    return NextResponse.json({ profile: updated });
}
