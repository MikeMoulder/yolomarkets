/**
 * Server-side Polymarket Gamma client.
 *
 * Scoped to solo BINARY events only — one Polymarket market per event, with
 * YES/NO outcomes. Multi-option group events (e.g. "Who wins the World Cup?"
 * with 48 nominees) are filtered out so the catalog stays 1:1 wrappable to Arc.
 *
 * Fetched server-side with a 24-hour default cache so the dashboard and admin
 * panel work from a stable daily candidate snapshot.
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
    active?: boolean;
    endDate?: string;
    umaEndDate?: string;
    resolutionSource?: string;
    events?: RawMarketEvent[];
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
type RawMarketEvent = {
    id?: string;
    title?: string;
    slug?: string;
    image?: string;
    icon?: string;
    endDate?: string;
};

/** Outcome row inside a solo binary card. There is exactly one row with YES/NO prices. */
export type OutcomeRow = {
    /** Display label from the underlying Polymarket market, usually "Yes" or the question. */
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
    /** Reserved for grouped events; always null while YOLO is solo-only. */
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

function classifyCategoryFromText(text: string): string {
    const lower = text.toLowerCase();
    const checks: [string, RegExp][] = [
        ["Crypto", /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|stablecoin|xrp|doge)\b/],
        ["Sports", /\b(fifa|world cup|nba|nfl|mlb|nhl|ufc|tennis|wta|atp|soccer|football|baseball|basketball)\b/],
        ["Geopolitics", /\b(iran|israel|china|taiwan|russia|ukraine|war|gaza|hormuz|nuclear deal|invasion)\b/],
        ["Politics", /\b(trump|biden|election|senate|congress|president|presidential|supreme court|white house)\b/],
        ["Tech", /\b(openai|chatgpt|gpt|ai|spacex|tesla|apple|nvidia|ipo)\b/],
        ["Macro", /\b(fed|inflation|cpi|rates?|recession|gdp|treasury|unemployment|market cap)\b/],
        ["Culture", /\b(movie|music|album|celebrity|award|oscars?|grammys?|box office)\b/],
        ["Science", /\b(space|climate|weather|temperature|medicine|health|earthquake)\b/],
    ];
    return checks.find(([, re]) => re.test(lower))?.[0] ?? "Other";
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

/** Expand a raw event into a binary PolymarketEvent card.
 *
 *  We intentionally skip group events even when each child is technically a
 *  binary market on Polymarket. YOLO launch/admin flow wants solo markets only.
 */
function eventsFromRaw(e: RawEvent): PolymarketEvent[] {
    const markets = (e.markets ?? []).filter((m) => !m.closed);
    if (markets.length !== 1) return [];

    const endTs = e.endDate ? Math.floor(new Date(e.endDate).getTime() / 1000) : null;
    const parentTitle = e.title?.trim() ?? "Untitled";
    const parentImage = e.image || e.icon || null;
    const category = classifyCategory(e.tags);
    const tags = (e.tags ?? []).map((t) => t.label).filter(Boolean) as string[];

    const out: PolymarketEvent[] = [];
    for (const m of markets) {
        const p = parsePrices(m.outcomePrices);
        if (!p) continue;

        const childLabel = m.groupItemTitle?.trim() || m.question?.trim();
        const title = parentTitle;

        const row: OutcomeRow = {
            label: childLabel ?? "Yes",
            yesPrice: p[0],
            noPrice: p[1],
            slug: m.slug,
            deltaPct: m.oneDayPriceChange != null ? m.oneDayPriceChange * 100 : undefined,
        };

        out.push({
            // Use the underlying market slug as the unique id for detail links.
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
    /** Minimum 24h volume required after normalization. */
    minVolume24h?: number;
    /** Cache TTL in seconds. Defaults to 24 hours. Set 0 for no-cache. */
    revalidate?: number;
};

type CacheEntry = {
    fetchedAt: number;
    raw: RawEvent[];
};

const RAW_EVENTS_CACHE = new Map<string, CacheEntry>();

/**
 * Fetch a paginated, sorted slice of active Polymarket events. Server-side only.
 * Returns an empty array on upstream failure (does not throw).
 */
export async function fetchPolymarketEvents(
    opts: FetchOptions = {},
): Promise<PolymarketEvent[]> {
    // Default limit is 300 because we filter to solo binary events. Polymarket
    // returns a mix of solo and group events, so we over-fetch to keep the
    // post-filter catalog populated.
    const limit = Math.min(opts.limit ?? 300, 500);
    const order = opts.order ?? "volume24hr";
    const revalidate = opts.revalidate ?? 86_400;
    const minVolume24h = opts.minVolume24h ?? 0;

    const params = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: String(limit),
        order,
        ascending: order === "endDate" ? "true" : "false",
    });
    const url = `${GAMMA_BASE}/events?${params.toString()}`;
    const cacheKey = url;

    try {
        let raw: RawEvent[];
        const cached = RAW_EVENTS_CACHE.get(cacheKey);
        const now = Date.now();
        if (cached && revalidate > 0 && now - cached.fetchedAt < revalidate * 1000) {
            raw = cached.raw;
        } else {
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
            raw = (await res.json()) as RawEvent[];
            if (revalidate > 0) RAW_EVENTS_CACHE.set(cacheKey, { fetchedAt: now, raw });
        }
        const parsed: PolymarketEvent[] = [];
        for (const e of raw) {
            parsed.push(...eventsFromRaw(e));
        }
        const filtered = minVolume24h > 0
            ? parsed.filter((e) => e.volume24h >= minVolume24h)
            : parsed;
        // Re-sort the expanded list because group children may have very
        // different per-child 24h volumes than the parent event's aggregate.
        if (order === "volume24hr") {
            filtered.sort((a, b) => b.volume24h - a.volume24h);
        } else if (order === "volume") {
            filtered.sort((a, b) => b.volumeTotal - a.volumeTotal);
        } else if (order === "endDate") {
            filtered.sort((a, b) => (a.endTs ?? 0) - (b.endTs ?? 0));
        }
        return filtered.slice(0, limit);
    } catch (err) {
        console.error("[polymarket] fetch failed:", err);
        return [];
    }
}

export type WrappableMarketOptions = FetchOptions & {
    /** Include binary rows that are children of broader Polymarket group events. */
    includeGroupChildren?: boolean;
    /** Number of Gamma /markets rows to inspect before slicing to `limit`. */
    scanLimit?: number;
};

/**
 * Fetch direct Gamma /markets rows and normalize them into YOLO-wrappable
 * binary cards. This is broader than /events because each row is already the
 * market-level object YOLO mirrors on-chain.
 */
export async function fetchWrappablePolymarketMarkets(
    opts: WrappableMarketOptions = {},
): Promise<PolymarketEvent[]> {
    const limit = Math.min(opts.limit ?? 300, 500);
    const scanLimit = Math.max(limit, Math.min(opts.scanLimit ?? 500, 1000));
    const order = opts.order ?? "volume24hr";
    const revalidate = opts.revalidate ?? 86_400;
    const minVolume24h = opts.minVolume24h ?? 0;
    const includeGroupChildren = opts.includeGroupChildren ?? true;
    const rows: RawMarket[] = [];

    try {
        for (let offset = 0; rows.length < scanLimit; offset += 100) {
            const params = new URLSearchParams({
                active: "true",
                closed: "false",
                limit: "100",
                offset: String(offset),
                order,
                ascending: order === "endDate" ? "true" : "false",
            });
            const url = `${GAMMA_BASE}/markets?${params.toString()}`;
            const cached = RAW_EVENTS_CACHE.get(url);
            const now = Date.now();
            let page: RawMarket[];
            if (cached && revalidate > 0 && now - cached.fetchedAt < revalidate * 1000) {
                page = cached.raw as unknown as RawMarket[];
            } else {
                const res = await fetch(url, {
                    next: revalidate > 0 ? { revalidate } : undefined,
                    cache: revalidate > 0 ? undefined : "no-store",
                    headers: { accept: "application/json" },
                });
                if (!res.ok) {
                    console.error("[polymarket] markets HTTP", res.status, res.statusText);
                    break;
                }
                page = (await res.json()) as RawMarket[];
                if (revalidate > 0) {
                    RAW_EVENTS_CACHE.set(url, {
                        fetchedAt: now,
                        raw: page as unknown as RawEvent[],
                    });
                }
            }
            if (page.length === 0) break;
            rows.push(...page);
            if (page.length < 100) break;
        }

        const out: PolymarketEvent[] = [];
        const seen = new Set<string>();
        for (const m of rows) {
            if (m.closed || m.active === false || !m.slug) continue;
            if (!includeGroupChildren && m.groupItemTitle) continue;
            const prices = parsePrices(m.outcomePrices);
            if (!prices) continue;
            const outcomes = parseOutcomeLabels(m.outcomes);
            if (outcomes.length >= 2 && (!outcomes.includes("yes") || !outcomes.includes("no"))) {
                continue;
            }
            const key = m.conditionId ?? m.slug;
            if (seen.has(key)) continue;
            seen.add(key);

            const parent = m.events?.[0];
            const endDate = m.umaEndDate ?? m.endDate ?? parent?.endDate ?? null;
            const endTs = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : null;
            const title = m.question?.trim() || parent?.title?.trim() || "Untitled";
            const volume24h = m.volume24hr ?? 0;
            if (volume24h < minVolume24h) continue;

            out.push({
                id: `market:${m.id}`,
                title,
                slug: m.slug,
                image: m.image || m.icon || parent?.image || parent?.icon || null,
                category: classifyCategoryFromText(`${title} ${parent?.title ?? ""}`),
                tags: [],
                endDate,
                endTs,
                volume24h,
                volumeTotal: typeof m.volume === "number"
                    ? m.volume
                    : typeof m.volume === "string"
                        ? Number(m.volume) || 0
                        : (m.volumeNum ?? 0),
                liquidity: m.liquidityNum ?? 0,
                isBinary: true,
                outcomes: [{
                    label: m.groupItemTitle?.trim() || "Yes",
                    yesPrice: prices[0],
                    noPrice: prices[1],
                    slug: m.slug,
                    deltaPct: m.oneDayPriceChange != null ? m.oneDayPriceChange * 100 : undefined,
                }],
                topYesPrice: prices[0],
                topLabel: null,
            });
        }

        if (order === "volume24hr") {
            out.sort((a, b) => b.volume24h - a.volume24h);
        } else if (order === "volume") {
            out.sort((a, b) => b.volumeTotal - a.volumeTotal);
        } else if (order === "endDate") {
            out.sort((a, b) => (a.endTs ?? Number.MAX_SAFE_INTEGER) - (b.endTs ?? Number.MAX_SAFE_INTEGER));
        }
        return out.slice(0, limit);
    } catch (err) {
        console.error("[polymarket] markets fetch failed:", err);
        return [];
    }
}

function parseOutcomeLabels(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((x) => String(x).trim().toLowerCase());
    } catch {
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
