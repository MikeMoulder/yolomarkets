import Link from "next/link";
import { NativeMarketCard, type NativeCardModel } from "./native-market-card";

type Props = {
    /** Two-digit section index for the engineered header numbering. */
    index: string;
    label: string;
    /** Total in the group (drives the "see all" affordance when > items). */
    total: number;
    items: NativeCardModel[];
    /** Where "see all" points — usually the filtered catalog (`/?cat=...`). */
    seeAllHref: string;
};

/** One labeled group in the curated browse (Fast, Crypto, Sports, …). A capped
 *  responsive grid of the standard catalog cards with a "see all" that hands
 *  off to the filtered grid. Renders nothing when empty. */
export function MarketSection({ index, label, total, items, seeAllHref }: Props) {
    if (items.length === 0) return null;

    return (
        <section className="mx-auto max-w-[1440px] px-6 pt-8">
            <header className="flex items-end justify-between mb-4 border-b border-border pb-3">
                <div className="flex items-baseline gap-3">
                    <span className="section-number text-[11px] tabular">{index}</span>
                    <h2 className="text-[18px] md:text-[20px] font-medium tracking-tight text-text">
                        {label}
                    </h2>
                    <span className="num text-[12px] text-text-mute tabular">{total}</span>
                </div>
                {total > items.length && (
                    <Link
                        href={seeAllHref}
                        scroll={false}
                        className="group inline-flex items-center gap-1.5 text-[12px] text-text-mute hover:text-text transition-colors"
                    >
                        see all
                        <span className="transition-transform group-hover:translate-x-0.5">→</span>
                    </Link>
                )}
            </header>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3">
                {items.map((m) => (
                    <NativeMarketCard key={m.address} m={m} />
                ))}
            </div>
        </section>
    );
}
