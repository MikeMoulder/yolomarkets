/**
 * Link-preview card for a market. Next wires this into the page's `og:image`
 * automatically, so pasting a market URL into Telegram, X, Discord or iMessage
 * unfurls the ticket — no share button required.
 *
 * The same image is served with a stable URL by /api/markets/<addr>/share for
 * the in-app "share" action (download / attach), since the file-convention URL
 * carries a build hash.
 */
import { isAddress, type Address } from "viem";
import { loadMarketTicket } from "@/lib/share-data";
import { fallbackTicket, marketTicket, SIZE } from "@/lib/share-card";

export const alt = "YOLO Markets — prediction market";
export const size = SIZE;
export const contentType = "image/png";

// This is a Route Handler and is statically optimized by default, which would
// freeze the price into the card forever. 60s keeps it honest while sparing us
// a full Satori render every time a crawler re-fetches the unfurl.
export const revalidate = 60;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
    const { address } = await params;
    if (!isAddress(address)) return fallbackTicket("Market not found");
    try {
        const ticket = await loadMarketTicket(address as Address);
        if (!ticket) return fallbackTicket("Market not found");
        return marketTicket(ticket);
    } catch {
        // A share card must never 500 — an unfurl failure is worse than a
        // generic card.
        return fallbackTicket("yolomarkets.fun");
    }
}
