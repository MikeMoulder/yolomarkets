"use client";

import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi, Outcome } from "@/lib/contracts";
import {
    formatCents,
    formatUsdc,
    priceToProb,
    shortAddr,
} from "@/lib/format";

type Row = {
    address: Address;
    question: string;
    priceYes: bigint;
    resolved: boolean;
    outcome: Outcome;
    sharesYes: bigint;
    sharesNo: bigint;
};

export function PortfolioClient() {
    const { address, isConnected } = useAccount();

    // 1. List of markets from factory
    const { data: marketAddrs } = useReadContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    });

    // 2. USDC balance (header already shows it but list it once more here)
    const { data: usdc } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 15_000 },
    });

    // 3. For each market: question, priceYes, resolved, outcome, sharesYes(me), sharesNo(me)
    const calls = (marketAddrs ?? []).flatMap((m) => [
        { address: m, abi: marketAbi, functionName: "question" } as const,
        { address: m, abi: marketAbi, functionName: "priceYes" } as const,
        { address: m, abi: marketAbi, functionName: "resolved" } as const,
        { address: m, abi: marketAbi, functionName: "outcome" } as const,
        ...(address
            ? [
                  {
                      address: m,
                      abi: marketAbi,
                      functionName: "sharesYes",
                      args: [address],
                  } as const,
                  {
                      address: m,
                      abi: marketAbi,
                      functionName: "sharesNo",
                      args: [address],
                  } as const,
              ]
            : []),
    ]);
    const { data: callResults, isLoading: callsLoading } = useReadContracts({
        contracts: calls,
        query: { enabled: !!marketAddrs && marketAddrs.length > 0 && !!address },
    });

    if (!isConnected) {
        return (
            <Empty
                title="not connected"
                body="Connect a wallet to see the positions, claims, and PnL belonging to that address."
            />
        );
    }

    if (!marketAddrs || marketAddrs.length === 0) {
        return <Empty title="no markets" body="There aren't any markets on this factory yet." />;
    }

    if (callsLoading || !callResults) {
        return <div className="text-text-mute text-[13px]">loading positions…</div>;
    }

    // Reshape results into rows. 6 calls per market when address is set.
    const stride = 6;
    const rows: Row[] = [];
    for (let i = 0; i < marketAddrs.length; i++) {
        const base = i * stride;
        const r = callResults.slice(base, base + stride);
        if (r.some((x) => x.status === "failure")) continue;
        rows.push({
            address: marketAddrs[i]!,
            question: r[0]!.result as string,
            priceYes: r[1]!.result as bigint,
            resolved: r[2]!.result as boolean,
            outcome: r[3]!.result as Outcome,
            sharesYes: (r[4]?.result as bigint) ?? 0n,
            sharesNo: (r[5]?.result as bigint) ?? 0n,
        });
    }

    const heldRows = rows.filter((r) => r.sharesYes > 0n || r.sharesNo > 0n);

    // Aggregate exposure
    const totalShares = heldRows.reduce(
        (acc, r) => ({
            yes: acc.yes + r.sharesYes,
            no: acc.no + r.sharesNo,
        }),
        { yes: 0n, no: 0n },
    );

    // Mark-to-market value of all positions
    const mtmTotal = heldRows.reduce((acc, r) => {
        const pYes = priceToProb(r.priceYes);
        const mtmYes = Number(r.sharesYes) * pYes;
        const mtmNo = Number(r.sharesNo) * (1 - pYes);
        return acc + mtmYes + mtmNo;
    }, 0);

    return (
        <div className="space-y-8">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border">
                <SummaryCell
                    label="USDC balance"
                    value={usdc !== undefined ? `$${formatUsdc(usdc)}` : "—"}
                />
                <SummaryCell
                    label="open positions"
                    value={heldRows.length.toString()}
                />
                <SummaryCell
                    label="shares (yes / no)"
                    value={`${formatUsdc(totalShares.yes)} / ${formatUsdc(totalShares.no)}`}
                    valueClass="tabular"
                />
                <SummaryCell
                    label="mark-to-market"
                    value={`$${(mtmTotal / 1e6).toFixed(2)}`}
                />
            </div>

            {/* Positions table */}
            <section className="border border-border">
                <div className="border-b border-border px-5 py-2.5 flex items-baseline justify-between">
                    <h2 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                        / open positions
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {heldRows.length} of {rows.length} markets
                    </span>
                </div>

                {heldRows.length === 0 ? (
                    <div className="px-6 py-16 text-center">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            no open positions
                        </div>
                        <p className="text-[13px] text-text-dim">
                            Place a bet from any market and it'll appear here.
                        </p>
                        <Link
                            href="/"
                            className="inline-block mt-4 text-[12px] text-text-dim hover:text-text border border-border-strong px-3 py-1.5 transition-colors"
                        >
                            browse markets →
                        </Link>
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {heldRows.map((r) => (
                            <PositionRow key={r.address} row={r} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function SummaryCell({
    label,
    value,
    valueClass,
}: {
    label: string;
    value: string;
    valueClass?: string;
}) {
    return (
        <div className="bg-bg px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                {label}
            </div>
            <div className={`num text-[20px] text-text tabular ${valueClass ?? ""}`}>
                {value}
            </div>
        </div>
    );
}

function PositionRow({ row }: { row: Row }) {
    const pYes = priceToProb(row.priceYes);
    const mtmYes = Number(row.sharesYes) * pYes;
    const mtmNo = Number(row.sharesNo) * (1 - pYes);
    const mtm = (mtmYes + mtmNo) / 1e6;

    return (
        <Link
            href={`/markets/${row.address}`}
            className="block px-5 py-4 hover:bg-bg-elev transition-colors"
        >
            <div className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-12 md:col-span-6">
                    <div className="text-[14px] text-text leading-snug">{row.question}</div>
                    <div className="num text-[10px] text-text-faint mt-1">
                        {shortAddr(row.address, 6)}
                    </div>
                </div>

                <div className="col-span-6 md:col-span-3 flex flex-col gap-1">
                    {row.sharesYes > 0n && (
                        <div className="flex items-baseline gap-2 num text-[12.5px]">
                            <span className="text-yes uppercase tracking-wider text-[10px] w-8">
                                yes
                            </span>
                            <span className="text-text-dim tabular">{formatUsdc(row.sharesYes)}</span>
                            <span className="text-text-faint">@</span>
                            <span className="text-text-mute tabular">{formatCents(pYes)}</span>
                        </div>
                    )}
                    {row.sharesNo > 0n && (
                        <div className="flex items-baseline gap-2 num text-[12.5px]">
                            <span className="text-no uppercase tracking-wider text-[10px] w-8">
                                no
                            </span>
                            <span className="text-text-dim tabular">{formatUsdc(row.sharesNo)}</span>
                            <span className="text-text-faint">@</span>
                            <span className="text-text-mute tabular">{formatCents(1 - pYes)}</span>
                        </div>
                    )}
                </div>

                <div className="col-span-6 md:col-span-3 text-right">
                    <div className="num text-[13px] text-text tabular">
                        ${mtm.toFixed(2)}
                        <span className="text-text-faint text-[10px] ml-1 uppercase tracking-wider">
                            mtm
                        </span>
                    </div>
                    {row.resolved && (
                        <div className="num text-[10px] text-text-faint mt-1 uppercase tracking-wider">
                            resolved · {row.outcome === Outcome.Yes ? "YES" : "NO"}
                        </div>
                    )}
                </div>
            </div>
        </Link>
    );
}

function Empty({ title, body }: { title: string; body: string }) {
    return (
        <div className="border border-dashed border-border px-6 py-20 text-center">
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                / {title}
            </div>
            <p className="text-[13px] text-text-dim max-w-[40ch] mx-auto">{body}</p>
        </div>
    );
}
