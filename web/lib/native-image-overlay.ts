/**
 * Map native market questions back to Polymarket event imagery.
 *
 * Two-pass lookup:
 *   1. Exact normalized-title match — fast hit for markets that were wrapped
 *      from a Polymarket event (the title is preserved verbatim during wrap).
 *   2. Token-overlap fuzzy match — catches admin-created markets whose
 *      question text doesn't appear verbatim in the Polymarket catalog
 *      (e.g. our 5 originals: ETH/USD, Fed cut, GPT-6, Lakers, Trump-Xi).
 *      Uses synonym expansion (eth↔ethereum, fomc↔fed, lakers↔nba, etc.) so
 *      the obvious topical overlap actually scores. Tiebreaks by 24h volume
 *      so we pick the most-traded event when several match equally.
 *
 *  Final fallback (no match): caller renders the CSS-art tile instead.
 */

import { fetchPolymarketEvents, type PolymarketEvent } from "./polymarket";

export type NativeImageLookup = (question: string) => string | null;
export type NativeMatchLookup = (question: string) => PolymarketEvent | null;

/** Explicit overrides — applied first, before exact/fuzzy match. Used for
 *  admin-created markets whose question text doesn't surface in the current
 *  Polymarket catalog (so fuzzy match correctly returns nothing) but for
 *  which we have a known-good Polymarket S3 asset.
 *
 *  Keys are normalized (trim + lowercase) match against the on-chain question.
 *  Values must be 200-verified Polymarket-upload S3 URLs.
 */
const OVERRIDES: Record<string, string> = {
    "will openai release gpt-6 before october 1, 2026?":
        "https://polymarket-upload.s3.us-east-2.amazonaws.com/openai.png",
};

const ASSET_OVERRIDES: { re: RegExp; image: string }[] = [
    {
        re: /\b(SOL|Solana)\b/i,
        image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/SOL-logo.png",
    },
];

// ── Tokenization ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "else",
    "will", "would", "could", "should", "do", "does", "did", "has", "have", "had",
    "this", "that", "these", "those", "it", "its", "as", "next", "any",
    "before", "after", "above", "below", "from", "into", "out", "for",
    "with", "without", "on", "off", "in", "at", "to", "of", "by",
    "again", "further", "once", "during", "while", "yes", "no",
    "all", "each", "few", "more", "most", "some", "such", "than",
    "very", "just", "only", "also", "still", "now",
]);

/** Tokens that are technically distinctive (length-wise) but contribute too
 *  much noise — generic verbs, market-status words, time words. Score-blocked. */
const NOISE_TOKENS = new Set([
    "hold", "make", "made", "release", "released", "close", "closes", "opens",
    "open", "rise", "fall", "rises", "falls", "gain", "loss", "level", "levels",
    "year", "years", "day", "days", "week", "weeks", "month", "months",
    "time", "times", "decision", "meeting", "vote", "votes", "person",
    "people", "place", "things", "stuff", "real", "fake", "true", "false",
    "high", "low", "good", "bad", "big", "small",
]);

/** Domain synonyms — light-touch expansion so 3-letter symbols (ETH, BTC, GPT,
 *  FOMC) match their longer counterparts in Polymarket titles. */
const SYNONYMS: Record<string, string[]> = {
    eth: ["ethereum"], ethereum: ["eth"],
    btc: ["bitcoin"], bitcoin: ["btc"],
    sol: ["solana"], solana: ["sol"],
    fed: ["federal", "fomc", "powell"],
    fomc: ["fed", "federal", "powell"],
    federal: ["fed", "fomc"],
    powell: ["fed", "fomc", "federal"],
    rates: ["rate"], rate: ["rates"],
    nba: ["basketball", "playoffs", "champion", "champions", "finals"],
    lakers: ["nba", "basketball"],
    celtics: ["nba", "basketball"],
    warriors: ["nba", "basketball"],
    gpt: ["openai", "chatgpt"],
    openai: ["gpt", "chatgpt", "altman"],
    chatgpt: ["openai", "gpt"],
    xi: ["china", "chinese", "beijing", "jinping"],
    china: ["xi", "chinese", "beijing", "jinping"],
    jinping: ["xi", "china"],
    trump: ["donald", "maga"],
    biden: ["joe", "potus"],
    iran: ["iranian", "tehran"],
    iranian: ["iran"],
    russia: ["russian", "putin", "moscow"],
    putin: ["russia", "russian"],
};

function expand(token: string): string[] {
    return SYNONYMS[token] ?? [];
}

function tokenize(s: string): Set<string> {
    const out = new Set<string>();
    const raw = s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);

    for (const t of raw) {
        if (STOPWORDS.has(t)) continue;
        // 3-letter symbols (eth, btc, fed, gpt, nba, ufc) survive
        if (t.length < 3) continue;
        out.add(t);
        for (const syn of expand(t)) out.add(syn);
    }
    return out;
}

/** Distinctive tokens drive scoring — they're the ones whose match means
 *  the events are actually about the same thing. */
function isDistinctive(token: string): boolean {
    // Year tokens (2020..2099) are too common across markets to be signal —
    // a GPT-6 market would otherwise match a BTC-in-2026 market on the year alone.
    if (/^20\d{2}$/.test(token)) return false;
    // Bare digits (small numbers like "150", "4000", etc.) are kept — they're
    // often price levels that ARE topical.
    if (NOISE_TOKENS.has(token)) return false;
    if (token.length < 4) {
        // Short tokens only count if they look like an acronym/symbol
        return /^[a-z0-9]+$/.test(token) && /[a-z]/.test(token);
    }
    return true;
}

// ── Public API ────────────────────────────────────────────────────────────

const normalizeKey = (s: string) => s.trim().toLowerCase();

export async function getNativeImageOverlay(): Promise<NativeImageLookup> {
    const match = await getNativeMatchOverlay();
    return (question: string) => match(question)?.image ?? null;
}

export async function lookupNativeImage(question: string): Promise<string | null> {
    const lookup = await getNativeImageOverlay();
    return lookup(question);
}

/**
 * Match a native market question to a Polymarket event using the same 3-tier
 * lookup as the image overlay (override → exact → fuzzy/synonym).
 * Returns the matched event (carries image + 24h delta + slug) or null.
 *
 * Used by the movers strip to surface tradeable-on-Arc markets whose
 * Polymarket counterpart is moving.
 */
export async function getNativeMatchOverlay(): Promise<NativeMatchLookup> {
    const events = await fetchPolymarketEvents({ limit: 300 });
    return buildMatchLookup(events);
}

function buildMatchLookup(events: PolymarketEvent[]): NativeMatchLookup {
    const exact = new Map<string, PolymarketEvent>();
    const indexed: { tokens: Set<string>; event: PolymarketEvent; vol: number }[] = [];
    // For override → event reverse-lookup (overrides only have an image URL,
    // so we resolve them back to events by matching the image URL exactly).
    const byImage = new Map<string, PolymarketEvent>();

    for (const e of events) {
        if (!e.image) continue;
        const key = normalizeKey(e.title);
        if (!exact.has(key)) exact.set(key, e);
        if (!byImage.has(e.image)) byImage.set(e.image, e);
        indexed.push({
            tokens: tokenize(e.title),
            event: e,
            vol: e.volume24h,
        });
    }

    return (question: string) => {
        const key = normalizeKey(question);

        // Tier 1: manual overrides — resolve back to event via image URL
        const overrideImg = OVERRIDES[key];
        if (overrideImg) {
            const ev = byImage.get(overrideImg);
            if (ev) return ev;
            // Override image with no live event — surface a synthetic event-
            // shaped object so the image still flows through getNativeImageOverlay.
            return { image: overrideImg } as unknown as PolymarketEvent;
        }
        for (const override of ASSET_OVERRIDES) {
            if (!override.re.test(question)) continue;
            const ev = byImage.get(override.image);
            if (ev) return ev;
            return { image: override.image } as unknown as PolymarketEvent;
        }
        // Tier 2: exact title match
        const hit = exact.get(key);
        if (hit) return hit;

        // Tier 3: fuzzy token overlap with synonym expansion
        const qTokens = tokenize(question);
        if (qTokens.size === 0) return null;
        const qDistinct = new Set<string>();
        for (const t of qTokens) if (isDistinctive(t)) qDistinct.add(t);
        if (qDistinct.size === 0) return null;

        let best: { event: PolymarketEvent; score: number; vol: number } | null = null;
        for (const item of indexed) {
            let score = 0;
            for (const t of qDistinct) {
                if (item.tokens.has(t)) score++;
            }
            if (score === 0) continue;
            if (
                best === null ||
                score > best.score ||
                (score === best.score && item.vol > best.vol)
            ) {
                best = { event: item.event, score, vol: item.vol };
            }
        }
        return best?.event ?? null;
    };
}
