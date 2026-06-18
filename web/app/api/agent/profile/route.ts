import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import {
    getProfile,
    upsertProfile,
    deleteProfile,
    type AgentProfile,
} from "@/lib/agent-profiles";
import { PATTERNS, resolvePattern, type PatternId } from "@/lib/agent-patterns";
import { verifyProfileAuth } from "@/lib/auth-sig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mutations require a personal_sign signature over a per-op, per-user,
// per-timestamp message (see lib/auth-sig.ts). The signer must match the
// userAddr the request targets. GETs are public (no PII, no money moves).

export async function GET(req: NextRequest) {
    const addr = req.nextUrl.searchParams.get("addr");
    if (!addr || !isAddress(addr)) {
        return NextResponse.json({ error: "invalid addr" }, { status: 400 });
    }
    const profile = await getProfile(addr);
    return NextResponse.json({ profile });
}

type PutBody = {
    userAddr: string;
    pattern: PatternId;
    customRisk?: {
        cadenceMinutes: number;
        kellyMult: number;
        edgeThreshold: number;
        minConfidence: number;
        signals: ("ai" | "polymarket")[];
    };
    marketsMode: "all" | "categories" | "watchlist";
    categories?: string[];
    watchlist?: string[];
    budgetTotal: number;
    budgetPerMarket: number;
    budgetPerDay: number;
    agentAddress?: string | null;
    circleWalletId?: string | null;
    active?: boolean;
};

export async function PUT(req: NextRequest) {
    let body: PutBody;
    try {
        body = (await req.json()) as PutBody;
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    if (!body.userAddr || !isAddress(body.userAddr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }

    const auth = await verifyProfileAuth(req.headers, body.userAddr, "profile.put");
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    if (!isValidPattern(body.pattern)) {
        return NextResponse.json({ error: "invalid pattern" }, { status: 400 });
    }
    if (!["all", "categories", "watchlist"].includes(body.marketsMode)) {
        return NextResponse.json({ error: "invalid marketsMode" }, { status: 400 });
    }
    if (
        !Number.isFinite(body.budgetTotal) ||
        !Number.isFinite(body.budgetPerMarket) ||
        !Number.isFinite(body.budgetPerDay) ||
        body.budgetTotal <= 0 ||
        body.budgetPerMarket <= 0 ||
        body.budgetPerDay <= 0
    ) {
        return NextResponse.json({ error: "invalid budget" }, { status: 400 });
    }
    if (body.budgetPerMarket > body.budgetTotal) {
        return NextResponse.json(
            { error: "per-market budget cannot exceed total" },
            { status: 400 },
        );
    }

    const watchlist = (body.watchlist ?? []).filter(
        (a): a is `0x${string}` => isAddress(a),
    );
    if (body.marketsMode === "watchlist" && watchlist.length === 0) {
        return NextResponse.json(
            { error: "watchlist mode requires at least one market" },
            { status: 400 },
        );
    }

    const knobs = resolvePattern(
        body.pattern,
        body.pattern === "custom" ? body.customRisk : undefined,
    );

    let agentAddress: `0x${string}` | null = null;
    if (body.agentAddress) {
        if (!isAddress(body.agentAddress)) {
            return NextResponse.json(
                { error: "invalid agentAddress" },
                { status: 400 },
            );
        }
        agentAddress = body.agentAddress.toLowerCase() as `0x${string}`;
    }

    const existing = await getProfile(body.userAddr);

    const next: Omit<AgentProfile, "createdAt" | "updatedAt"> = {
        userAddr: body.userAddr.toLowerCase() as `0x${string}`,
        pattern: body.pattern,
        cadenceMinutes: knobs.cadenceMinutes,
        kellyMult: knobs.kellyMult,
        edgeThreshold: knobs.edgeThreshold,
        minConfidence: knobs.minConfidence,
        signals: knobs.signals,
        marketsMode: body.marketsMode,
        categories: body.categories ?? [],
        watchlist,
        budgetTotal: body.budgetTotal,
        budgetPerMarket: knobs.perMarketHardCap
            ? Math.min(body.budgetPerMarket, knobs.perMarketHardCap)
            : body.budgetPerMarket,
        budgetPerDay: body.budgetPerDay,
        agentAddress,
        circleWalletId: body.circleWalletId ?? existing?.circleWalletId ?? null,
        telegramChatId: existing?.telegramChatId ?? null,
        telegramEnabled: existing?.telegramEnabled ?? false,
        telegramEvents: existing?.telegramEvents ?? ["live_trade"],
        active: body.active ?? true,
        pausedUntil: null,
    };

    const saved = await upsertProfile(next);
    return NextResponse.json({ profile: saved });
}

export async function DELETE(req: NextRequest) {
    const addr = req.nextUrl.searchParams.get("addr");
    if (!addr || !isAddress(addr)) {
        return NextResponse.json({ error: "invalid addr" }, { status: 400 });
    }
    const auth = await verifyProfileAuth(req.headers, addr, "profile.delete");
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ok = await deleteProfile(addr);
    return NextResponse.json({ deleted: ok });
}

function isValidPattern(p: unknown): p is PatternId {
    return p === "custom" || (typeof p === "string" && p in PATTERNS);
}
