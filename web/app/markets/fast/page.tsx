import Link from "next/link";
import { listMarkets } from "@/lib/markets";
import { NativeMarketCard, toNativeCardModel } from "@/components/native-market-card";
import {
    getFastMarketImage,
    matchesFastMarket,
    isFastMarket,
    sortFastMarketsByDeadline,
} from "@/lib/fast-markets";
import { formatAbs, formatOutcomeLabel, shortAddr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function FastMarketsPage() {
    const native = await listMarkets().catch(() => []);

    const fast = sortFastMarketsByDeadline(native.filter(isFastMarket));
    const fastHistory = [...native.filter((m) => m.resolved && matchesFastMarket(m))].sort(
        (a, b) => Number(b.deadline - a.deadline),
    );

    return (
        <div className="mx-auto max-w-[1440px] px-6 py-8 md:py-10">
            <Link
                href="/"
                className="text-[12px] text-text-mute hover:text-text-dim transition-colors"
            >
                ← markets
            </Link>

            <header className="mt-5 mb-6 border-b border-border pb-4 flex items-end justify-between gap-4">
                <div>
                    <div className="flex items-baseline gap-3 mb-2">
                        <span className="section-number text-[11px] tabular">04</span>
                        <span className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            Crypto · short duration
                        </span>
                    </div>
                    <h1 className="text-[28px] md:text-[34px] leading-[1.1] tracking-tight font-medium text-text">
                        Fast markets
                    </h1>
                    <p className="mt-2 text-[13px] text-text-dim max-w-[72ch] leading-[1.55]">
                        Active BTC, ETH, and SOL markets with rapid windows (15m / 1h
                        up-down style). Sorted by soonest deadline.
                    </p>
                </div>
                <span className="num text-[12px] text-text-mute tabular">
                    {fast.length} {fast.length === 1 ? "market" : "markets"}
                </span>
            </header>

            {fast.length === 0 ? (
                <div className="border border-dashed border-border rounded-2xl px-6 py-16 text-center">
                    <div className="num text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                        / none live yet
                    </div>
                    <p className="text-text-dim text-[13.5px]">
                        Create fast BTC/ETH/SOL markets from admin and they will appear here.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {fast.map((m) => (
                        <NativeMarketCard
                            key={m.address}
                            m={toNativeCardModel(m, getFastMarketImage(m.question))}
                        />
                    ))}
                </div>
            )}

            <section className="mt-10 border border-border rounded-2xl overflow-hidden">
                <header className="px-5 py-3 border-b border-border flex items-baseline justify-between gap-4">
                    <div>
                        <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            Fast history
                        </div>
                        <p className="mt-1 text-[13px] text-text-dim">
                            Completed and cancelled fast rounds remain tracked on-chain.
                        </p>
                    </div>
                    <span className="num text-[12px] text-text-mute tabular">
                        {fastHistory.length} rounds
                    </span>
                </header>

                {fastHistory.length === 0 ? (
                    <div className="px-6 py-12 text-[13px] text-text-dim text-center">
                        No settled fast rounds yet.
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {fastHistory.slice(0, 12).map((m) => (
                            <Link
                                key={m.address}
                                href={`/markets/${m.address}`}
                                className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 px-5 py-4 hover:bg-bg-elev transition-colors"
                            >
                                <div>
                                    <div className="text-[13.5px] text-text leading-snug">{m.question}</div>
                                    <div className="mt-1 num text-[10px] text-text-faint">
                                        {shortAddr(m.address, 6)} · {formatAbs(m.deadline)}
                                    </div>
                                </div>
                                <div className="num text-[11px] uppercase tracking-[0.18em] text-text-mute self-center">
                                    {m.category}
                                </div>
                                <div
                                    className={`num text-[11px] uppercase tracking-[0.18em] self-center ${
                                        m.outcome === 1
                                            ? "text-yes"
                                            : m.outcome === 2
                                              ? "text-no"
                                              : "text-text-mute"
                                    }`}
                                >
                                    {formatOutcomeLabel(m.outcome)}
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
