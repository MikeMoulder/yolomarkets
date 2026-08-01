/**
 * Data loading for the shareable ticket images (lib/share-card).
 *
 * Kept apart from the rendering so the JSX stays declarative and both the
 * file-convention OG routes and the explicit `/share` endpoints read identical
 * data.
 */
import type { Address } from "viem";
import { getMarket, publicClient } from "./markets";
import { marketAbi, Outcome } from "./contracts";
import { getMarketImage } from "./market-images";
import { getFastMarketImage } from "./fast-markets";
import { lookupNativeImage } from "./native-image-overlay";
import { priceToProb } from "./format";
import type { BetTicket, MarketTicket } from "./share-card";

/**
 * Resolve the artwork for a ticket, in the same precedence the site uses:
 * admin cover → fast-market logo → Polymarket overlay.
 *
 * The admin image is inlined as a data URI rather than pointed at our own
 * `/api/markets/<addr>/image` route: Satori would have to fetch that over the
 * network, which means the renderer calling back into its own deployment (slow,
 * and it breaks entirely on a preview URL or behind auth). The bytes are right
 * there in Postgres.
 */
async function resolveArt(address: string, question: string): Promise<string | null> {
    try {
        const admin = await getMarketImage(address);
        if (admin) return `data:${admin.mime};base64,${admin.bytes.toString("base64")}`;
    } catch {
        // DB unreachable — fall through to the derived sources.
    }
    const fast = getFastMarketImage(question);
    if (fast) return fast;
    try {
        return await lookupNativeImage(question);
    } catch {
        return null;
    }
}

function outcomeLabel(outcome: number): string | null {
    if (outcome === Outcome.Yes) return "YES";
    if (outcome === Outcome.No) return "NO";
    if (outcome === Outcome.Cancelled) return "CANCELLED";
    return null;
}

export async function loadMarketTicket(address: Address): Promise<MarketTicket | null> {
    const m = await getMarket(address);
    if (!m) return null;
    return {
        address: m.address,
        question: m.question,
        category: m.category,
        yesProb: priceToProb(m.priceYes),
        liquidityUsd: Number(m.totalLiquidity) / 1e6,
        deadlineSec: Number(m.deadline),
        imageSrc: await resolveArt(m.address, m.question),
        resolved: m.resolved,
        outcomeLabel: outcomeLabel(m.outcome),
    };
}

/**
 * A holder's position on one market. `side` may be forced (a wallet can hold
 * both sides); left unset, the larger holding wins — that's the position worth
 * bragging about.
 */
export async function loadBetTicket(
    address: Address,
    holder: Address,
    forceSide?: "yes" | "no",
): Promise<BetTicket | null> {
    const m = await getMarket(address);
    if (!m) return null;

    const [sharesYesRaw, sharesNoRaw] = (await Promise.all([
        publicClient.readContract({ address, abi: marketAbi, functionName: "sharesYes", args: [holder] }),
        publicClient.readContract({ address, abi: marketAbi, functionName: "sharesNo", args: [holder] }),
    ])) as [bigint, bigint];

    const yes = Number(sharesYesRaw) / 1e6;
    const no = Number(sharesNoRaw) / 1e6;
    if (yes <= 0 && no <= 0) return null;

    const side = forceSide ?? (yes >= no ? "yes" : "no");
    const shares = side === "yes" ? yes : no;
    if (shares <= 0) return null;

    const yesProb = priceToProb(m.priceYes);
    const price = side === "yes" ? yesProb : 1 - yesProb;

    // Once settled the winning side is worth exactly $1 and the loser $0, so
    // show the settlement price rather than the last traded curve price.
    const won = m.resolved
        ? m.outcome === (side === "yes" ? Outcome.Yes : Outcome.No)
        : null;

    return {
        address: m.address,
        question: m.question,
        category: m.category,
        side,
        shares,
        price: m.resolved ? (won ? 1 : 0) : price,
        deadlineSec: Number(m.deadline),
        imageSrc: await resolveArt(m.address, m.question),
        holder,
        resolved: m.resolved,
        won,
    };
}
