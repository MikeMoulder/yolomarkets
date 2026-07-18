import { listMarkets, type MarketSummary } from "@/lib/markets";
import { MarketGrid } from "@/components/market-grid";
import { toNativeCardModel } from "@/components/native-market-card";
import { FeaturedRail } from "@/components/featured-rail";
import { MarketSection } from "@/components/market-section";
import { MoversStrip } from "@/components/movers-strip";
import { getNativeImageOverlay } from "@/lib/native-image-overlay";
import { getNativeMovers } from "@/lib/native-movers";
import { getFastMarketImage, isFastMarket } from "@/lib/fast-markets";
import { buildHomeSections, CATEGORY_ORDER } from "@/lib/home-sections";
import { CategoryChips } from "@/components/category-chips";
import { SearchInput } from "@/components/search-input";
import { SortSelect } from "@/components/sort-select";
import { ExpiryFilter, type ExpiryValue } from "@/components/expiry-filter";
import { formatUsdc } from "@/lib/format";

// `searchParams` makes this route dynamic. Native markets are read on-chain
// (cached in lib/markets), so the page itself is a thin structuring layer.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{
    cat?: string;
    q?: string;
    sort?: "volume24hr" | "volume" | "endDate";
    expiry?: ExpiryValue;
}>;

export default async function HomePage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const sp = await searchParams;
    const cat = sp.cat ?? "";
    const q = (sp.q ?? "").trim().toLowerCase();
    const expiry = sp.expiry ?? "all";
    const nowSec = Math.floor(Date.now() / 1000);

    const [nativeRes, overlayRes] = await Promise.allSettled([
        listMarkets(),
        getNativeImageOverlay(),
    ]);
    const native = nativeRes.status === "fulfilled" ? nativeRes.value : [];
    const lookupImage =
        overlayRes.status === "fulfilled" ? overlayRes.value : () => null;

    // Only Arc-tradeable, still-open markets ever reach the UI now — discovery
    // (Polymarket) lives in the Telegram listing pipeline, not on the homepage.
    // Markets without artwork (no fast-token logo and no Polymarket image
    // match) are hidden from the catalog entirely — bare CSS tiles read as
    // clutter (2026-07-18 request). They stay tradeable via direct URL.
    const activeNativeMarkets = native.filter(
        (m) =>
            !m.resolved &&
            Number(m.deadline) > nowSec &&
            (isFastMarket(m) || lookupImage(m.question) !== null),
    );

    // Category chip counts, computed over the current search corpus (never
    // narrowed by the selected category), native-only.
    const searchMatches = activeNativeMarkets.filter((m) =>
        q ? `${m.question} ${m.category}`.toLowerCase().includes(q) : true,
    );
    const expiryMatches = searchMatches.filter((m) =>
        isWithinExpiry(Number(m.deadline), expiry, nowSec),
    );
    const chipCounts = new Map<string, number>();
    for (const m of expiryMatches) {
        const c = m.category.trim();
        chipCounts.set(c, (chipCounts.get(c) ?? 0) + 1);
    }
    const chips = [...chipCounts.entries()]
        .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
        .map(([label, count]) => ({ label, count }));

    // Aggregate stats (over the full active set so the header doesn't jitter).
    const totalLiq = activeNativeMarkets.reduce((s, m) => s + m.totalLiquidity, 0n);
    const categoryCount = new Set(activeNativeMarkets.map((m) => m.category.trim())).size;

    // Movers — respects the category filter, ignores free-text search.
    const moversNative = cat
        ? activeNativeMarkets.filter((m) => m.category.trim() === cat)
        : activeNativeMarkets;
    const movers = await getNativeMovers(moversNative, { max: 4, minAbsDelta: 2 });

    const isFiltering = Boolean(cat || q || expiry !== "all");

    return (
        <div>
            {/* Status strip — tradeable-focused, backed by an ambient gradient. */}
            <section className="relative border-b border-border overflow-hidden noise-overlay">
                <div className="mesh-ambient" aria-hidden />
                <div className="absolute inset-0 grid-underlay opacity-40" aria-hidden />
                <div className="relative mx-auto max-w-[1440px] px-6 py-6 md:py-10">
                    <div className="flex items-end gap-x-8 overflow-x-auto no-scrollbar -mx-6 px-6 md:mx-0 md:px-0 md:flex-wrap md:gap-x-10 md:gap-y-5 md:overflow-visible divide-x divide-border/60">
                        <Stat
                            label="tradeable on arc"
                            value={activeNativeMarkets.length.toString()}
                            unit="live markets"
                        />
                        <Stat
                            label="liquidity"
                            value={`$${formatUsdc(totalLiq)}`}
                            unit="across markets"
                        />
                        <Stat label="categories" value={categoryCount.toString()} unit="tracked" />
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
                    <ExpiryFilter />
                    <SortSelect />
                </div>
                <div className="mx-auto max-w-[1440px] px-6 pb-3">
                    <CategoryChips chips={chips} total={expiryMatches.length} />
                </div>
            </section>

            {isFiltering ? (
                <FilteredResults
                    markets={applyNativeFilter(activeNativeMarkets, cat, q, expiry, nowSec)}
                    lookupImage={lookupImage}
                    title={cat ? `${cat} markets` : q ? `Search: "${q}"` : "All markets"}
                    filterKey={`${cat}|${q}|${expiry}`}
                />
            ) : (
                <CuratedHome
                    active={activeNativeMarkets}
                    lookupImage={lookupImage}
                    movers={movers}
                />
            )}
        </div>
    );
}

function CuratedHome({
    active,
    lookupImage,
    movers,
}: {
    active: MarketSummary[];
    lookupImage: (q: string) => string | null;
    movers: Awaited<ReturnType<typeof getNativeMovers>>;
}) {
    const { featured, groups } = buildHomeSections(active, lookupImage);

    if (active.length === 0) {
        return (
            <div className="mx-auto max-w-[1440px] px-6 py-12">
                <EmptyState />
            </div>
        );
    }

    return (
        <div className="pb-12">
            <FeaturedRail items={featured} />
            <MoversStrip movers={movers} />
            {groups.map((g, i) => (
                <MarketSection
                    key={g.key}
                    index={String(i + 3).padStart(2, "0")}
                    label={g.label}
                    total={g.total}
                    items={g.items}
                    seeAllHref={
                        g.key === "Fast" ? "/markets/fast" : `/?cat=${encodeURIComponent(g.key)}`
                    }
                />
            ))}
        </div>
    );
}

function FilteredResults({
    markets,
    lookupImage,
    title,
    filterKey,
}: {
    markets: MarketSummary[];
    lookupImage: (q: string) => string | null;
    title: string;
    filterKey: string;
}) {
    const cards = markets.map((m) =>
        toNativeCardModel(m, getFastMarketImage(m.question) ?? lookupImage(m.question)),
    );

    return (
        <section className="mx-auto max-w-[1440px] px-6 pb-12 pt-7">
            <header className="flex items-end justify-between mb-5 border-b border-border pb-3">
                <div className="flex items-baseline gap-3">
                    <span className="section-number text-[11px] tabular">02</span>
                    <h2 className="text-[20px] md:text-[22px] font-medium tracking-tight text-text">
                        {title}
                    </h2>
                </div>
                <span className="num text-[12px] text-text-mute tabular">
                    {cards.length} {cards.length === 1 ? "market" : "markets"}
                </span>
            </header>

            {cards.length === 0 ? (
                <EmptyState />
            ) : (
                <MarketGrid key={filterKey} native={cards} events={[]} />
            )}
        </section>
    );
}

function Stat({
    label,
    value,
    unit,
}: {
    label: string;
    value: string;
    unit?: string;
}) {
    return (
        <div className="flex flex-col min-w-0 shrink-0 pl-8 first:pl-0 md:pl-10">
            <span className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5">
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

function categoryRank(cat: string): number {
    const i = CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? CATEGORY_ORDER.length : i;
}

function applyNativeFilter(
    list: MarketSummary[],
    cat: string,
    q: string,
    expiry: ExpiryValue,
    nowSec: number,
): MarketSummary[] {
    return list
        .filter((m) => {
            if (Number(m.deadline) <= nowSec) return false;
            if (cat && m.category.trim() !== cat) return false;
            if (!isWithinExpiry(Number(m.deadline), expiry, nowSec)) return false;
            if (q) {
                const hay = `${m.question} ${m.category}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return !m.resolved;
        })
        .sort((a, b) => {
            const aDeadline = Number(a.deadline);
            const bDeadline = Number(b.deadline);
            return aDeadline - bDeadline || a.question.localeCompare(b.question);
        });
}

function isWithinExpiry(deadlineSec: number, expiry: ExpiryValue, nowSec: number): boolean {
    if (expiry === "all") return true;
    if (deadlineSec <= nowSec) return false;
    const maxAge = expiryWindowSeconds(expiry);
    return maxAge === null || deadlineSec <= nowSec + maxAge;
}

function expiryWindowSeconds(expiry: ExpiryValue): number | null {
    if (expiry === "24h") return 86_400;
    if (expiry === "7d") return 7 * 86_400;
    if (expiry === "30d") return 30 * 86_400;
    if (expiry === "90d") return 90 * 86_400;
    return null;
}
