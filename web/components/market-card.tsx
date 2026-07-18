import Link from "next/link";
import type { PolymarketEvent } from "@/lib/polymarket";
import { formatCents, formatCompactUsd, formatTimeUntil } from "@/lib/format";

type Props = {
    event: PolymarketEvent;
};

/** A Polymarket discovery card — square image, dense binary outcome.
 *
 *  Visual: softened dark surface, refined border on hover, subtle lift.
 *  Below `sm` the card collapses into a compact horizontal row (narrow
 *  thumbnail strip, two-line title) so phones fit several markets per screen.
 *  Image fallback: deterministic colored tile if the Gamma payload has no
 *  image (rare but it happens — some long-tail events ship with `image: null`).
 */
export function MarketCard({ event }: Props) {
    const ends = event.endTs ? formatTimeUntil(event.endTs) : null;
    const href = `/markets/p/${event.slug}`;
    const o = event.outcomes[0];

    return (
        <Link
            href={href}
            className="card-lift surface-soft group relative flex flex-row sm:flex-col border border-border/80 hover:border-border-strong focus-visible:border-accent outline-none rounded-2xl overflow-hidden"
        >
            <div className="relative w-[88px] shrink-0 self-stretch sm:w-auto sm:self-auto sm:aspect-square bg-bg-elev-2 overflow-hidden">
                {event.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={event.image}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 scale-[1.18] sm:scale-100 sm:group-hover:scale-[1.06]"
                    />
                ) : (
                    <ImageFallback title={event.title} category={event.category} />
                )}
                {/* Bottom-up gradient so badges read against busy images */}
                <div className="hidden sm:block absolute inset-0 bg-gradient-to-t from-bg/85 via-bg/15 to-transparent pointer-events-none" />
                <div className="hidden sm:block absolute top-2.5 left-2.5 num text-[9.5px] uppercase tracking-[0.18em] text-text bg-bg/70 backdrop-blur-md px-2 py-0.5 border border-border-strong rounded-full">
                    {event.category}
                </div>
                {o.deltaPct !== undefined && Math.abs(o.deltaPct) >= 0.5 && (
                    <DeltaBadge delta={o.deltaPct} />
                )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col p-3 gap-2 sm:p-3.5 sm:gap-3">
                <h3 className="text-[13px] sm:text-[13.5px] leading-[1.35] font-medium text-text line-clamp-2 sm:line-clamp-3 sm:min-h-[3em]">
                    {event.title}
                </h3>

                <BinaryRow yes={o.yesPrice} no={o.noPrice} />

                <div className="flex items-center justify-between gap-2 mt-auto pt-2 sm:pt-2.5 border-t border-border/70 text-[10.5px] num tracking-wide">
                    <span className="text-text-mute truncate">
                        <span className="text-text-dim tabular">
                            {formatCompactUsd(event.volume24h)}
                        </span>
                        <span className="text-text-faint ml-1.5 lowercase">24h vol</span>
                    </span>
                    {ends && (
                        <span className="text-text-mute tabular shrink-0">
                            {ends} <span className="text-text-faint lowercase">left</span>
                        </span>
                    )}
                </div>
            </div>
        </Link>
    );
}

function BinaryRow({ yes, no }: { yes: number; no: number }) {
    return (
        <div className="grid grid-cols-2 gap-2">
            <div className="pill-yes flex items-center justify-between px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl">
                <span className="text-[9.5px] uppercase tracking-[0.2em] text-yes font-medium">yes</span>
                <span className="num text-[12.5px] sm:text-[13.5px] text-text tabular">{formatCents(yes)}</span>
            </div>
            <div className="pill-no flex items-center justify-between px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl">
                <span className="text-[9.5px] uppercase tracking-[0.2em] text-no font-medium">no</span>
                <span className="num text-[12.5px] sm:text-[13.5px] text-text tabular">{formatCents(no)}</span>
            </div>
        </div>
    );
}

function DeltaBadge({ delta }: { delta: number }) {
    const up = delta >= 0;
    const fmt = `${up ? "+" : ""}${delta.toFixed(1)}pt`;
    return (
        <div
            className={`hidden sm:block absolute top-2.5 right-2.5 num text-[9.5px] tabular tracking-tight px-2 py-0.5 border rounded-full backdrop-blur-md ${
                up
                    ? "text-yes border-yes/40 bg-yes/15"
                    : "text-no border-no/40 bg-no/15"
            }`}
        >
            {fmt}
        </div>
    );
}

/** Deterministic colored tile used when the upstream image is null. The hue is
 *  derived from the title hash so the same event always gets the same tile. */
function ImageFallback({ title, category }: { title: string; category: string }) {
    const hue = hashHue(title);
    const initial = (title.trim()[0] || "?").toUpperCase();

    return (
        <div className="absolute inset-0 overflow-hidden grid-underlay">
            {/* Two-stop radial gradient — adds depth without dominating */}
            <div
                className="absolute inset-0"
                style={{
                    background: `radial-gradient(ellipse at 30% 25%, hsla(${hue}, 60%, 55%, 0.18), transparent 60%),
                        radial-gradient(ellipse at 75% 80%, hsla(${(hue + 60) % 360}, 50%, 45%, 0.13), transparent 55%)`,
                }}
            />
            {/* Glyph */}
            <div className="absolute inset-0 flex items-center justify-center">
                <span
                    className="num font-medium text-text-mute"
                    style={{
                        fontSize: "clamp(64px, 16vw, 120px)",
                        letterSpacing: "-0.04em",
                        opacity: 0.85,
                        color: `hsla(${hue}, 35%, 78%, 0.32)`,
                    }}
                >
                    {initial}
                </span>
            </div>
            {/* Tiny category mark in lower-right for orientation */}
            <div className="absolute bottom-2 right-2 num text-[9px] uppercase tracking-[0.18em] text-text-faint">
                {category.toLowerCase()}
            </div>
        </div>
    );
}

function hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
}
