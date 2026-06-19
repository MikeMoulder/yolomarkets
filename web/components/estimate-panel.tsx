import { ProbBar } from "./prob-bar";
import { formatProb } from "@/lib/format";
import type { Estimate } from "@/lib/llm";

type ActionClass = {
    box: string;
    text: string;
};

export function EstimatePanel({
    estimate,
    marketProb,
}: {
    estimate: Estimate | null;
    marketProb: number;
}) {
    if (!estimate) {
        return (
            <section className="border border-border bg-bg-elev/40">
                <Header />
                <div className="px-5 py-8 text-center">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                        / no estimate yet
                    </div>
                    <p className="text-[13px] text-text-dim">
                        The agent hasn&apos;t scored this market yet. Either the API key
                        isn&apos;t configured, or the loop hasn&apos;t covered this market
                        on its watchlist.
                    </p>
                </div>
            </section>
        );
    }

    const edge = estimate.probability - marketProb;
    const edgePts = edge * 100;
    const edgeColor =
        Math.abs(edgePts) < 3 ? "text-text-mute" : edge > 0 ? "text-yes" : "text-no";
    const actionClass = getActionClass(estimate.action);
    const sizeLabel = getSizeLabel(estimate.suggested_size);

    return (
        <section className="border border-border bg-bg-elev/40">
            <Header confidence={estimate.confidence} sensitivity={estimate.time_sensitivity} />

            <div className="px-5 py-5 space-y-5">
                {/* Headline numbers */}
                <div className="grid grid-cols-3 gap-4 num">
                    <Big
                        label="crowd"
                        value={formatProb(marketProb)}
                        valueClass="text-text-dim"
                    />
                    <Big
                        label="AI estimate"
                        value={formatProb(estimate.probability)}
                        valueClass="text-text"
                    />
                    <Big
                        label="edge"
                        value={
                            Math.abs(edgePts) < 0.5
                                ? "—"
                                : `${edgePts >= 0 ? "+" : ""}${edgePts.toFixed(1)} pt`
                        }
                        valueClass={edgeColor}
                    />
                </div>

                {/* Action */}
                <div className={`border px-4 py-3 ${actionClass.box}`}>
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-1">
                                suggested action
                            </div>
                            <div className={`text-[18px] leading-tight font-medium ${actionClass.text}`}>
                                {estimate.action_label}
                            </div>
                        </div>
                        <div className="num text-[10px] uppercase tracking-[0.15em] text-text-mute sm:text-right">
                            size <span className="text-text-dim">{sizeLabel}</span>
                        </div>
                    </div>
                    <p className="mt-2 text-[13px] text-text-dim leading-relaxed">
                        {estimate.action_summary}
                    </p>
                    {estimate.actionable_tips?.length > 0 && (
                        <ul className="mt-3 space-y-1.5 text-[12.5px] text-text-dim">
                            {estimate.actionable_tips.map((tip, i) => (
                                <li key={i} className="flex gap-2">
                                    <span className="text-text-faint num">-&gt;</span>
                                    <span>{tip}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Visual comparison bar */}
                <div className="space-y-2">
                    <ProbBar p={estimate.probability} />
                    <div className="flex items-center justify-between text-[10px] text-text-mute uppercase tracking-[0.15em]">
                        <span>0%</span>
                        <span>50%</span>
                        <span>100%</span>
                    </div>
                </div>

                {/* Reasoning */}
                <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                        reasoning
                    </div>
                    <p className="text-[13px] text-text-dim leading-relaxed">
                        {estimate.reasoning}
                    </p>
                </div>

                {/* Watch-for + sources */}
                {estimate.watch_for?.length > 0 && (
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            watch for
                        </div>
                        <ul className="space-y-1.5 text-[12.5px] text-text-dim">
                            {estimate.watch_for.map((w, i) => (
                                <li key={i} className="flex gap-2">
                                    <span className="text-text-faint num">→</span>
                                    <span>{w}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {estimate.key_sources?.length > 0 && (
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            sources
                        </div>
                        <ul className="space-y-1 text-[12px]">
                            {estimate.key_sources.map((src, i) => (
                                <li key={i}>
                                    <a
                                        href={src}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="num text-text-dim hover:text-text underline-offset-2 hover:underline break-all"
                                    >
                                        {src}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Disclaimer */}
                <div className="flex items-start gap-2 border-t border-border pt-3 text-[11px] text-warn leading-relaxed">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="mt-px h-3.5 w-3.5 shrink-0"
                    >
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <p>
                        This is AI-generated estimate, not financial advice. Models can be wrong or
                        out of date, DYOR before trading.
                    </p>
                </div>
            </div>
        </section>
    );
}

function Header({
    confidence,
    sensitivity,
}: {
    confidence?: number;
    sensitivity?: "low" | "medium" | "high";
}) {
    return (
        <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
            <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                / ai estimate
            </h3>
            {confidence !== undefined && (
                <div className="flex items-center gap-4 num text-[10px] uppercase tracking-[0.15em] text-text-mute">
                    <span>
                        conf <span className="text-text-dim tabular">{(confidence * 100).toFixed(0)}%</span>
                    </span>
                    {sensitivity && (
                        <span>
                            t-sens <span className="text-text-dim">{sensitivity}</span>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

function Big({
    label,
    value,
    valueClass,
}: {
    label: string;
    value: string;
    valueClass: string;
}) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-1">
                {label}
            </div>
            <div className={`text-[28px] leading-none tabular ${valueClass}`}>{value}</div>
        </div>
    );
}

function getActionClass(action: Estimate["action"]): ActionClass {
    if (action === "buy_yes") {
        return {
            box: "border-yes/40 bg-yes/10",
            text: "text-yes",
        };
    }

    if (action === "buy_no") {
        return {
            box: "border-no/40 bg-no/10",
            text: "text-no",
        };
    }

    return {
        box: "border-border bg-bg-elev/30",
        text: "text-text",
    };
}

function getSizeLabel(size: Estimate["suggested_size"]): string {
    if (size === "medium") return "medium";
    if (size === "small") return "small";
    return "no position";
}
