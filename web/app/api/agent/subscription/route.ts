import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { isAddress } from "viem";
import { db } from "@/lib/db";
import { agentCredits, agentSubscriptions, type SubscriptionTier } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeTier(tier: string | null | undefined): SubscriptionTier {
    if (tier === "active") return "pro";
    if (tier === "pro" || tier === "plus" || tier === "free") return tier;
    return "free";
}

export async function GET(req: NextRequest) {
    const addr = req.nextUrl.searchParams.get("addr");
    if (!addr || !isAddress(addr)) {
        return NextResponse.json({ error: "invalid addr" }, { status: 400 });
    }

    const userAddr = addr.toLowerCase();
    const [sub] = await db
        .select()
        .from(agentSubscriptions)
        .where(eq(agentSubscriptions.userAddr, userAddr))
        .limit(1);
    const [credits] = await db
        .select()
        .from(agentCredits)
        .where(eq(agentCredits.userAddr, userAddr))
        .limit(1);

    return NextResponse.json({
        subscription: {
            tier: normalizeTier(sub?.tier),
            credits: credits?.balance ?? 0,
            autoRenew: sub?.autoRenew ?? false,
            expiresAt: sub?.expiresAt?.toISOString() ?? null,
        },
    });
}
