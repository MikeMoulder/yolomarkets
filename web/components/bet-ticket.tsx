"use client";

import { useEffect, useMemo, useState } from "react";
import {
    useAccount,
    useReadContract,
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { type Address } from "viem";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi, marketAbi, Outcome } from "@/lib/contracts";
import { formatCents, formatProb, formatUsdc, priceToProb } from "@/lib/format";

const SLIPPAGE_BPS = 200; // 2% — generous; will tighten in v2

export function BetTicket({
    market,
    initialPriceYes,
    resolved,
}: {
    market: Address;
    initialPriceYes: bigint;
    resolved: boolean;
}) {
    const { address, chainId, isConnected } = useAccount();
    const { switchChain } = useSwitchChain();

    const [side, setSide] = useState<Outcome>(Outcome.Yes);
    const [amountStr, setAmountStr] = useState("5"); // USDC user is willing to spend
    const [hash, setHash] = useState<`0x${string}` | undefined>();
    const [pendingStage, setPendingStage] = useState<"idle" | "approving" | "buying">(
        "idle",
    );

    // Parse the amount user typed; clamp non-negative
    const amountWei = useMemo(() => {
        const f = Number.parseFloat(amountStr);
        if (!Number.isFinite(f) || f <= 0) return 0n;
        return BigInt(Math.round(f * 1e6));
    }, [amountStr]);

    // Live price (refetched periodically so the preview stays honest)
    const { data: priceYesRaw } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "priceYes",
        query: { refetchInterval: 8_000, initialData: initialPriceYes },
    });
    const pYes = priceToProb(priceYesRaw ?? initialPriceYes);
    const price = side === Outcome.Yes ? pYes : 1 - pYes;

    // Estimate shares the user gets for `amountWei` at current price.
    // Approximation: shares ≈ amount / price. We then ask the contract for the
    // exact cost via previewBuy(side, shares) — that's authoritative.
    const sharesGuess = useMemo(() => {
        if (price <= 0 || amountWei === 0n) return 0n;
        return BigInt(Math.floor(Number(amountWei) / price));
    }, [amountWei, price]);

    const { data: previewCost } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "previewBuy",
        args: sharesGuess > 0n ? [side, sharesGuess] : undefined,
        query: { enabled: sharesGuess > 0n, refetchInterval: 8_000 },
    });

    const maxCost = previewCost
        ? (previewCost * BigInt(10_000 + SLIPPAGE_BPS)) / 10_000n
        : 0n;

    // Existing allowance
    const { data: allowance, refetch: refetchAllowance } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: address ? [address, market] : undefined,
        query: { enabled: !!address },
    });

    const needsApproval =
        !!previewCost && (allowance === undefined || allowance < maxCost);

    const { writeContractAsync, isPending: writing } = useWriteContract();
    const { isLoading: confirming, isSuccess: confirmed } = useWaitForTransactionReceipt(
        { hash, query: { enabled: !!hash } },
    );

    // After a successful confirm, refresh allowance + reset stage
    useEffect(() => {
        if (confirmed) {
            refetchAllowance();
            setPendingStage("idle");
            setHash(undefined);
        }
    }, [confirmed, refetchAllowance]);

    const wrongChain = isConnected && chainId !== arcTestnet.id;
    const busy = writing || confirming || pendingStage !== "idle";

    if (resolved) {
        return (
            <Panel title="Trade">
                <div className="px-5 py-8 text-center text-[13px] text-text-mute">
                    market resolved · trading closed
                </div>
            </Panel>
        );
    }

    async function onApprove() {
        if (!previewCost) return;
        setPendingStage("approving");
        try {
            const h = await writeContractAsync({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [market, maxCost],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    async function onBuy() {
        if (!previewCost || sharesGuess === 0n) return;
        setPendingStage("buying");
        try {
            const h = await writeContractAsync({
                address: market,
                abi: marketAbi,
                functionName: "buy",
                args: [side, sharesGuess, maxCost],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    return (
        <Panel title="Trade">
            <div className="px-5 py-5 space-y-5">
                {/* Side toggle */}
                <div className="grid grid-cols-2 gap-1.5">
                    <SideButton
                        active={side === Outcome.Yes}
                        accent="yes"
                        label="YES"
                        sub={formatCents(pYes)}
                        onClick={() => setSide(Outcome.Yes)}
                    />
                    <SideButton
                        active={side === Outcome.No}
                        accent="no"
                        label="NO"
                        sub={formatCents(1 - pYes)}
                        onClick={() => setSide(Outcome.No)}
                    />
                </div>

                {/* Amount input */}
                <label className="block">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                        <span>amount</span>
                        <span>USDC</span>
                    </div>
                    <input
                        type="number"
                        step="0.5"
                        min="0"
                        inputMode="decimal"
                        value={amountStr}
                        onChange={(e) => setAmountStr(e.target.value)}
                        className="num w-full bg-bg-elev-2 border border-border focus:border-border-bright px-4 py-3 text-[22px] tabular text-text outline-none transition-colors"
                    />
                    <div className="flex gap-1 mt-2">
                        {[1, 5, 25, 100].map((v) => (
                            <button
                                key={v}
                                onClick={() => setAmountStr(v.toString())}
                                className="num text-[11px] px-2 py-1 border border-border text-text-dim hover:text-text hover:border-border-strong transition-colors"
                            >
                                ${v}
                            </button>
                        ))}
                    </div>
                </label>

                {/* Preview */}
                <div className="border border-border bg-bg-elev px-4 py-3 space-y-1.5">
                    <RowKV
                        k="shares"
                        v={
                            previewCost
                                ? `${formatUsdc(sharesGuess)} ${side === Outcome.Yes ? "YES" : "NO"}`
                                : "—"
                        }
                    />
                    <RowKV
                        k="estimated cost"
                        v={previewCost ? `$${formatUsdc(previewCost)}` : "—"}
                    />
                    <RowKV k="max cost (slippage)" v={maxCost ? `$${formatUsdc(maxCost)}` : "—"} />
                    <RowKV
                        k="implied probability"
                        v={previewCost && sharesGuess > 0n
                            ? formatProb(Number(previewCost) / Number(sharesGuess))
                            : "—"}
                    />
                </div>

                {/* Action */}
                {!isConnected ? (
                    <ActionDisabled label="connect wallet to bet" />
                ) : wrongChain ? (
                    <button
                        onClick={() => switchChain({ chainId: arcTestnet.id })}
                        className="w-full h-11 border border-warn/40 bg-warn/10 text-warn text-[13px] hover:bg-warn/20 transition-colors"
                    >
                        switch to Arc to bet
                    </button>
                ) : amountWei === 0n ? (
                    <ActionDisabled label="enter an amount" />
                ) : !previewCost ? (
                    <ActionDisabled label="calculating…" />
                ) : needsApproval ? (
                    <button
                        onClick={onApprove}
                        disabled={busy}
                        className="w-full h-11 border border-border-bright bg-text text-bg text-[13px] font-medium disabled:opacity-50 transition-opacity"
                    >
                        {pendingStage === "approving"
                            ? confirming
                                ? "confirming approval…"
                                : "approving…"
                            : "approve USDC"}
                    </button>
                ) : (
                    <button
                        onClick={onBuy}
                        disabled={busy}
                        className={`w-full h-11 text-[13px] font-medium transition-opacity disabled:opacity-50 ${
                            side === Outcome.Yes
                                ? "bg-yes text-bg hover:bg-yes-dim"
                                : "bg-no text-bg hover:bg-no-dim"
                        }`}
                    >
                        {pendingStage === "buying"
                            ? confirming
                                ? "confirming buy…"
                                : "buying…"
                            : `buy ${side === Outcome.Yes ? "YES" : "NO"}`}
                    </button>
                )}

                {confirmed && hash && (
                    <div className="text-[11px] text-yes border border-yes/30 bg-yes/5 px-3 py-2">
                        confirmed ·{" "}
                        <a
                            className="num underline-offset-2 hover:underline"
                            href={`https://testnet.arcscan.app/tx/${hash}`}
                            target="_blank"
                            rel="noreferrer"
                        >
                            {hash.slice(0, 14)}…
                        </a>
                    </div>
                )}
            </div>
        </Panel>
    );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="border border-border bg-bg-elev/40">
            <div className="border-b border-border px-5 py-2.5">
                <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                    / {title.toLowerCase()}
                </h3>
            </div>
            {children}
        </section>
    );
}

function SideButton({
    active,
    accent,
    label,
    sub,
    onClick,
}: {
    active: boolean;
    accent: "yes" | "no";
    label: string;
    sub: string;
    onClick: () => void;
}) {
    const accentBorder = accent === "yes" ? "border-yes" : "border-no";
    const accentText = accent === "yes" ? "text-yes" : "text-no";
    return (
        <button
            onClick={onClick}
            className={`px-3 py-3 border transition-colors ${
                active
                    ? `${accentBorder} bg-bg-elev-2`
                    : "border-border hover:border-border-strong"
            }`}
        >
            <div className="flex items-baseline justify-between">
                <span
                    className={`text-[13px] font-medium tracking-tight ${
                        active ? accentText : "text-text-dim"
                    }`}
                >
                    {label}
                </span>
                <span className={`num text-[12px] tabular ${active ? accentText : "text-text-mute"}`}>
                    {sub}
                </span>
            </div>
        </button>
    );
}

function RowKV({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-text-mute">{k}</span>
            <span className="num text-text-dim tabular">{v}</span>
        </div>
    );
}

function ActionDisabled({ label }: { label: string }) {
    return (
        <button
            disabled
            className="w-full h-11 border border-border bg-bg-elev text-[13px] text-text-mute"
        >
            {label}
        </button>
    );
}
