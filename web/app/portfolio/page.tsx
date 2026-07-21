import { Suspense } from "react";
import { listMarkets } from "@/lib/markets";
import { PortfolioClient, type PortfolioMarket } from "./portfolio-client";

export const metadata = { title: "Portfolio" };

// The market list comes from the server (Postgres catalog index) so the client
// never enumerates ~15k on-chain markets. ISR: the list is the same for every
// visitor (the per-wallet positions are read client-side), so serve a cached
// render and regenerate every 60s rather than recomputing per request.
export const revalidate = 60;

export default async function PortfolioPage() {
    const all = await listMarkets().catch(() => []);
    // v2 markets only for now (the legacy v1 factory is frozen; a proper
    // cross-factory position index is the follow-up). Serialize bigint prices
    // to strings for the client boundary.
    const markets: PortfolioMarket[] = all
        .filter((m) => !m.legacy)
        .map((m) => ({
            address: m.address,
            question: m.question,
            priceYes: m.priceYes.toString(),
            resolved: m.resolved,
            outcome: m.outcome,
        }));

    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6">
                / portfolio
            </div>
            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium mb-8">
                Your positions
            </h1>
            <Suspense fallback={<div className="text-text-mute text-[13px]">loading…</div>}>
                <PortfolioClient markets={markets} />
            </Suspense>
        </div>
    );
}
