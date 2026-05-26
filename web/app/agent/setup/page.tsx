import { fetchPolymarketEvents, CATEGORY_LABELS } from "@/lib/polymarket";
import { listMarkets, type MarketSummary } from "@/lib/markets";
import { SetupWizard } from "./setup-client";

export const metadata = { title: "Set up your agent" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
    // Pre-load native markets so the watchlist picker can hydrate instantly.
    // Polymarket events feed the category counts.
    const [nativeRes, eventsRes] = await Promise.allSettled([
        listMarkets(),
        fetchPolymarketEvents({ limit: 300 }),
    ]);
    const native: MarketSummary[] =
        nativeRes.status === "fulfilled" ? nativeRes.value : [];
    const events = eventsRes.status === "fulfilled" ? eventsRes.value : [];

    // Counts per category (across catalog + native) for sizing chips
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    for (const m of native) {
        const c = m.category.trim();
        counts.set(c, (counts.get(c) ?? 0) + 1);
    }

    const nativeForClient = native
        .filter((m) => !m.resolved)
        .map((m) => ({
            address: m.address,
            question: m.question,
            category: m.category,
        }));

    return (
        <SetupWizard
            categories={CATEGORY_LABELS.map((label) => ({
                label,
                count: counts.get(label) ?? 0,
            }))}
            nativeMarkets={nativeForClient}
        />
    );
}
