/**
 * Build a list of "movers" from native Arc markets, ranked by the 24h price
 * change of their matched Polymarket counterpart.
 *
 * Why join through Polymarket: native markets don't yet emit price snapshots
 * we can diff over 24h (would need a price-history table). Polymarket is
 * effectively the world's reference book for these same questions, so its
 * deltaPct is the best signal we have for what's actually moving today.
 *
 * The card surfaces the *native* AMM YES price (what the user would pay on
 * Arc) — only the delta and image are borrowed from Polymarket.
 */
import { getNativeMatchOverlay } from "./native-image-overlay";
import { type MarketSummary } from "./markets";

export type NativeMover = {
    address: `0x${string}`;
    question: string;
    category: string;
    priceYes: number;          // 0..1 — Arc on-chain price
    deltaPct: number;          // signed pt move from Polymarket (24h)
    image: string | null;
    polymarketSlug: string | null;
    totalLiquidity: bigint;
};

const PRICE_18 = 1_000_000_000_000_000_000n;

export async function getNativeMovers(
    native: MarketSummary[],
    opts: { minAbsDelta?: number; max?: number } = {},
): Promise<NativeMover[]> {
    const minAbsDelta = opts.minAbsDelta ?? 2;
    const max = opts.max ?? 4;

    const match = await getNativeMatchOverlay();
    const candidates: NativeMover[] = [];

    for (const m of native) {
        if (m.resolved) continue;
        const ev = match(m.question);
        if (!ev || !ev.outcomes?.length) continue;
        const delta = ev.outcomes[0].deltaPct;
        if (delta === undefined || Math.abs(delta) < minAbsDelta) continue;

        const priceYes = Number((m.priceYes * 10_000n) / PRICE_18) / 10_000;
        // Skip extreme prices — usually pre-settlement / resolved-soon markets
        if (priceYes < 0.04 || priceYes > 0.96) continue;

        candidates.push({
            address: m.address,
            question: m.question,
            category: m.category,
            priceYes,
            deltaPct: delta,
            image: ev.image ?? null,
            polymarketSlug: ev.slug ?? null,
            totalLiquidity: m.totalLiquidity,
        });
    }

    candidates.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
    return candidates.slice(0, max);
}
