import { Suspense } from "react";
import { listMarkets, type MarketSummary } from "@/lib/markets";
import {
    fetchPolymarketEvents,
    CATEGORY_LABELS,
    type PolymarketEvent,
} from "@/lib/polymarket";
import { MarketCard } from "@/components/market-card";
import { NativeMarketCard } from "@/components/native-market-card";
import { MoversStrip } from "@/components/movers-strip";
import { getNativeImageOverlay } from "@/lib/native-image-overlay";
import { getNativeMovers } from "@/lib/native-movers";
import { CategoryChips } from "@/components/category-chips";
import { SearchInput } from "@/components/search-input";
import { SortSelect } from "@/components/sort-select";
import { formatCompactUsd, formatUsdc } from "@/lib/format";

// `searchParams` makes this route dynamic. The large Polymarket event payload
// is fetched without Next's data cache because it exceeds the cache item limit.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{
    cat?: string;
    q?: string;
    sort?: "volume24hr" | "volume" | "endDate";
}>;

export default async function HomePage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const sp = await searchParams;
    const cat = sp.cat ?? "";
    const q = (sp.q ?? "").trim().toLowerCase();
    const sort = sp.sort ?? "volume24hr";

    const [nativeRes, eventsRes, overlayRes] = await Promise.allSettled([
        listMarkets(),
        fetchPolymarketEvents({ order: sort, limit: 300 }),
        getNativeImageOverlay(),
    ]);
    const native = nativeRes.status === "fulfilled" ? nativeRes.value : [];
    const events = eventsRes.status === "fulfilled" ? eventsRes.value : [];
    const lookupImage =
        overlayRes.status === "fulfilled" ? overlayRes.value : () => null;

    // Counts per category for the chip bar (filtered by search query if present,
    // but never by category — so the chips always show the breakdown of the
    // current search corpus). Native markets contribute to their bucket too.
    const filteredBySearch = q ? events.filter((e) => matchesQuery(e, q)) : events;
    const nativeMatchingSearch = q
        ? native.filter((m) => `${m.question} ${m.category}`.toLowerCase().includes(q))
        : native;
    const chipCounts = countByCategory(filteredBySearch);
    for (const m of nativeMatchingSearch) {
        const cat = normalizeNativeCategory(m.category);
        chipCounts.set(cat, (chipCounts.get(cat) ?? 0) + 1);
    }
    const total = filteredBySearch.length + nativeMatchingSearch.length;

    // Apply category filter to both lists
    const visibleEvents = cat
        ? filteredBySearch.filter((e) => e.category === cat)
        : filteredBySearch;
    const visibleNative = applyNativeFilter(native, cat, q);

    // Aggregate stats (compute over full unfiltered set so the header doesn't jitter)
    const totalVol24h = events.reduce((s, e) => s + e.volume24h, 0);
    const totalLiq = native.reduce((s, m) => s + m.totalLiquidity, 0n);
    const activeNative = native.filter((m) => !m.resolved).length;

    // Movers — Arc-tradeable markets, ranked by 24h move of their Polymarket
    // counterpart. Respects category filter, ignores free-text search.
    const moversNative = cat
        ? native.filter((m) => normalizeNativeCategory(m.category) === cat)
        : native;
    const movers = await getNativeMovers(moversNative, { max: 4, minAbsDelta: 2 });

    const visibleCount = visibleNative.length + visibleEvents.length;
    const sectionTitle = cat
        ? `${cat} markets`
        : q
            ? `Search: "${q}"`
            : "All markets";

    return (
        <div>
            {/* Status strip — informational, no marketing copy. Backed by an
                ambient drifting gradient so the page reads as alive on landing. */}
            <section className="relative border-b border-border overflow-hidden noise-overlay">
                <div className="mesh-ambient" aria-hidden />
                {/* Faint engineered grid for texture */}
                <div className="absolute inset-0 grid-underlay opacity-40" aria-hidden />
                <div className="relative mx-auto max-w-[1440px] px-6 py-8 md:py-10">
                    <div className="flex flex-wrap items-end gap-x-10 gap-y-5 divide-x divide-border/60">
                        <Stat label="catalog" value={events.length.toString()} unit="binary events" />
                        <Stat
                            label="24h volume"
                            value={formatCompactUsd(totalVol24h)}
                            unit="across catalog"
                        />
                        <Stat
                            label="tradeable on arc"
                            value={activeNative.toString()}
                            unit={`· $${formatUsdc(totalLiq)} liq`}
                            live
                        />
                        <Stat label="settlement" value="USDC" unit="native gas · Arc" />
                        <Stat label="latency" value="sub-second" unit="finality" />
                    </div>
                </div>
            </section>

            {/* Filter bar (sticky) */}
            <section className="sticky top-0 z-20 bg-bg-glass backdrop-blur-md">
                <div className="mx-auto max-w-[1440px] px-6 py-3 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[240px] max-w-md">
                        <SearchInput />
                    </div>
                    <SortSelect />
                </div>
                <div className="mx-auto max-w-[1440px] px-6 pb-3">
                    <CategoryChips
                        chips={CATEGORY_LABELS.map((label) => ({
                            label,
                            count: chipCounts.get(label) ?? 0,
                        }))}
                        total={total}
                    />
                </div>
            </section>

            {/* Movers — eye candy + actionable */}
            <MoversStrip movers={movers} />

            {/* Main grid */}
            <section className="mx-auto max-w-[1440px] px-6 pb-12 pt-7">
                <header className="flex items-end justify-between mb-5 border-b border-border pb-3">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">02</span>
                        <h2 className="text-[20px] md:text-[22px] font-medium tracking-tight text-text">
                            {sectionTitle}
                        </h2>
                    </div>
                    <span className="num text-[12px] text-text-mute tabular">
                        {visibleCount} {visibleCount === 1 ? "market" : "markets"}
                    </span>
                </header>

                {visibleCount === 0 ? (
                    <EmptyState />
                ) : (
                    <Suspense fallback={null}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                            {visibleNative.map((m) => (
                                <NativeMarketCard
                                    key={m.address}
                                    m={m}
                                    imageUrl={lookupImage(m.question)}
                                />
                            ))}
                            {visibleEvents.map((e) => (
                                <MarketCard key={e.id} event={e} />
                            ))}
                        </div>
                    </Suspense>
                )}
            </section>
        </div>
    );
}

function Stat({
    label,
    value,
    unit,
    live,
}: {
    label: string;
    value: string;
    unit?: string;
    live?: boolean;
}) {
    return (
        <div className="flex flex-col min-w-0 pl-10 first:pl-0">
            <span className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5 inline-flex items-center gap-2">
                {live && (
                    <span className="w-1.5 h-1.5 rounded-full bg-yes glow-dot-yes live-dot" />
                )}
                {label}
            </span>
            <span className="num text-[17px] text-text tabular leading-none font-medium">
                {value}
                {unit && (
                    <span className="text-text-faint text-[10.5px] ml-1.5 lowercase tracking-normal font-normal">
                        {unit}
                    </span>
                )}
            </span>
        </div>
    );
}

function EmptyState() {
    return (
        <div className="border border-dashed border-border rounded-2xl px-6 py-16 text-center">
            <div className="num text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                / no matches
            </div>
            <p className="text-text-dim text-[13.5px]">
                Try a different category, or clear the search.
            </p>
        </div>
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function matchesQuery(e: PolymarketEvent, q: string): boolean {
    if (e.title.toLowerCase().includes(q)) return true;
    if (e.category.toLowerCase().includes(q)) return true;
    if (e.tags.some((t) => t.toLowerCase().includes(q))) return true;
    if (e.outcomes.some((o) => o.label.toLowerCase().includes(q))) return true;
    return false;
}

function countByCategory(events: PolymarketEvent[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return m;
}

function applyNativeFilter(
    list: MarketSummary[],
    cat: string,
    q: string,
): MarketSummary[] {
    return list.filter((m) => {
        if (cat && normalizeNativeCategory(m.category) !== cat) return false;
        if (q) {
            const hay = `${m.question} ${m.category}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return !m.resolved;
    });
}

/** Map on-chain category labels (chosen by admin at market creation) to the
 *  canonical chip labels. Keeps the card label intact for display. */
function normalizeNativeCategory(cat: string): string {
    return cat.trim();
}
