/**
 * Shareable ticket images at a stable URL.
 *
 *   /api/markets/<address>/share              → the market ticket
 *   /api/markets/<address>/share?user=0x…     → that wallet's position ticket
 *   /api/markets/<address>/share?user=0x…&side=no
 *
 * The market page's `opengraph-image` renders the same market card for link
 * unfurls; this route exists because the file-convention URL carries a build
 * hash, and the in-app share/download button needs a URL it can predict.
 */
import { isAddress, type Address } from "viem";
import { loadBetTicket, loadMarketTicket } from "@/lib/share-data";
import { betTicket, fallbackTicket, marketTicket } from "@/lib/share-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    req: Request,
    context: { params: Promise<{ address: string }> },
) {
    const { address } = await context.params;
    if (!isAddress(address)) return fallbackTicket("Market not found");

    const sp = new URL(req.url).searchParams;
    const user = sp.get("user");
    const sideParam = sp.get("side");
    const side = sideParam === "yes" || sideParam === "no" ? sideParam : undefined;

    try {
        if (user) {
            if (!isAddress(user)) return fallbackTicket("Invalid wallet");
            const bet = await loadBetTicket(address as Address, user as Address, side);
            // No position → fall back to the market card rather than an error,
            // so a stale share link still shows something useful.
            if (bet) return betTicket(bet);
        }
        const ticket = await loadMarketTicket(address as Address);
        return ticket ? marketTicket(ticket) : fallbackTicket("Market not found");
    } catch {
        return fallbackTicket("yolomarkets.fun");
    }
}
