"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    useAccount,
    useReadContract,
    useSignMessage,
    useWriteContract,
    useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits } from "viem";
import {
    ADDRESSES,
    agentFactoryAbi,
    agentAccountAbi,
    BUY_SELECTOR,
} from "@/lib/contracts";
import { shortAddr } from "@/lib/format";
import { PATTERN_LIST, type PatternId, PATTERNS } from "@/lib/agent-patterns";
import { signProfileOp } from "@/lib/client-auth";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

type Category = { label: string; count: number };
type NativeMarketLite = {
    address: `0x${string}`;
    question: string;
    category: string;
};

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

type SessionMeta = {
    sessionKeyAddress: `0x${string}`;
    sessionValidUntil: number;
    sessionTotalCap: number;
    sessionPerCallCap: number;
};

export function SetupWizard({
    categories,
    nativeMarkets,
}: {
    categories: Category[];
    nativeMarkets: NativeMarketLite[];
}) {
    const { address, isConnected } = useAccount();
    const { signMessageAsync } = useSignMessage();
    const router = useRouter();

    const [step, setStep] = useState<Step>(1);
    const [pattern, setPattern] = useState<PatternId>("value");
    const [marketsMode, setMarketsMode] = useState<
        "all" | "categories" | "watchlist"
    >("all");
    const [pickedCats, setPickedCats] = useState<Set<string>>(new Set());
    const [pickedMarkets, setPickedMarkets] = useState<Set<string>>(new Set());
    const [marketSearch, setMarketSearch] = useState("");
    const [budgetTotal, setBudgetTotal] = useState(20);
    const [budgetPerMarket, setBudgetPerMarket] = useState(2);
    const [budgetPerDay, setBudgetPerDay] = useState(10);
    const [agentAddress, setAgentAddress] = useState<`0x${string}` | null>(null);
    const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // If the user is connected, advance past step 1 automatically
    useEffect(() => {
        if (isConnected && step === 1) setStep(2);
    }, [isConnected, step]);

    const filteredMarkets = useMemo(() => {
        const q = marketSearch.trim().toLowerCase();
        if (!q) return nativeMarkets.slice(0, 30);
        return nativeMarkets
            .filter(
                (m) =>
                    m.question.toLowerCase().includes(q) ||
                    m.category.toLowerCase().includes(q),
            )
            .slice(0, 30);
    }, [marketSearch, nativeMarkets]);

    async function handleSubmit() {
        if (!address) return;
        setSubmitting(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.put",
                userAddr: address,
                signMessageAsync,
            });
            const res = await fetch("/api/agent/profile", {
                method: "PUT",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({
                    userAddr: address,
                    pattern,
                    marketsMode,
                    categories: Array.from(pickedCats),
                    watchlist: Array.from(pickedMarkets),
                    budgetTotal,
                    budgetPerMarket,
                    budgetPerDay,
                    agentAddress,
                    sessionKeyAddress: sessionMeta?.sessionKeyAddress ?? null,
                    sessionValidUntil: sessionMeta?.sessionValidUntil ?? null,
                    sessionTotalCap: sessionMeta?.sessionTotalCap ?? null,
                    sessionPerCallCap: sessionMeta?.sessionPerCallCap ?? null,
                    active: true,
                }),
            });
            const data = (await res.json()) as { error?: string };
            if (!res.ok) {
                setError(data.error ?? `error: ${res.status}`);
                setSubmitting(false);
                return;
            }
            router.push(`/agent?u=${address}`);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "unknown error");
            setSubmitting(false);
        }
    }

    return (
        <div className="mx-auto max-w-[920px] px-6 py-10">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute mb-2 num">
                        / set up your agent
                    </div>
                    <h1 className="text-[26px] md:text-[32px] leading-tight tracking-tight font-medium">
                        Build a trader that runs while you sleep
                    </h1>
                </div>
                <StepIndicator current={step} />
            </div>

            {/* Phase banner — honest about current scope */}
            <div className="border border-edge/30 bg-edge/5 px-4 py-3 text-[12px] text-edge mb-6 flex items-start gap-3">
                <span className="num text-[10px] uppercase tracking-[0.22em] shrink-0 mt-0.5">
                    / preview
                </span>
                <span>
                    Phase 4 — your agent owns your USDC, you grant the runner
                    a scoped session key, and the runner trades for you
                    autonomously within those on-chain caps.
                </span>
            </div>

            {/* Step bodies */}
            {step === 1 && <Step1Connect connected={isConnected} />}

            {step === 2 && (
                <Step2Pattern
                    pattern={pattern}
                    onPick={setPattern}
                    onNext={() => setStep(3)}
                />
            )}

            {step === 3 && (
                <Step3Markets
                    mode={marketsMode}
                    onMode={setMarketsMode}
                    categories={categories}
                    pickedCats={pickedCats}
                    setPickedCats={setPickedCats}
                    nativeMarkets={filteredMarkets}
                    pickedMarkets={pickedMarkets}
                    setPickedMarkets={setPickedMarkets}
                    search={marketSearch}
                    setSearch={setMarketSearch}
                    onBack={() => setStep(2)}
                    onNext={() => setStep(4)}
                />
            )}

            {step === 4 && (
                <Step4Limits
                    budgetTotal={budgetTotal}
                    setBudgetTotal={setBudgetTotal}
                    budgetPerMarket={budgetPerMarket}
                    setBudgetPerMarket={setBudgetPerMarket}
                    budgetPerDay={budgetPerDay}
                    setBudgetPerDay={setBudgetPerDay}
                    pattern={pattern}
                    onBack={() => setStep(3)}
                    onNext={() => setStep(5)}
                />
            )}

            {step === 5 && (
                <Step5Deploy
                    userAddr={address}
                    agentAddress={agentAddress}
                    setAgentAddress={setAgentAddress}
                    onBack={() => setStep(4)}
                    onNext={() => setStep(6)}
                />
            )}

            {step === 6 && (
                <Step6Grant
                    agentAddress={agentAddress}
                    budgetTotal={budgetTotal}
                    budgetPerMarket={budgetPerMarket}
                    sessionMeta={sessionMeta}
                    setSessionMeta={setSessionMeta}
                    onBack={() => setStep(5)}
                    onNext={() => setStep(7)}
                />
            )}

            {step === 7 && (
                <Step7Review
                    pattern={pattern}
                    marketsMode={marketsMode}
                    pickedCats={pickedCats}
                    pickedMarkets={pickedMarkets}
                    budgetTotal={budgetTotal}
                    budgetPerMarket={budgetPerMarket}
                    budgetPerDay={budgetPerDay}
                    agentAddress={agentAddress}
                    sessionMeta={sessionMeta}
                    onBack={() => setStep(6)}
                    onSubmit={handleSubmit}
                    submitting={submitting}
                    error={error}
                />
            )}
        </div>
    );
}

// ── Step indicator ────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
    return (
        <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <div
                    key={n}
                    className={`w-7 h-1 ${
                        n <= current ? "bg-text" : "bg-border-strong"
                    }`}
                />
            ))}
        </div>
    );
}

// ── Step 1: Connect wallet ────────────────────────────────────────────────

function Step1Connect({ connected }: { connected: boolean }) {
    return (
        <section className="border border-border bg-bg-elev/30 px-6 py-10 text-center">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-3">
                / step 01
            </div>
            <h2 className="text-[20px] font-medium mb-3">
                Connect a wallet to begin
            </h2>
            <p className="text-[13px] text-text-dim max-w-[44ch] mx-auto mb-6">
                Your wallet address is the key to your agent profile. Use the
                connect button in the top-right of the page.
            </p>
            {!connected && (
                <span className="num text-[11px] uppercase tracking-[0.18em] text-text-faint">
                    waiting…
                </span>
            )}
        </section>
    );
}

// ── Step 2: Pick pattern ──────────────────────────────────────────────────

function Step2Pattern({
    pattern,
    onPick,
    onNext,
}: {
    pattern: PatternId;
    onPick: (p: PatternId) => void;
    onNext: () => void;
}) {
    return (
        <section>
            <div className="flex items-baseline justify-between mb-5">
                <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / step 02
                    </div>
                    <h2 className="text-[20px] font-medium mt-1">
                        Pick a trading pattern
                    </h2>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {PATTERN_LIST.map((p) => {
                    const selected = pattern === p.id;
                    return (
                        <button
                            key={p.id}
                            onClick={() => onPick(p.id)}
                            className={`text-left border px-5 py-5 transition-all ${
                                selected
                                    ? "border-accent bg-accent-bg"
                                    : "border-border bg-bg-elev/40 hover:border-border-strong hover:bg-bg-elev/70"
                            }`}
                        >
                            <div className="flex items-baseline justify-between gap-3 mb-2">
                                <span className="text-[15px] font-medium tracking-tight">
                                    {p.name}
                                </span>
                                <span className="num text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                    {cadenceLabel(p.cadenceMinutes)}
                                </span>
                            </div>
                            <p className="text-[12.5px] text-text-dim leading-snug mb-3">
                                {p.oneLiner}
                            </p>
                            <div className="flex gap-3 text-[10.5px] num text-text-faint">
                                <span>kelly {p.kellyMult.toFixed(2)}×</span>
                                <span>edge ≥ {(p.edgeThreshold * 100).toFixed(0)}pt</span>
                                {p.minConfidence > 0 && (
                                    <span>conf ≥ {Math.round(p.minConfidence * 100)}%</span>
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>

            <Nav onNext={onNext} />
        </section>
    );
}

// ── Step 3: Markets ───────────────────────────────────────────────────────

function Step3Markets({
    mode,
    onMode,
    categories,
    pickedCats,
    setPickedCats,
    nativeMarkets,
    pickedMarkets,
    setPickedMarkets,
    search,
    setSearch,
    onBack,
    onNext,
}: {
    mode: "all" | "categories" | "watchlist";
    onMode: (m: "all" | "categories" | "watchlist") => void;
    categories: Category[];
    pickedCats: Set<string>;
    setPickedCats: (s: Set<string>) => void;
    nativeMarkets: NativeMarketLite[];
    pickedMarkets: Set<string>;
    setPickedMarkets: (s: Set<string>) => void;
    search: string;
    setSearch: (s: string) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    function toggleCat(c: string) {
        const next = new Set(pickedCats);
        if (next.has(c)) next.delete(c);
        else next.add(c);
        setPickedCats(next);
    }
    function toggleMarket(addr: string) {
        const next = new Set(pickedMarkets);
        if (next.has(addr)) next.delete(addr);
        else next.add(addr);
        setPickedMarkets(next);
    }

    const valid =
        mode === "all" ||
        (mode === "categories" && pickedCats.size > 0) ||
        (mode === "watchlist" && pickedMarkets.size > 0);

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 03
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Which markets should it cover?
                </h2>
            </div>

            <div className="flex gap-2 mb-5">
                {(["all", "categories", "watchlist"] as const).map((m) => (
                    <button
                        key={m}
                        onClick={() => onMode(m)}
                        className={`px-4 py-2 text-[12px] border transition-colors ${
                            mode === m
                                ? "border-accent text-accent bg-accent-bg"
                                : "border-border text-text-dim hover:border-border-strong hover:text-text"
                        }`}
                    >
                        {m === "all"
                            ? "All markets"
                            : m === "categories"
                                ? "By category"
                                : "Watchlist"}
                    </button>
                ))}
            </div>

            {mode === "all" && (
                <div className="border border-border bg-bg-elev/30 px-5 py-6 text-[13px] text-text-dim">
                    The agent will consider every live market on the factory.
                    Trades will still respect your per-market budget cap.
                </div>
            )}

            {mode === "categories" && (
                <div className="flex flex-wrap gap-2">
                    {categories.map((c) => {
                        const sel = pickedCats.has(c.label);
                        return (
                            <button
                                key={c.label}
                                onClick={() => toggleCat(c.label)}
                                className={`px-3 py-1.5 text-[12px] border transition-colors num ${
                                    sel
                                        ? "border-accent text-accent bg-accent-bg"
                                        : "border-border text-text-dim hover:border-border-strong hover:text-text"
                                }`}
                            >
                                {c.label}
                                <span className="text-text-faint ml-2 tabular">
                                    {c.count}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            {mode === "watchlist" && (
                <div>
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="search markets…"
                        className="w-full px-3 py-2 text-[13px] bg-bg-elev border border-border focus:border-border-strong outline-none mb-3"
                    />
                    <div className="border border-border max-h-[380px] overflow-y-auto divide-y divide-border">
                        {nativeMarkets.map((m) => {
                            const sel = pickedMarkets.has(m.address);
                            return (
                                <button
                                    key={m.address}
                                    onClick={() => toggleMarket(m.address)}
                                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                                        sel
                                            ? "bg-accent-bg"
                                            : "hover:bg-bg-hover"
                                    }`}
                                >
                                    <span
                                        className={`w-3 h-3 border ${
                                            sel
                                                ? "border-accent bg-accent"
                                                : "border-border"
                                        }`}
                                    />
                                    <span className="text-[12.5px] text-text flex-1 truncate">
                                        {m.question}
                                    </span>
                                    <span className="num text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                        {m.category}
                                    </span>
                                </button>
                            );
                        })}
                        {nativeMarkets.length === 0 && (
                            <div className="px-4 py-6 text-center text-[12px] text-text-mute">
                                no matches
                            </div>
                        )}
                    </div>
                    <div className="text-[11px] text-text-mute mt-2 num">
                        {pickedMarkets.size} picked
                    </div>
                </div>
            )}

            <Nav onBack={onBack} onNext={onNext} disabled={!valid} />
        </section>
    );
}

// ── Step 4: Limits ────────────────────────────────────────────────────────

function Step4Limits({
    budgetTotal,
    setBudgetTotal,
    budgetPerMarket,
    setBudgetPerMarket,
    budgetPerDay,
    setBudgetPerDay,
    pattern,
    onBack,
    onNext,
}: {
    budgetTotal: number;
    setBudgetTotal: (n: number) => void;
    budgetPerMarket: number;
    setBudgetPerMarket: (n: number) => void;
    budgetPerDay: number;
    setBudgetPerDay: (n: number) => void;
    pattern: PatternId;
    onBack: () => void;
    onNext: () => void;
}) {
    const cadence =
        pattern === "custom" ? 30 : PATTERNS[pattern]?.cadenceMinutes ?? 30;
    const runsPerDay = Math.max(1, Math.floor(1440 / cadence));
    const valid = budgetTotal > 0 && budgetPerMarket > 0 && budgetPerDay > 0
        && budgetPerMarket <= budgetTotal;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 04
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Set spend limits
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[60ch]">
                    Hard caps the agent cannot cross. In Phase 1 these are
                    advisory; in Phase 3 they become on-chain enforced via
                    session-key permissions.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <BudgetField
                    label="Total budget"
                    sub="lifetime cap"
                    value={budgetTotal}
                    onChange={setBudgetTotal}
                />
                <BudgetField
                    label="Per market"
                    sub="single-market cap"
                    value={budgetPerMarket}
                    onChange={setBudgetPerMarket}
                />
                <BudgetField
                    label="Per day"
                    sub="daily spend cap"
                    value={budgetPerDay}
                    onChange={setBudgetPerDay}
                />
            </div>

            <div className="border border-border bg-bg-elev/30 px-5 py-4 text-[12.5px] text-text-dim">
                Cadence is set by the pattern:{" "}
                <span className="num text-text">{cadenceLabel(cadence)}</span>{" "}
                — roughly{" "}
                <span className="num text-text">{runsPerDay} runs/day</span>.
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!valid} />
        </section>
    );
}

function BudgetField({
    label,
    sub,
    value,
    onChange,
}: {
    label: string;
    sub: string;
    value: number;
    onChange: (n: number) => void;
}) {
    return (
        <label className="block border border-border bg-bg-elev/40 px-4 py-3">
            <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num block">
                {label}
            </span>
            <span className="text-[10px] text-text-faint lowercase block mb-2">
                {sub}
            </span>
            <div className="flex items-baseline gap-2">
                <span className="num text-[12px] text-text-mute">$</span>
                <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value) || 0)}
                    className="num text-[20px] bg-transparent border-0 outline-none w-full tabular text-text"
                />
                <span className="text-[10px] text-text-faint num">USDC</span>
            </div>
        </label>
    );
}

// ── Step 5: Deploy agent account ──────────────────────────────────────────

function Step5Deploy({
    userAddr,
    agentAddress,
    setAgentAddress,
    onBack,
    onNext,
}: {
    userAddr: `0x${string}` | undefined;
    agentAddress: `0x${string}` | null;
    setAgentAddress: (a: `0x${string}` | null) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    // Predict the CREATE2 address for this owner. Re-runs if userAddr changes.
    const { data: predicted } = useReadContract({
        address: ADDRESSES.agentFactory,
        abi: agentFactoryAbi,
        functionName: "predict",
        args: userAddr ? [userAddr] : undefined,
        query: { enabled: !!userAddr },
    });

    // Has it already been deployed for this owner?
    const { data: existing, refetch: refetchExisting } = useReadContract({
        address: ADDRESSES.agentFactory,
        abi: agentFactoryAbi,
        functionName: "accountOf",
        args: userAddr ? [userAddr] : undefined,
        query: { enabled: !!userAddr, refetchInterval: 4000 },
    });

    const alreadyDeployed =
        existing &&
        existing !== "0x0000000000000000000000000000000000000000";

    // Auto-record the address as soon as we know it (either from existing or
    // from the freshly-mined deploy tx).
    useEffect(() => {
        if (alreadyDeployed && existing) {
            setAgentAddress(existing as `0x${string}`);
        }
    }, [alreadyDeployed, existing, setAgentAddress]);

    const {
        writeContract,
        data: txHash,
        isPending: signing,
        error: writeError,
        reset: resetWrite,
    } = useWriteContract();

    const { isLoading: confirming, isSuccess: confirmed } =
        useWaitForTransactionReceipt({ hash: txHash });

    useEffect(() => {
        if (confirmed) {
            void refetchExisting();
        }
    }, [confirmed, refetchExisting]);

    function handleDeploy() {
        if (!userAddr) return;
        resetWrite();
        writeContract({
            address: ADDRESSES.agentFactory,
            abi: agentFactoryAbi,
            functionName: "deploy",
            args: [userAddr],
        });
    }

    const ready = !!agentAddress;
    const busy = signing || confirming;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 05
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Deploy your agent account
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[60ch]">
                    A smart account on Arc, owned by your wallet. Holds the USDC
                    your agent trades with — you can deposit, withdraw, and revoke
                    at any time. Address is deterministic, so it&apos;s the same
                    every time you visit.
                </p>
            </div>

            <div className="border border-border bg-bg-elev/40 px-5 py-5">
                <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-x-6 gap-y-3 text-[13px] items-baseline">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / owner
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {userAddr ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / agent
                    </span>
                    <span className="num text-text tabular break-all">
                        {predicted ? (predicted as string) : "computing…"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / status
                    </span>
                    <span className="text-[12.5px]">
                        {alreadyDeployed ? (
                            <span className="text-yes">
                                deployed · ready
                            </span>
                        ) : confirming ? (
                            <span className="text-edge">
                                confirming on Arc…
                            </span>
                        ) : signing ? (
                            <span className="text-edge">
                                waiting for signature…
                            </span>
                        ) : (
                            <span className="text-text-mute">
                                not yet deployed
                            </span>
                        )}
                    </span>
                </div>

                {!alreadyDeployed && (
                    <div className="mt-5 flex flex-col items-start gap-3">
                        <button
                            onClick={handleDeploy}
                            disabled={!userAddr || busy}
                            className="px-5 h-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                        >
                            {busy ? "deploying…" : "deploy now →"}
                        </button>
                        <p className="text-[11.5px] text-text-faint">
                            One transaction. Gas paid in USDC (Arc native gas) —
                            fractions of a cent.
                        </p>
                    </div>
                )}

                {writeError && (
                    <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                        {writeError.message.split("\n")[0]}
                    </div>
                )}
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
        </section>
    );
}

// ── Step 6: Grant session permission ─────────────────────────────────────

function Step6Grant({
    agentAddress,
    budgetTotal,
    budgetPerMarket,
    sessionMeta,
    setSessionMeta,
    onBack,
    onNext,
}: {
    agentAddress: `0x${string}` | null;
    budgetTotal: number;
    budgetPerMarket: number;
    sessionMeta: SessionMeta | null;
    setSessionMeta: (m: SessionMeta | null) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    const sessionAddr =
        (process.env.NEXT_PUBLIC_AGENT_SESSION_ADDRESS as `0x${string}` | undefined) ??
        null;

    const [durationDays, setDurationDays] = useState<7 | 30 | 90>(30);

    const {
        writeContract,
        data: txHash,
        isPending: signing,
        error: writeError,
        reset: resetWrite,
    } = useWriteContract();

    const { isLoading: confirming, isSuccess: confirmed } =
        useWaitForTransactionReceipt({ hash: txHash });

    // On successful tx, record the session metadata so the Review step + the
    // saved profile both reflect what's actually on-chain.
    useEffect(() => {
        if (confirmed && sessionAddr && !sessionMeta) {
            const validUntil = Math.floor(Date.now() / 1000) + durationDays * 86400;
            setSessionMeta({
                sessionKeyAddress: sessionAddr,
                sessionValidUntil: validUntil,
                sessionTotalCap: budgetTotal,
                sessionPerCallCap: budgetPerMarket,
            });
        }
    }, [
        confirmed,
        sessionAddr,
        sessionMeta,
        durationDays,
        budgetTotal,
        budgetPerMarket,
        setSessionMeta,
    ]);

    function handleGrant() {
        if (!agentAddress || !sessionAddr) return;
        resetWrite();
        const validUntil = BigInt(
            Math.floor(Date.now() / 1000) + durationDays * 86400,
        );
        writeContract({
            address: agentAddress,
            abi: agentAccountAbi,
            functionName: "grantSession",
            args: [
                sessionAddr,
                validUntil,
                parseUnits(budgetTotal.toString(), 6),
                parseUnits(budgetPerMarket.toString(), 6),
                ZERO_ADDRESS,        // allowedTarget: any market
                BUY_SELECTOR,        // allowedSelector: buy() only
            ],
        });
    }

    const busy = signing || confirming;
    const ready = sessionMeta !== null;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 06
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Grant the agent permission
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[62ch]">
                    Authorise the off-chain runner to call <span className="num text-text">buy()</span>{" "}
                    on your behalf, bounded by hard on-chain caps. The runner
                    can never withdraw your USDC, never call anything other
                    than buy, and never spend more than your caps allow.
                    Revoke anytime in settings.
                </p>
            </div>

            <div className="border border-border bg-bg-elev/40 px-5 py-5">
                <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-6 gap-y-3 text-[13px] items-baseline mb-5">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / runner key
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {sessionAddr ?? (
                            <span className="text-no">
                                NEXT_PUBLIC_AGENT_SESSION_ADDRESS not set
                            </span>
                        )}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / agent
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {agentAddress ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / allowed call
                    </span>
                    <span className="num text-text-dim">
                        buy(uint8,uint256,uint256) · on any market
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / spend caps
                    </span>
                    <span className="num text-text-dim tabular">
                        ${budgetTotal.toFixed(2)} lifetime · $
                        {budgetPerMarket.toFixed(2)} per call
                    </span>
                </div>

                <div className="mb-5">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                        / valid for
                    </div>
                    <div className="flex gap-2">
                        {([7, 30, 90] as const).map((d) => (
                            <button
                                key={d}
                                onClick={() => setDurationDays(d)}
                                disabled={busy}
                                className={`px-4 py-2 text-[12px] border transition-colors num disabled:opacity-50 ${
                                    durationDays === d
                                        ? "border-accent text-accent bg-accent-bg"
                                        : "border-border text-text-dim hover:border-border-strong hover:text-text"
                                }`}
                            >
                                {d} days
                            </button>
                        ))}
                    </div>
                </div>

                <div className="border-t border-border pt-4">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                        / status
                    </div>
                    {sessionMeta ? (
                        <div className="text-[12.5px] text-yes">
                            granted · session expires{" "}
                            <span className="num tabular">
                                {new Date(
                                    sessionMeta.sessionValidUntil * 1000,
                                )
                                    .toISOString()
                                    .slice(0, 16)
                                    .replace("T", " ")}{" "}
                                UTC
                            </span>
                        </div>
                    ) : confirming ? (
                        <div className="text-[12.5px] text-edge">
                            confirming on Arc…
                        </div>
                    ) : signing ? (
                        <div className="text-[12.5px] text-edge">
                            waiting for signature…
                        </div>
                    ) : (
                        <div className="text-[12.5px] text-text-mute">
                            not yet granted
                        </div>
                    )}
                </div>

                {!sessionMeta && (
                    <div className="mt-5 flex flex-col items-start gap-3">
                        <button
                            onClick={handleGrant}
                            disabled={!agentAddress || !sessionAddr || busy}
                            className="px-5 h-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                        >
                            {busy ? "granting…" : "grant permission →"}
                        </button>
                        <p className="text-[11.5px] text-text-faint">
                            One transaction. The session limits are enforced
                            by the AgentAccount contract — even a compromised
                            runner cannot exceed them.
                        </p>
                    </div>
                )}

                {writeError && (
                    <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                        {writeError.message.split("\n")[0]}
                    </div>
                )}
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
        </section>
    );
}

// ── Step 7: Review ────────────────────────────────────────────────────────

function Step7Review({
    pattern,
    marketsMode,
    pickedCats,
    pickedMarkets,
    budgetTotal,
    budgetPerMarket,
    budgetPerDay,
    agentAddress,
    sessionMeta,
    onBack,
    onSubmit,
    submitting,
    error,
}: {
    pattern: PatternId;
    marketsMode: "all" | "categories" | "watchlist";
    pickedCats: Set<string>;
    pickedMarkets: Set<string>;
    budgetTotal: number;
    budgetPerMarket: number;
    budgetPerDay: number;
    agentAddress: `0x${string}` | null;
    sessionMeta: SessionMeta | null;
    onBack: () => void;
    onSubmit: () => void;
    submitting: boolean;
    error: string | null;
}) {
    const p = pattern === "custom" ? null : PATTERNS[pattern];
    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 07
                </div>
                <h2 className="text-[20px] font-medium mt-1">Confirm</h2>
            </div>

            <dl className="grid grid-cols-[160px_1fr] gap-y-3 gap-x-6 border border-border bg-bg-elev/30 px-5 py-5 text-[13px]">
                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    pattern
                </dt>
                <dd className="text-text">
                    {p?.name ?? "Custom"}
                    {p && (
                        <span className="text-text-mute ml-2 text-[11.5px]">
                            · {p.oneLiner}
                        </span>
                    )}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    markets
                </dt>
                <dd className="text-text-dim">
                    {marketsMode === "all"
                        ? "All live markets"
                        : marketsMode === "categories"
                            ? `${pickedCats.size} categories: ${Array.from(pickedCats).join(", ")}`
                            : `${pickedMarkets.size} hand-picked`}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    budget total
                </dt>
                <dd className="num text-text tabular">${budgetTotal.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    per market
                </dt>
                <dd className="num text-text tabular">${budgetPerMarket.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    per day
                </dt>
                <dd className="num text-text tabular">${budgetPerDay.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    agent account
                </dt>
                <dd className="num text-text-dim tabular break-all text-[11.5px]">
                    {agentAddress ? (
                        <a
                            href={`https://testnet.arcscan.app/address/${agentAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-text transition-colors"
                        >
                            {shortAddr(agentAddress, 8)}
                        </a>
                    ) : (
                        <span className="text-text-faint">—</span>
                    )}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    session
                </dt>
                <dd className="text-[11.5px]">
                    {sessionMeta ? (
                        <span className="text-yes">
                            granted ·{" "}
                            <span className="num text-text-dim">
                                ${sessionMeta.sessionTotalCap.toFixed(2)} cap ·
                                expires{" "}
                                {new Date(
                                    sessionMeta.sessionValidUntil * 1000,
                                )
                                    .toISOString()
                                    .slice(0, 10)}
                            </span>
                        </span>
                    ) : (
                        <span className="text-text-faint">—</span>
                    )}
                </dd>
            </dl>

            {error && (
                <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                    {error}
                </div>
            )}

            <Nav
                onBack={onBack}
                primary={{
                    label: submitting ? "saving…" : "Activate agent",
                    onClick: onSubmit,
                    disabled: submitting,
                }}
            />
        </section>
    );
}

// ── Nav row ───────────────────────────────────────────────────────────────

function Nav({
    onBack,
    onNext,
    disabled,
    primary,
}: {
    onBack?: () => void;
    onNext?: () => void;
    disabled?: boolean;
    primary?: { label: string; onClick: () => void; disabled?: boolean };
}) {
    return (
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
            {onBack ? (
                <button
                    onClick={onBack}
                    className="text-[12px] text-text-mute hover:text-text transition-colors"
                >
                    ← back
                </button>
            ) : (
                <Link
                    href="/agent"
                    className="text-[12px] text-text-mute hover:text-text transition-colors"
                >
                    ← cancel
                </Link>
            )}
            {primary ? (
                <button
                    onClick={primary.onClick}
                    disabled={primary.disabled}
                    className="px-5 h-9 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                >
                    {primary.label} →
                </button>
            ) : (
                <button
                    onClick={onNext}
                    disabled={disabled}
                    className="px-5 h-9 border border-border-strong text-text text-[12.5px] uppercase tracking-[0.18em] hover:bg-bg-hover disabled:opacity-40 transition-colors num"
                >
                    continue →
                </button>
            )}
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function cadenceLabel(mins: number): string {
    if (mins < 60) return `every ${mins}m`;
    if (mins < 1440) return `every ${Math.round(mins / 60)}h`;
    return "daily";
}
