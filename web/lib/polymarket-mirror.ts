export const POLYMARKET_MIRROR_PREFIX = "POLYMARKET_MIRROR:";

export type PolymarketMirrorMeta = {
    version: 1;
    polymarketSlug: string;
    eventSlug: string | null;
    conditionId: string | null;
    yesTokenId: string | null;
    noTokenId: string | null;
    resolutionSource: string | null;
    endDate: string | null;
    umaEndDate: string | null;
};

export function buildPolymarketMirrorCriteria(
    meta: PolymarketMirrorMeta,
    description?: string | null,
): string {
    const lines = [
        `${POLYMARKET_MIRROR_PREFIX}${JSON.stringify(meta)}`,
        "Resolves YES iff the exact underlying Polymarket binary market resolves YES via Polymarket's official UMA resolution flow.",
        "Resolves NO iff that Polymarket market resolves NO.",
        "If Polymarket resolution is ambiguous, disputed, 50/50, or unavailable, this market remains pending for admin review.",
    ];

    const cleanDescription = description?.replace(/\s+/g, " ").trim();
    if (cleanDescription) {
        lines.push(`Polymarket criteria excerpt: ${cleanDescription}`);
    }

    return lines.join("\n");
}

export function parsePolymarketMirrorMeta(
    criteria: string,
): PolymarketMirrorMeta | null {
    const first = criteria.split("\n")[0] ?? "";
    if (!first.startsWith(POLYMARKET_MIRROR_PREFIX)) return null;

    try {
        const parsed = JSON.parse(
            first.slice(POLYMARKET_MIRROR_PREFIX.length),
        ) as Partial<PolymarketMirrorMeta>;

        if (
            parsed.version === 1 &&
            typeof parsed.polymarketSlug === "string" &&
            parsed.polymarketSlug.length > 0
        ) {
            return {
                version: 1,
                polymarketSlug: parsed.polymarketSlug,
                eventSlug: parsed.eventSlug ?? null,
                conditionId: parsed.conditionId ?? null,
                yesTokenId: parsed.yesTokenId ?? null,
                noTokenId: parsed.noTokenId ?? null,
                resolutionSource: parsed.resolutionSource ?? null,
                endDate: parsed.endDate ?? null,
                umaEndDate: parsed.umaEndDate ?? null,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function stripPolymarketMirrorMeta(criteria: string): string {
    const firstBreak = criteria.indexOf("\n");
    if (!criteria.startsWith(POLYMARKET_MIRROR_PREFIX)) return criteria;
    return firstBreak >= 0 ? criteria.slice(firstBreak + 1).trim() : "";
}
