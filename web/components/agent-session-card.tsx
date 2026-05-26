"use client";

import {
    useReadContract,
    useWriteContract,
    useWaitForTransactionReceipt,
} from "wagmi";
import { agentAccountAbi } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";

const PRICE_18 = 1n; // unused, kept to silence import warning if needed
void PRICE_18;

/** Live session-status card on /agent/settings. Reads the on-chain
 *  permission, shows cap usage, expiry countdown, and a revoke button. */
export function AgentSessionCard({
    agentAddress,
    sessionKeyAddress,
}: {
    agentAddress: `0x${string}`;
    sessionKeyAddress: `0x${string}`;
}) {
    const { data: sess, refetch } = useReadContract({
        address: agentAddress,
        abi: agentAccountAbi,
        functionName: "sessions",
        args: [sessionKeyAddress],
        query: { refetchInterval: 8000 },
    });

    const {
        writeContract,
        data: txHash,
        isPending,
        error,
        reset,
    } = useWriteContract();
    const { isLoading: confirming, isSuccess } =
        useWaitForTransactionReceipt({ hash: txHash });

    if (isSuccess) {
        setTimeout(() => void refetch(), 300);
        // Note: the parent settings page also polls profile; revoking here
        // doesn't clear the profile's sessionKeyAddress until the user
        // re-runs the wizard. Phase 4 will reconcile via the runner.
    }

    if (!sess) {
        return (
            <div className="border border-border bg-bg-elev/30 px-5 py-4 text-[12px] text-text-mute num">
                loading session…
            </div>
        );
    }

    const [validUntil, totalCap, totalSpent, perCallCap, allowedTarget, allowedSelector] =
        sess as [bigint, bigint, bigint, bigint, `0x${string}`, `0x${string}`];

    const now = Math.floor(Date.now() / 1000);
    const live = validUntil > 0n && now <= Number(validUntil);
    const expired = validUntil > 0n && now > Number(validUntil);
    const pctSpent =
        totalCap > 0n ? Number((totalSpent * 1000n) / totalCap) / 10 : 0;

    function handleRevoke() {
        reset();
        writeContract({
            address: agentAddress,
            abi: agentAccountAbi,
            functionName: "revokeSession",
            args: [sessionKeyAddress],
        });
    }

    const accent = live
        ? "border-yes/25 bg-yes/[0.03]"
        : expired
            ? "border-edge/25 bg-edge/[0.03]"
            : "border-border bg-bg-elev/30";

    return (
        <div className={`border ${accent} px-5 py-5`}>
            <div className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                    <div
                        className={`text-[10px] uppercase tracking-[0.22em] num ${
                            live
                                ? "text-yes"
                                : expired
                                    ? "text-edge"
                                    : "text-text-mute"
                        }`}
                    >
                        / session ·{" "}
                        {live ? "active" : expired ? "expired" : "none"}
                    </div>
                    <div className="num text-[12px] text-text-dim mt-1 break-all">
                        runner key {shortAddr(sessionKeyAddress, 6)}
                    </div>
                </div>
                {validUntil > 0n && (
                    <button
                        onClick={handleRevoke}
                        disabled={isPending || confirming}
                        className="px-3 h-8 border border-no/40 text-no text-[11px] uppercase tracking-[0.18em] num hover:bg-no/10 disabled:opacity-50 transition-colors"
                    >
                        {isPending || confirming ? "revoking…" : "revoke"}
                    </button>
                )}
            </div>

            {validUntil > 0n && (
                <>
                    {/* Spend gauge */}
                    <div className="mb-3">
                        <div className="flex items-baseline justify-between mb-1.5">
                            <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                                spend
                            </span>
                            <span className="num text-[11.5px] tabular text-text-dim">
                                ${formatUsdc(totalSpent)} / ${formatUsdc(totalCap)}
                                <span className="text-text-faint ml-2">
                                    {pctSpent.toFixed(1)}%
                                </span>
                            </span>
                        </div>
                        <div className="prob-bar">
                            <div
                                className="yes-fill"
                                style={{ width: `${Math.min(100, pctSpent)}%` }}
                            />
                        </div>
                    </div>

                    {/* Meta grid */}
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11.5px] pt-3 border-t border-border">
                        <Row k="per call" v={`$${formatUsdc(perCallCap)}`} />
                        <Row
                            k="expires"
                            v={
                                expired
                                    ? "expired"
                                    : `in ${formatTimeUntil(Number(validUntil))}`
                            }
                        />
                        <Row
                            k="allowed target"
                            v={
                                allowedTarget ===
                                "0x0000000000000000000000000000000000000000"
                                    ? "any market"
                                    : shortAddr(allowedTarget, 6)
                            }
                        />
                        <Row
                            k="allowed call"
                            v={
                                allowedSelector === "0x00000000"
                                    ? "any"
                                    : `${allowedSelector} (buy)`
                            }
                        />
                    </div>
                </>
            )}

            {error && (
                <div className="mt-3 border border-no/30 bg-no/5 px-3 py-2 text-[11.5px] text-no">
                    {error.message.split("\n")[0]}
                </div>
            )}
        </div>
    );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-text-mute num">
                {k}
            </span>
            <span className="num text-text-dim tabular text-right">{v}</span>
        </div>
    );
}

function formatTimeUntil(unixSeconds: number): string {
    const delta = unixSeconds - Math.floor(Date.now() / 1000);
    if (delta <= 0) return "—";
    const days = Math.floor(delta / 86400);
    if (days >= 2) return `${days}d`;
    const hours = Math.floor(delta / 3600);
    if (hours >= 2) return `${hours}h`;
    const minutes = Math.floor(delta / 60);
    return `${minutes}m`;
}
