/**
 * Server-side Polymarket Gamma client.
 *
 * Scoped to BINARY events only — single YES/NO outcome per card. Multi-option
 * group events (e.g. "Who wins the World Cup?" with 48 nominees) are filtered
 * out because YOLO's PredictionMarket.sol is a binary LMSR. This keeps the
 * catalog 1:1 wrappable to Arc.
 *
 * Fetched server-side with `next: { revalidate: 60 }` so we hit the upstream
 * at most once per minute regardless of traffic.
 */

const GAMMA_BASE =
    process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";

/** Raw shape (subset) of an event from /events. */
type RawTag = { id?: string; label?: string; slug?: string };
type RawMarket = {
    id: string;
    conditionId?: string;
    question?: string;
    slug?: string;
    image?: string;
    icon?: string;
    outcomePrices?: string; // JSON-encoded string array
    outcomes?: string; // JSON-encoded string array
    volume?: string | number;
    volumeNum?: number;
    volume24hr?: number;
    liquidityNum?: number;
    oneDayPriceChange?: number;
    groupItemTitle?: string;
    closed?: boolean;
};
type RawEvent = {
    id: string;
    title?: string;
    slug?: string;
    description?: string;
    image?: string;
    icon?: string;
    category?: string;
    tags?: RawTag[];
    endDate?: string;
    volume?: number;
    volume24hr?: number;
    liquidityNum?: number;
    markets?: RawMarket[];
    closed?: boolean;
    active?: boolean;
};

/** Outcome row inside a card. For a binary event there is exactly one row
 *  (the question itself) with YES/NO prices. For a multi-option event each
 *  child market becomes a row labeled with `groupItemTitle`. */
export type OutcomeRow = {
    /** Display label — for binary events: "Yes" or full question;
     *  for grouped events: the option name e.g. "Iran", "Argentina". */
    label: string;
    yesPrice: number; // 0..1
    noPrice: number; // 0..1
    /** Underlying Polymarket market slug for deep links. */
    slug?: string;
    /** Day-on-day price change in percentage points (positive = up). */
    deltaPct?: number;
};

export type PolymarketEvent = {
    id: string;
    title: string;
    slug: string;
    image: string | null;
    category: string;
    tags: string[];
    endDate: string | null;
    endTs: number | null;
    volume24h: number;
    volumeTotal: number;
    liquidity: number;
    /** True for binary YES/NO events; false for multi-option (group) events. */
    isBinary: boolean;
    outcomes: OutcomeRow[];
    /** Top-1 outcome's YES probability — used as the "main number" on the card. */
    topYesPrice: number;
    /** Top option's name for grouped events (e.g. "Iran" or "Argentina"). Null for binary. */
    topLabel: string | null;
};

/** A curated set of top-level groupings we surface as chip filters. Order matters —
 *  the first match wins when an event has multiple matching tags. */
const TOP_CATEGORIES: { label: string; matches: string[] }[] = [
    { label: "Politics", matches: ["Politics", "Trump", "Elections", "Election", "US", "Biden", "Congress", "Senate"] },
    { label: "Crypto", matches: ["Crypto", "Bitcoin", "Ethereum", "BTC", "ETH", "Solana", "Memes"] },
    { label: "Sports", matches: ["Sports", "Soccer", "Football", "NBA", "NFL", "FIFA", "Baseball", "Hockey", "Tennis", "Boxing", "UFC", "MLB"] },
    { label: "Geopolitics", matches: ["Geopolitics", "Iran", "China", "Russia", "Ukraine", "War", "Middle East", "Israel"] },
    { label: "Tech", matches: ["Tech", "AI", "OpenAI", "ChatGPT", "SpaceX", "Apple"] },
    { label: "Macro", matches: ["Macro", "Economy", "Fed", "Inflation", "Recession", "Markets", "Stocks", "Interest Rates"] },
    { label: "Culture", matches: ["Pop Culture", "Movies", "Music", "Awards", "Celebrity", "Entertainment"] },
    { label: "Science", matches: ["Science", "Space", "Climate", "Health", "Medicine"] },
];

function classifyCategory(tags: RawTag[] | undefined): string {
    if (!tags || tags.length === 0) return "Other";
    const labels = tags.map((t) => t.label).filter(Boolean) as string[];
    for (const cat of TOP_CATEGORIES) {
        if (labels.some((l) => cat.matches.includes(l))) return cat.label;
    }
    // Fall back to first non-meta tag.
    const first = labels.find((l) => !["Hide From New", "All"].includes(l));
    return first ?? "Other";
}

/** Parse Polymarket's JSON-string-encoded `outcomePrices`. */
function parsePrices(raw: string | undefined): [number, number] | null {
    if (!raw) return null;
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length < 2) return null;
        const a = Number(arr[0]);
        const b = Number(arr[1]);
        if (Number.isNaN(a) || Number.isNaN(b)) return null;
        return [a, b];
    } catch {
        return null;
    }
}

/** Expand a raw event into 1..N binary PolymarketEvent cards.
 *
 *  Single-market events (e.g. "Will the Fed cut?") → one card using the event
 *  title.
 *
 *  Multi-market group events (e.g. "Who wins the World Cup?" with 48 children)
 *  → one card per child, each labeled with the group's question prefix +
 *  the child's `groupItemTitle` (e.g. "World Cup winner: Argentina"). Children
 *  inherit the parent's image, category, and tags so they look unified.
 *
 *  This lets the catalog include the high-volume group events as actual
 *  tradeable binary markets, which is exactly what they are underneath.
 */
function eventsFromRaw(e: RawEvent): PolymarketEvent[] {
    const markets = (e.markets ?? []).filter((m) => !m.closed);
    if (markets.length === 0) return [];

    const endTs = e.endDate ? Math.floor(new Date(e.endDate).getTime() / 1000) : null;
    const parentTitle = e.title?.trim() ?? "Untitled";
    const parentImage = e.image || e.icon || null;
    const category = classifyCategory(e.tags);
    const tags = (e.tags ?? []).map((t) => t.label).filter(Boolean) as string[];
    const isGroup = markets.length > 1;

    const out: PolymarketEvent[] = [];
    for (const m of markets) {
        const p = parsePrices(m.outcomePrices);
        if (!p) continue;

        // Title:
        // · single-market events use the event title verbatim
        // · group events use `parentTitle: childLabel` unless the child label
        //   already contains the parent (some Polymarket events ship redundant
        //   `groupItemTitle === question` payloads). Avoid the "X: X" dupe.
        const childLabel = m.groupItemTitle?.trim() || m.question?.trim();
        let title = parentTitle;
        if (isGroup && childLabel) {
            const childNormalized = childLabel.toLowerCase();
            const parentNormalized = parentTitle.toLowerCase();
            if (childNormalized === parentNormalized) {
                title = parentTitle;
            } else if (childNormalized.includes(parentNormalized)) {
                title = childLabel;
            } else if (parentNormalized.includes(childNormalized)) {
                title = parentTitle;
            } else {
                title = `${parentTitle}: ${childLabel}`;
            }
        }

        const row: OutcomeRow = {
            label: childLabel ?? "Yes",
            yesPrice: p[0],
            noPrice: p[1],
            slug: m.slug,
            deltaPct: m.oneDayPriceChange != null ? m.oneDayPriceChange * 100 : undefined,
        };

        out.push({
            // Use the child market's slug as the unique id so deep-links resolve
            // to the right binary leaf — not the parent group page.
            id: `${e.id}::${m.id}`,
            title,
            slug: m.slug ?? e.slug ?? e.id,
            image: m.image || m.icon || parentImage,
            category,
            tags,
            endDate: e.endDate ?? null,
            endTs,
            volume24h: m.volume24hr ?? 0,
            volumeTotal: typeof m.volume === "number"
                ? m.volume
                : typeof m.volume === "string"
                    ? Number(m.volume) || 0
                    : (m.volumeNum ?? 0),
            liquidity: m.liquidityNum ?? 0,
            isBinary: true,
            outcomes: [row],
            topYesPrice: row.yesPrice,
            topLabel: null,
        });
    }
    return out;
}

export type FetchOptions = {
    /** Cap on number of events returned. Gamma allows up to 500. */
    limit?: number;
    /** Sort order: volume24hr | volume | endDate */
    order?: "volume24hr" | "volume" | "endDate" | "newest";
    /** Cache TTL in seconds. Defaults to 60. Set 0 for no-cache. */
    revalidate?: number;
};

/**
 * Fetch a paginated, sorted slice of active Polymarket events. Server-side only.
 * Returns an empty array on upstream failure (does not throw).
 */
export async function fetchPolymarketEvents(
    opts: FetchOptions = {},
): Promise<PolymarketEvent[]> {
    // Default limit raised to 300 because we filter to binary-only — Polymarket
    // returns a mix of binary and multi-option events, so we over-fetch to keep
    // the post-filter catalog populated.
    const limit = Math.min(opts.limit ?? 300, 500);
    const order = opts.order ?? "volume24hr";
    const revalidate = opts.revalidate ?? 60;

    const params = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: String(limit),
        order,
        ascending: order === "endDate" ? "true" : "false",
    });
    const url = `${GAMMA_BASE}/events?${params.toString()}`;

    try {
        const res = await fetch(url, {
            next: revalidate > 0 ? { revalidate } : undefined,
            cache: revalidate > 0 ? undefined : "no-store",
            // Polymarket's CDN expects browser-ish headers. Server-to-server is fine
            // without TLS impersonation because we're inside Node, not a browser fetch.
            headers: { accept: "application/json" },
        });
        if (!res.ok) {
            console.error("[polymarket] HTTP", res.status, res.statusText);
            return [];
        }
        const raw = (await res.json()) as RawEvent[];
        const parsed: PolymarketEvent[] = [];
        for (const e of raw) {
            parsed.push(...eventsFromRaw(e));
        }
        // Re-sort the expanded list because group children may have very
        // different per-child 24h volumes than the parent event's aggregate.
        if (order === "volume24hr") {
            parsed.sort((a, b) => b.volume24h - a.volume24h);
        } else if (order === "volume") {
            parsed.sort((a, b) => b.volumeTotal - a.volumeTotal);
        } else if (order === "endDate") {
            parsed.sort((a, b) => (a.endTs ?? 0) - (b.endTs ?? 0));
        }
        return parsed.slice(0, limit);
    } catch (err) {
        console.error("[polymarket] fetch failed:", err);
        return [];
    }
}

/** All canonical category labels in display order — exported for the filter chips. */
export const CATEGORY_LABELS = TOP_CATEGORIES.map((c) => c.label) as readonly string[];

export type PolymarketEventDetail = PolymarketEvent & {
    description: string | null;
    /** Raw markets array preserved for detail-view rendering of all options. */
    raw: RawEvent;
};

/** Fetch a single Polymarket event by slug — for the detail page.
 *
 *  The slug we get from card links is the *child market* slug (see
 *  eventsFromRaw), which for group events (NBA champion, World Cup, etc.)
 *  differs from the parent event's slug. Two-pass lookup:
 *    1. Try /events?slug=... — works when child slug == event slug
 *       (true for most single-binary events on Polymarket).
 *    2. Fall back to /markets?slug=... — fetches the market by its own slug,
 *       then we re-fetch the parent event via the market's event ID and
 *       expand it, picking the binary leaf matching our slug.
 */
export async function fetchPolymarketEventBySlug(
    slug: string,
): Promise<PolymarketEventDetail | null> {
    // ── Pass 1: events endpoint ──────────────────────────────────────────
    try {
        const res = await fetch(
            `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`,
            {
                next: { revalidate: 30 },
                headers: { accept: "application/json" },
            },
        );
        if (res.ok) {
            const arr = (await res.json()) as RawEvent[];
            const raw = Array.isArray(arr) ? arr[0] : (arr as RawEvent);
            if (raw) {
                // Prefer the binary child whose slug matches our incoming slug.
                const expanded = eventsFromRaw(raw);
                const match =
                    expanded.find((x) => x.slug === slug) ?? expanded[0];
                if (match) {
                    return {
                        ...match,
                        description: raw.description ?? null,
                        raw,
                    };
                }
            }
        }
    } catch (err) {
        console.error("[polymarket] event-slug fetch failed:", err);
    }

    // ── Pass 2: markets endpoint → parent event ──────────────────────────
    try {
        const res = await fetch(
            `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`,
            {
                next: { revalidate: 30 },
                headers: { accept: "application/json" },
            },
        );
        if (!res.ok) return null;
        const arr = (await res.json()) as RawMarketWithEvent[];
        const m = Array.isArray(arr) ? arr[0] : (arr as RawMarketWithEvent);
        if (!m) return null;

        // Some Gamma payloads embed the parent event(s); others give only IDs.
        const parentEvent = m.events?.[0];
        const parentSlug = parentEvent?.slug ?? m.eventSlug;
        if (!parentSlug) return null;

        const evRes = await fetch(
            `${GAMMA_BASE}/events?slug=${encodeURIComponent(parentSlug)}`,
            {
                next: { revalidate: 30 },
                headers: { accept: "application/json" },
            },
        );
        if (!evRes.ok) return null;
        const evArr = (await evRes.json()) as RawEvent[];
        const raw = Array.isArray(evArr) ? evArr[0] : (evArr as RawEvent);
        if (!raw) return null;

        const expanded = eventsFromRaw(raw);
        const match = expanded.find((x) => x.slug === slug) ?? expanded[0];
        if (!match) return null;
        return { ...match, description: raw.description ?? null, raw };
    } catch (err) {
        console.error("[polymarket] market-slug fallback failed:", err);
        return null;
    }
}

/** Shape of a Gamma /markets row — narrower than RawMarket because we only
 *  need it for the event-id fallback path. */
type RawMarketWithEvent = {
    slug?: string;
    eventSlug?: string;
    events?: { id?: string; slug?: string }[];
};
