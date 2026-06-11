import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getProfile, upsertProfile } from "@/lib/agent-profiles";
import { verifyProfileAuth } from "@/lib/auth-sig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EVENTS = new Set(["live_trade", "paper_trade", "risk_pass"]);

export async function POST(req: NextRequest) {
    let body: {
        userAddr?: string;
        telegramChatId?: string | null;
        telegramEnabled?: boolean;
        telegramEvents?: string[];
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    if (!body.userAddr || !isAddress(body.userAddr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }

    const auth = await verifyProfileAuth(
        req.headers,
        body.userAddr,
        "profile.notifications",
    );
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const profile = await getProfile(body.userAddr);
    if (!profile) {
        return NextResponse.json({ error: "profile not found" }, { status: 404 });
    }

    const chatId = (body.telegramChatId ?? "").trim();
    const enabled = Boolean(body.telegramEnabled);
    if (enabled && chatId.length < 3) {
        return NextResponse.json({ error: "telegram chat id required" }, { status: 400 });
    }

    const events = (body.telegramEvents ?? ["live_trade"]).filter((event) =>
        ALLOWED_EVENTS.has(event),
    );
    const saved = await upsertProfile({
        ...profile,
        telegramChatId: chatId || null,
        telegramEnabled: enabled,
        telegramEvents: events.length > 0 ? events : ["live_trade"],
    });

    return NextResponse.json({ profile: saved });
}
