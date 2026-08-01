"use client";

/**
 * Manual settlement for admin-authored markets.
 *
 * Signing model matches the other admin actions (client-side wagmi, no server
 * key) — but with a wrinkle: on the v2 factory `resolveMarket` is `onlyResolver`,
 * and the resolver is a DIFFERENT address from the admin you log in with. So the
 * panel checks the connected account per row and tells you which wallet to
 * switch to rather than letting you burn gas on a `NotResolver` revert.
 * Legacy v1 markets have no resolver role — the admin settles those.
 *
 * Fast markets are excluded on the server: they are settled automatically by
 * fast-market-keeper, and hand-settling one would fight the keeper.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    useAccount,
    useChainId,
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { type Address } from "viem";
import Link from "next/link";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, factoryAbi, Outcome } from "@/lib/contracts";

export type ResolvableRow = {
    address: Address;
    question: string;
    category: string;
    /** Unix seconds. Always in the past for rows in `awaiting`. */
    deadline: number;
    legacy: boolean;
    /** YES probability 0..1 at the deadline — a hint, never a decision. */
    yesProb: number;
    liquidityUsd: number;
};

export type ResolvedRow = ResolvableRow & { outcome: number };

type Props = {
    awaiting: ResolvableRow[];
    resolved: ResolvedRow[];
    /** v2 settlement key, read on-chain. */
    resolverAddress: Address | null;
    /** Factory admin — settles legacy v1 markets. */
    adminAddress: Address | null;
};

const OUTCOME_LABEL: Record<number, string> = {
    [Outcome.Yes]: "YES",
    [Outcome.No]: "NO",
    [Outcome.Cancelled]: "CANCELLED",
};

function ago(deadlineSec: number): string {
    const s = Math.floor(Date.now() / 1000) - deadlineSec;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

export function ResolutionPanel({ awaiting, resolved, resolverAddress, adminAddress }: Props) {
    return (
        <section className="mt-8 border border-border bg-bg-elev rounded-[2px] overflow-hidden">
            <header className="border-b border-border px-5 py-3 flex items-baseline justify-between gap-4 flex-wrap">
                <div className="flex items-baseline gap-3">
                    <span className="section-number text-[11px] tabular">04</span>
                    <h2 className="text-[12px] uppercase tracking-[0.24em] text-text-dim">
                        manual resolution
                    </h2>
                </div>
                <span className="num text-[11px] text-text-faint">
                    {awaiting.length} awaiting · {resolved.length} settled · fast markets excluded
                </span>
            </header>

            <div className="px-5 py-4 border-b border-border">
                <p className="text-[12px] text-text-mute leading-relaxed">
                    Settlement is <span className="text-text-dim">irreversible</span> and pays out every
                    holder at $1.00 per winning share. Cancelling refunds instead. Only markets past
                    their deadline can be settled — the contract rejects the rest.
                </p>
                <SignerNote resolverAddress={resolverAddress} adminAddress={adminAddress} />
            </div>

            {awaiting.length === 0 ? (
                <div className="px-5 py-10 text-center">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-1">
                        nothing awaiting settlement
                    </div>
                    <p className="text-[12px] text-text-dim">
                        Every non-fast market is either still open or already settled.
                    </p>
                </div>
            ) : (
                <div className="divide-y divide-border">
                    {awaiting.map((row) => (
                        <ResolveRow
                            key={row.address}
                            row={row}
                            resolverAddress={resolverAddress}
                            adminAddress={adminAddress}
                        />
                    ))}
                </div>
            )}

            {resolved.length > 0 && (
                <details className="border-t border-border">
                    <summary className="px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-text-mute cursor-pointer hover:text-text-dim">
                        settled history ({resolved.length})
                    </summary>
                    <div className="divide-y divide-border border-t border-border">
                        {resolved.map((row) => (
                            <div key={row.address} className="px-5 py-3 flex items-center gap-4">
                                <div className="flex-1 min-w-0">
                                    <Link
                                        href={`/markets/${row.address}`}
                                        className="text-[13px] text-text-dim hover:text-text truncate block"
                                    >
                                        {row.question}
                                    </Link>
                                    <span className="num text-[10px] text-text-faint">
                                        {row.category} · {ago(row.deadline)}
                                        {row.legacy ? " · legacy" : ""}
                                    </span>
                                </div>
                                <span
                                    className={`num text-[11px] uppercase tracking-[0.16em] shrink-0 ${
                                        row.outcome === Outcome.Yes
                                            ? "text-yes"
                                            : row.outcome === Outcome.No
                                              ? "text-no"
                                              : "text-text-mute"
                                    }`}
                                >
                                    {OUTCOME_LABEL[row.outcome] ?? "—"}
                                </span>
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </section>
    );
}

function SignerNote({
    resolverAddress,
    adminAddress,
}: {
    resolverAddress: Address | null;
    adminAddress: Address | null;
}) {
    const { address } = useAccount();
    const connected = address?.toLowerCase();
    const isResolver = !!connected && connected === resolverAddress?.toLowerCase();
    const isAdmin = !!connected && connected === adminAddress?.toLowerCase();

    return (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 num text-[10.5px] text-text-faint">
            <span>
                connected{" "}
                <span className={isResolver || isAdmin ? "text-text-dim" : "text-warn"}>
                    {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"}
                </span>
            </span>
            <span>
                resolver (v2){" "}
                <span className={isResolver ? "text-yes" : "text-text-mute"}>
                    {resolverAddress ? `${resolverAddress.slice(0, 6)}…${resolverAddress.slice(-4)}` : "?"}
                </span>
            </span>
            <span>
                admin (v1){" "}
                <span className={isAdmin ? "text-yes" : "text-text-mute"}>
                    {adminAddress ? `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}` : "?"}
                </span>
            </span>
        </div>
    );
}

function ResolveRow({
    row,
    resolverAddress,
    adminAddress,
}: {
    row: ResolvableRow;
    resolverAddress: Address | null;
    adminAddress: Address | null;
}) {
    const router = useRouter();
    const { address } = useAccount();
    const chainId = useChainId();
    const onArc = chainId === arcTestnet.id;
    const { switchChain } = useSwitchChain();

    // Two-step: pick an outcome, then confirm. Settlement can't be undone, so a
    // single stray click must not be able to settle a market.
    const [armed, setArmed] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { writeContractAsync, data: hash, isPending } = useWriteContract();
    const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
        hash,
        query: { enabled: !!hash },
    });

    // v1 has no resolver role — its admin settles. v2 requires the resolver.
    const required = row.legacy ? adminAddress : resolverAddress;
    const canSign = !!address && !!required && address.toLowerCase() === required.toLowerCase();
    const busy = isPending || confirming;

    async function resolve(outcome: number) {
        setError(null);
        if (!onArc) {
            switchChain?.({ chainId: arcTestnet.id });
            return;
        }
        try {
            await writeContractAsync({
                address: row.legacy ? ADDRESSES.factoryLegacy : ADDRESSES.factory,
                abi: factoryAbi,
                functionName: "resolveMarket",
                args: [row.address, outcome],
            });
            setArmed(null);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message.split("\n")[0].slice(0, 140) : "failed");
            setArmed(null);
        }
    }

    if (isSuccess) {
        return (
            <div className="px-5 py-4 flex items-center gap-3">
                <span className="text-[13px] text-text-dim truncate flex-1">{row.question}</span>
                <span className="num text-[11px] uppercase tracking-[0.16em] text-yes shrink-0">
                    settled ✓
                </span>
            </div>
        );
    }

    return (
        <div className="px-5 py-4">
            <div className="flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                    <Link
                        href={`/markets/${row.address}`}
                        className="text-[13.5px] text-text hover:text-accent leading-snug block"
                    >
                        {row.question}
                    </Link>
                    <div className="num text-[10.5px] text-text-faint mt-1 flex flex-wrap gap-x-3">
                        <span>{row.category}</span>
                        <span>closed {ago(row.deadline)}</span>
                        <span>${row.liquidityUsd.toFixed(2)} liq</span>
                        <span>
                            last {Math.round(row.yesProb * 100)}¢ YES
                        </span>
                        {row.legacy && <span className="text-warn">legacy v1</span>}
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {armed === null ? (
                        <>
                            <OutcomeButton label="YES" tone="yes" disabled={busy} onClick={() => setArmed(Outcome.Yes)} />
                            <OutcomeButton label="NO" tone="no" disabled={busy} onClick={() => setArmed(Outcome.No)} />
                            <OutcomeButton label="CANCEL" tone="mute" disabled={busy} onClick={() => setArmed(Outcome.Cancelled)} />
                        </>
                    ) : (
                        <>
                            <span className="num text-[11px] text-text-mute">
                                settle as{" "}
                                <span className="text-text">{OUTCOME_LABEL[armed]}</span>?
                            </span>
                            <button
                                type="button"
                                onClick={() => resolve(armed)}
                                disabled={busy || !canSign}
                                className="num text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 border border-yes/50 text-yes hover:bg-yes/10 disabled:opacity-40 disabled:hover:bg-transparent rounded-[2px] transition-colors"
                            >
                                {busy ? "confirming…" : !onArc ? "switch network" : "confirm"}
                            </button>
                            <button
                                type="button"
                                onClick={() => setArmed(null)}
                                disabled={busy}
                                className="num text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 border border-border text-text-mute hover:text-text rounded-[2px] transition-colors"
                            >
                                back
                            </button>
                        </>
                    )}
                </div>
            </div>

            {armed !== null && !canSign && (
                <p className="num text-[10.5px] text-warn mt-2">
                    Connect{" "}
                    {required ? `${required.slice(0, 6)}…${required.slice(-4)}` : "the settlement wallet"}{" "}
                    to settle this {row.legacy ? "legacy" : "v2"} market — the connected account isn&apos;t
                    authorised and the transaction would revert.
                </p>
            )}
            {error && <p className="num text-[10.5px] text-no mt-2">{error}</p>}
        </div>
    );
}

function OutcomeButton({
    label,
    tone,
    disabled,
    onClick,
}: {
    label: string;
    tone: "yes" | "no" | "mute";
    disabled: boolean;
    onClick: () => void;
}) {
    const cls =
        tone === "yes"
            ? "border-yes/40 text-yes hover:bg-yes/10"
            : tone === "no"
              ? "border-no/40 text-no hover:bg-no/10"
              : "border-border text-text-mute hover:text-text";
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`num text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 border rounded-[2px] transition-colors disabled:opacity-40 ${cls}`}
        >
            {label}
        </button>
    );
}
