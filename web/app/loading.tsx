/** Instant skeleton while the homepage server-fetches the Polymarket catalog
 *  and reads the on-chain market list. The shape mirrors the real layout to
 *  prevent layout shift when the data swaps in. */
export default function HomeLoading() {
    return (
        <div>
            {/* Status strip skeleton */}
            <section className="border-b border-border bg-bg-elev/40">
                <div className="mx-auto max-w-[1440px] px-6 py-6 md:py-8 flex flex-wrap gap-x-10 gap-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex flex-col gap-2 min-w-[100px]">
                            <span className="h-2 w-20 bg-border" />
                            <span className="h-4 w-28 bg-border-strong" />
                        </div>
                    ))}
                </div>
            </section>

            {/* Filter bar skeleton */}
            <section className="border-b border-border">
                <div className="mx-auto max-w-[1440px] px-6 py-3 flex items-center gap-3">
                    <div className="flex-1 h-10 max-w-md bg-bg-elev border border-border" />
                    <div className="h-8 w-28 bg-bg-elev border border-border" />
                </div>
                <div className="mx-auto max-w-[1440px] px-6 pb-3 flex gap-1.5">
                    {Array.from({ length: 7 }).map((_, i) => (
                        <div key={i} className="h-8 w-20 bg-bg-elev border border-border" />
                    ))}
                </div>
            </section>

            {/* Grid skeleton */}
            <section className="mx-auto max-w-[1440px] px-6 py-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {Array.from({ length: 15 }).map((_, i) => (
                        <div
                            key={i}
                            className="flex flex-col bg-bg-elev border border-border"
                        >
                            <div className="aspect-square bg-bg-elev-2 shimmer" />
                            <div className="p-3.5 flex flex-col gap-3">
                                <div className="space-y-1.5">
                                    <div className="h-3 w-full bg-border" />
                                    <div className="h-3 w-4/5 bg-border" />
                                    <div className="h-3 w-2/3 bg-border" />
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                    <div className="h-7 bg-bg-elev-2 border border-border" />
                                    <div className="h-7 bg-bg-elev-2 border border-border" />
                                </div>
                                <div className="flex justify-between pt-2 border-t border-border">
                                    <span className="h-2 w-16 bg-border" />
                                    <span className="h-2 w-12 bg-border" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
