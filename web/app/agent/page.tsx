import Link from "next/link";
import {
    readDecisions,
    type AgentDecision,
    type AgentAction,
    type ToolTraceEntry,
} from "@/lib/agent-decisions";
import { formatCompactUsd } from "@/lib/format";
import { AgentProfileBanner } from "@/components/agent-profile-banner";

export const metadata = { title: "Agent" };

// Re-read the log on every request — append-only, cheap to parse, and we
// want freshness for the "live feed" feel. No ISR; just dynamic.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ u?: string }>;

export default async function AgentPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const sp = await searchParams;
    const userScope = sp.u && /^0x[a-fA-F0-9]{40}$/.test(sp.u) ? sp.u : null;

    const feed = await readDecisions(
        200,
        userScope ? { userAddr: userScope } : undefined,
    );

    if (feed.decisions.length === 0) {
        return <EmptyState scopedTo={userScope} />;
    }

    const liveCalls = feed.counts.buy_yes + feed.counts.buy_no;
    const total =
        feed.counts.buy_yes + feed.counts.buy_no + feed.counts.pass;
    const passRate = total > 0 ? feed.counts.pass / total : 0;
    const avgEdge =
        liveCalls > 0 ? feed.totalEdgePts / liveCalls : 0;

    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            {/* Status line */}
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6 flex-wrap">
                <span className="h-1.5 w-1.5 rounded-full bg-yes live-dot" />
                <span>
                    / agent ·{" "}
                    {userScope ? (
                        <span className="text-accent">
                            scope · {userScope.slice(0, 6)}…{userScope.slice(-4)}
                        </span>
                    ) : (
                        "all agents"
                    )}
                </span>
                <span className="text-text-faint">·</span>
                <span>{feed.paperOnly ? "paper" : "live"}</span>
                {feed.lastTs && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="num normal-case tracking-normal text-text-faint">
                            last call {relative(feed.lastTs)}
                        </span>
                    </>
                )}
                {userScope && (
                    <Link
                        href="/agent"
                        className="ml-auto text-[10px] normal-case tracking-normal text-text-faint hover:text-text transition-colors"
                    >
                        show all →
                    </Link>
                )}
            </div>

            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[42ch]">
                {userScope ? (
                    <>
                        Your agent&apos;s every call,{" "}
                        <span className="text-text-mute">
                            including the passes.
                        </span>
                    </>
                ) : (
                    <>
                        Every call the agent makes,{" "}
                        <span className="text-text-mute">
                            including the passes.
                        </span>
                    </>
                )}
            </h1>

            <div className="mt-6">
                <AgentProfileBanner />
            </div>

            {/* Stat strip */}
            <div className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-b border-border py-6">
                <Stat label="decisions" value={total.toString()} />
                <Stat
                    label="live calls"
                    value={liveCalls.toString()}
                    unit={`${feed.counts.buy_yes} yes · ${feed.counts.buy_no} no`}
                />
                <Stat
                    label="pass rate"
                    value={`${Math.round(passRate * 100)}%`}
                    unit={`${feed.counts.pass} passed`}
                />
                <Stat
                    label="avg edge"
                    value={`${avgEdge.toFixed(1)}pt`}
                    unit="on live calls"
                />
                {feed.bankroll !== null && (
                    <Stat
                        label="bankroll"
                        value={formatCompactUsd(feed.bankroll)}
                        unit="last snapshot"
                    />
                )}
            </div>

            {/* Feed */}
            <div className="mt-8 flex flex-col gap-3">
                {feed.decisions.map((d) => (
                    <DecisionCard key={`${d.ts}-${d.market}`} d={d} />
                ))}
            </div>
        </div>
    );
}

// ── Cards ─────────────────────────────────────────────────────────────────

function DecisionCard({ d }: { d: AgentDecision }) {
    const isPass = d.action === "pass";
    const accent = actionAccent(d.action);
    const hasBrain =
        d.brain_model !== null ||
        d.tool_trace.length > 0 ||
        d.news_summary.length > 0;

    return (
        <article
            className={`border ${accent.border} bg-bg-elev/40 px-5 py-4 transition-colors hover:bg-bg-elev/70`}
        >
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-x-8 gap-y-4">
                {/* Left: question + reasoning */}
                <div className="min-w-0 flex flex-col gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionChip action={d.action} />
                        <span className="text-[10.5px] uppercase tracking-[0.18em] text-text-mute">
                            {d.category}
                        </span>
                        <span className="text-text-faint">·</span>
                        <Link
                            href={`/markets/${d.market}`}
                            className="num text-[11px] text-text-mute hover:text-text transition-colors"
                        >
                            {short(d.market)}
                        </Link>
                        <span className="text-text-faint">·</span>
                        <time
                            dateTime={d.ts}
                            className="num text-[11px] text-text-faint"
                            title={d.ts}
                        >
                            {relative(d.ts)}
                        </time>
                        {!d.paper && (
                            <span className="ml-auto num text-[10px] uppercase tracking-[0.18em] text-yes border border-yes/30 px-1.5 py-0.5">
                                live
                            </span>
                        )}
                    </div>

                    <h3 className="text-[15.5px] leading-snug text-text">
                        <Link
                            href={`/markets/${d.market}`}
                            className="hover:text-accent transition-colors"
                        >
                            {d.question}
                        </Link>
                    </h3>

                    {d.reasoning && (
                        <p className="text-[13px] leading-[1.55] text-text-dim">
                            {d.reasoning}
                        </p>
                    )}

                    {isPass && d.pass_reason && (
                        <div className="text-[11.5px] num text-text-mute">
                            <span className="text-text-faint">pass · </span>
                            {d.pass_reason}
                        </div>
                    )}

                    {d.watch_for.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                            {d.watch_for.slice(0, 4).map((w, i) => (
                                <span
                                    key={i}
                                    className="text-[10.5px] num text-text-mute bg-bg-elev border border-border px-2 py-0.5"
                                    title="watching for"
                                >
                                    {w}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Right: numbers */}
                <div className="flex flex-col gap-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
                    {/* Three-way price strip */}
                    <div className="grid grid-cols-3 gap-2">
                        <Probe
                            label="market"
                            value={pct(d.market_prob)}
                            tone="text-text-dim"
                        />
                        <Probe
                            label="poly"
                            value={d.polymarket_prob !== null ? pct(d.polymarket_prob) : "—"}
                            tone="text-text-dim"
                        />
                        <Probe
                            label="ai"
                            value={pct(d.ai_prob)}
                            tone={accent.text}
                        />
                    </div>

                    {/* Edge + confidence + size */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                        <Meta
                            k="edge"
                            v={
                                <span
                                    className={
                                        d.edge_pts >= 0 ? "text-yes" : "text-no"
                                    }
                                >
                                    {d.edge_pts >= 0 ? "+" : ""}
                                    {d.edge_pts.toFixed(1)}pt
                                </span>
                            }
                        />
                        <Meta
                            k="conf"
                            v={
                                <span className="text-text-dim">
                                    {Math.round(d.ai_confidence * 100)}%
                                </span>
                            }
                        />
                        <Meta
                            k="kelly"
                            v={
                                <span className="text-text-dim">
                                    {(d.kelly_fraction * 100).toFixed(1)}%
                                </span>
                            }
                        />
                        <Meta
                            k="t-sens"
                            v={
                                <span className="text-text-dim uppercase tracking-wide text-[10px]">
                                    {d.time_sensitivity}
                                </span>
                            }
                        />
                    </div>

                    {d.brain_model && (
                        <div className="text-[10px] num uppercase tracking-[0.18em] text-text-faint flex items-center gap-1.5">
                            <span className="h-1 w-1 rounded-full bg-accent" />
                            <span className="text-accent normal-case tracking-normal">
                                {d.brain_model}
                            </span>
                            {d.brain_iterations !== null && (
                                <>
                                    <span className="text-text-faint">·</span>
                                    <span className="normal-case tracking-normal">
                                        {d.brain_iterations}{" "}
                                        {d.brain_iterations === 1
                                            ? "iter"
                                            : "iters"}
                                    </span>
                                </>
                            )}
                            {d.tool_trace.length > 0 && (
                                <>
                                    <span className="text-text-faint">·</span>
                                    <span className="normal-case tracking-normal">
                                        {d.tool_trace.length}{" "}
                                        {d.tool_trace.length === 1
                                            ? "tool call"
                                            : "tool calls"}
                                    </span>
                                </>
                            )}
                        </div>
                    )}

                    {!isPass && (
                        <div className="border-t border-border pt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                            <Meta
                                k="size"
                                v={
                                    <span className="num text-text">
                                        ${d.cost_usdc.toFixed(2)}
                                    </span>
                                }
                            />
                            <Meta
                                k="shares"
                                v={
                                    <span className="num text-text-dim">
                                        {(d.shares / 1e6).toFixed(2)}
                                    </span>
                                }
                            />
                            {d.tx_hash ? (
                                <div className="col-span-2">
                                    <Meta
                                        k="tx"
                                        v={
                                            <a
                                                href={`https://testnet.arcscan.app/tx/${d.tx_hash}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="num text-accent hover:text-text transition-colors break-all text-[11px]"
                                            >
                                                {d.tx_hash.slice(0, 14)}…
                                            </a>
                                        }
                                    />
                                </div>
                            ) : (
                                <div className="col-span-2 text-[10.5px] num uppercase tracking-[0.18em] text-text-faint">
                                    paper trade · no broadcast
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {hasBrain && <BrainTrace d={d} />}
        </article>
    );
}

// ── Brain trace (Phase 5) ─────────────────────────────────────────────────
// Renders the Claude tool-use brain's news summary and step-by-step tool
// calls. Native <details> means no client-side state — server-render only.
// This is the judge-replayable artifact RFB 02 is scoring under "agentic
// sophistication" — every claim in `reasoning` should be traceable here.

function BrainTrace({ d }: { d: AgentDecision }) {
    return (
        <div className="mt-4 border-t border-border pt-4 space-y-3">
            {d.news_summary && (
                <div>
                    <div className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5 num">
                        / news summary
                    </div>
                    <p className="text-[12.5px] leading-[1.55] text-text-dim">
                        {d.news_summary}
                    </p>
                </div>
            )}

            {d.tool_trace.length > 0 && (
                <details className="group">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-[0.22em] text-text-mute hover:text-text-dim transition-colors num inline-flex items-center gap-2 list-none">
                        <span className="inline-block transition-transform group-open:rotate-90">
                            ▸
                        </span>
                        tool trace ({d.tool_trace.length})
                    </summary>
                    <ol className="mt-3 space-y-2 num text-[11.5px]">
                        {d.tool_trace.map((step, i) => (
                            <TraceStep key={i} step={step} />
                        ))}
                    </ol>
                </details>
            )}
        </div>
    );
}

function TraceStep({ step }: { step: ToolTraceEntry }) {
    return (
        <li
            className={`border-l-2 ${
                step.is_error ? "border-no" : "border-accent/60"
            } pl-3 py-1`}
        >
            <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-text-faint">
                    {String(step.iteration).padStart(2, "0")}
                </span>
                <span
                    className={`${
                        step.is_error ? "text-no" : "text-text"
                    } font-medium`}
                >
                    {step.name}
                </span>
                <span className="text-[10px] text-text-faint normal-case tracking-normal ml-auto tabular">
                    {step.elapsed_ms}ms
                </span>
            </div>
            <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]">
                <CodeBlock label="input" value={step.input} />
                <CodeBlock label="result" value={step.result} />
            </div>
        </li>
    );
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
    // JSON.stringify is intentionally compact — judges scanning tool I/O at
    // a glance don't want pretty-printed 30-line blocks for a {q: "..."} arg.
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch {
        serialized = String(value);
    }
    return (
        <div className="min-w-0">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint mr-1.5">
                {label}
            </span>
            <span className="text-text-dim break-words">
                {serialized.length > 240
                    ? serialized.slice(0, 240) + "…"
                    : serialized}
            </span>
        </div>
    );
}

function ActionChip({ action }: { action: AgentAction }) {
    const a = actionAccent(action);
    const label =
        action === "buy_yes" ? "buy yes" : action === "buy_no" ? "buy no" : "pass";
    return (
        <span
            className={`num text-[10px] uppercase tracking-[0.22em] ${a.text} border ${a.border} px-2 py-0.5 inline-flex items-center gap-1.5`}
        >
            <span className={`w-1 h-1 rounded-full ${a.dot}`} />
            {label}
        </span>
    );
}

function Probe({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone: string;
}) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint num">
                {label}
            </span>
            <span className={`num tabular text-[16px] leading-none ${tone}`}>
                {value}
            </span>
        </div>
    );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-[9.5px] uppercase tracking-[0.18em] text-text-mute num">
                {k}
            </span>
            <span className="text-right tabular">{v}</span>
        </div>
    );
}

function Stat({
    label,
    value,
    unit,
}: {
    label: string;
    value: string;
    unit?: string;
}) {
    return (
        <div className="flex flex-col min-w-0">
            <span className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5">
                {label}
            </span>
            <span className="num text-[18px] text-text tabular leading-none">
                {value}
                {unit && (
                    <span className="text-text-faint text-[10.5px] ml-1.5 lowercase tracking-normal">
                        · {unit}
                    </span>
                )}
            </span>
        </div>
    );
}

// ── Empty state — preserves the original "agent isn't live yet" copy ─────

function EmptyState({ scopedTo }: { scopedTo?: string | null }) {
    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6">
                <span className="h-1.5 w-1.5 rounded-full bg-text-mute" />
                <span>/ agent · idle</span>
                {scopedTo && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="text-accent normal-case tracking-normal">
                            scope {scopedTo.slice(0, 6)}…{scopedTo.slice(-4)}
                        </span>
                    </>
                )}
            </div>

            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[36ch]">
                {scopedTo ? (
                    <>
                        Your agent{" "}
                        <span className="text-text-mute">
                            hasn&apos;t made a call yet.
                        </span>
                    </>
                ) : (
                    <>
                        The autonomous trader{" "}
                        <span className="text-text-mute">
                            hasn&apos;t made a call yet.
                        </span>
                    </>
                )}
            </h1>

            <div className="mt-6">
                <AgentProfileBanner />
            </div>

            <p className="mt-5 text-[14px] text-text-dim max-w-[58ch] leading-relaxed">
                A Claude-driven agent watches every market on this factory,
                searches the web for fresh evidence, pulls Polymarket as a
                crowd signal, sizes by fractional Kelly, and broadcasts the
                trade on Arc. Every decision lands here with the full tool
                trace — including the markets it explicitly passes on.
            </p>

            <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border">
                <Spec
                    title="tools the brain calls"
                    bullets={[
                        "web_search / web_fetch — Anthropic-hosted, no API keys to manage",
                        "fetch_polymarket_odds — fuzzy-matched crowd prior via Gamma",
                        "compute_kelly — deterministic fractional-Kelly sizing math",
                    ]}
                />
                <Spec
                    title="decision loop"
                    bullets={[
                        "Claude Sonnet 4.6 with adaptive thinking; tool trace stored per decision",
                        "Risk profiles: ¼ / ½ / full Kelly with per-tier edge thresholds",
                        "Cap of 30% bankroll per market, $0.10 minimum bet size",
                    ]}
                />
                <Spec
                    title="execution"
                    bullets={[
                        "AgentAccount.execute() — session-key signed, USDC auto-approved per call",
                        "2% slippage cap on buy(); never exceeds the per-call cap",
                        "Decision row + tool trace persisted to Postgres for replay",
                    ]}
                />
                <Spec
                    title="run it"
                    bullets={[
                        "Set ANTHROPIC_API_KEY in .env then: cd agent && uv run python loop.py",
                        "uv run python loop.py --live --user 0x… (broadcast for one user)",
                        "Decisions land in Postgres; this page lights up automatically",
                    ]}
                />
            </div>

            <div className="mt-12 border-t border-border pt-8 flex flex-wrap items-baseline gap-4 text-[12px] text-text-mute">
                <span className="uppercase tracking-[0.18em]">in the meantime</span>
                <Link href="/" className="text-text-dim hover:text-text transition-colors">
                    browse markets →
                </Link>
                <Link
                    href="/portfolio"
                    className="text-text-dim hover:text-text transition-colors"
                >
                    your portfolio →
                </Link>
            </div>
        </div>
    );
}

function Spec({ title, bullets }: { title: string; bullets: string[] }) {
    return (
        <div className="bg-bg p-6">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-4">
                / {title}
            </div>
            <ul className="space-y-2.5 text-[13px] text-text-dim leading-relaxed">
                {bullets.map((b, i) => (
                    <li key={i} className="flex gap-3">
                        <span className="num text-text-faint shrink-0">
                            {String(i + 1).padStart(2, "0")}
                        </span>
                        <span>{b}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function actionAccent(action: AgentAction) {
    switch (action) {
        case "buy_yes":
            return {
                border: "border-yes/35",
                text: "text-yes",
                dot: "bg-yes",
            };
        case "buy_no":
            return {
                border: "border-no/35",
                text: "text-no",
                dot: "bg-no",
            };
        default:
            return {
                border: "border-border",
                text: "text-text-mute",
                dot: "bg-text-faint",
            };
    }
}

function pct(p: number): string {
    return `${(p * 100).toFixed(1)}%`;
}

function short(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relative(ts: string): string {
    const then = Date.parse(ts);
    if (Number.isNaN(then)) return ts;
    const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
