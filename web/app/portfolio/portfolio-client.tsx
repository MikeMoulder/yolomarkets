"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi, Outcome } from "@/lib/contracts";
import {
    formatCents,
    formatOutcomeLabel,
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

type Participation = {
    bought: number;
    sold: number;
    claimed: number;
    claimedAmount: bigint;
};

const BOUGHT_EVENT = parseAbiItem(
    "event Bought(address indexed who, uint8 indexed outcome, uint256 shares, uint256 cost, uint256 fee, int256 newPriceYesRaw)",
);
const SOLD_EVENT = parseAbiItem(
    "event Sold(address indexed who, uint8 indexed outcome, uint256 shares, uint256 received, uint256 fee, int256 newPriceYesRaw)",
);
const CLAIMED_EVENT = parseAbiItem("event Claimed(address indexed who, uint256 amount)");

export function PortfolioClient() {
    const { address, isConnected } = useAccount();
    const publicClient = usePublicClient();

    // 1. List of markets from BOTH factories — v2 (canonical) plus the legacy
    // v1 factory, so positions and claims in pre-migration markets stay
    // visible even though the catalog no longer lists expired v1 markets.
    const { data: v2Addrs } = useReadContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    });
    const { data: legacyAddrs } = useReadContract({
        address: ADDRESSES.factoryLegacy,
        abi: factoryAbi,
        functionName: "allMarkets",
    });
    const marketAddrs =
        v2Addrs || legacyAddrs
            ? [...(v2Addrs ?? []), ...(legacyAddrs ?? [])]
            : undefined;

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

    const { data: participationByMarket = {}, isLoading: participationLoading } = useQuery({
        queryKey: ["portfolio-participation", address, marketAddrs?.join(",")],
        enabled: !!publicClient && !!address && !!marketAddrs && marketAddrs.length > 0,
        staleTime: 15_000,
        refetchInterval: 30_000,
        queryFn: async () => {
            const entries = await Promise.all(
                (marketAddrs ?? []).map(async (market) => {
                    const key = market.toLowerCase();
                    try {
                        const [bought, sold, claimed] = await Promise.all([
                            publicClient!.getLogs({
                                address: market,
                                event: BOUGHT_EVENT,
                                args: { who: address! },
                                fromBlock: 0n,
                                toBlock: "latest",
                            }),
                            publicClient!.getLogs({
                                address: market,
                                event: SOLD_EVENT,
                                args: { who: address! },
                                fromBlock: 0n,
                                toBlock: "latest",
                            }),
                            publicClient!.getLogs({
                                address: market,
                                event: CLAIMED_EVENT,
                                args: { who: address! },
                                fromBlock: 0n,
                                toBlock: "latest",
                            }),
                        ]);
                        const claimedAmount = claimed.reduce(
                            (acc, log) => acc + (log.args.amount ?? 0n),
                            0n,
                        );
                        return [
                            key,
                            {
                                bought: bought.length,
                                sold: sold.length,
                                claimed: claimed.length,
                                claimedAmount,
                            },
                        ] as const;
                    } catch {
                        return [
                            key,
                            { bought: 0, sold: 0, claimed: 0, claimedAmount: 0n },
                        ] as const;
                    }
                }),
            );
            return Object.fromEntries(entries) as Record<string, Participation>;
        },
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

    const openRows = rows.filter((r) => !r.resolved && hasCurrentPosition(r));
    const historyRows = rows
        .filter((r) => r.resolved && hasParticipated(r, participationByMarket))
        .reverse();

    // Aggregate exposure
    const totalShares = openRows.reduce(
        (acc, r) => ({
            yes: acc.yes + r.sharesYes,
            no: acc.no + r.sharesNo,
        }),
        { yes: 0n, no: 0n },
    );

    // Mark-to-market value of unresolved positions only.
    const mtmTotal = openRows.reduce((acc, r) => {
        const pYes = priceToProb(r.priceYes);
        const mtmYes = Number(r.sharesYes) * pYes;
        const mtmNo = Number(r.sharesNo) * (1 - pYes);
        return acc + mtmYes + mtmNo;
    }, 0);

    return (
        <div className="space-y-8">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border border border-border">
                <SummaryCell
                    label="USDC balance"
                    value={usdc !== undefined ? `$${formatUsdc(usdc)}` : "—"}
                />
                <SummaryCell
                    label="open positions"
                    value={openRows.length.toString()}
                />
                <SummaryCell
                    label="history"
                    value={historyRows.length.toString()}
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
                        {openRows.length} of {rows.length} markets
                    </span>
                </div>

                {openRows.length === 0 ? (
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
                        {openRows.map((r) => (
                            <PositionRow key={r.address} row={r} />
                        ))}
                    </div>
                )}
            </section>

            {/* Resolved participation history */}
            <section className="border border-border">
                <div className="border-b border-border px-5 py-2.5 flex items-baseline justify-between">
                    <h2 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                        / history
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {participationLoading ? "checking logs…" : `${historyRows.length} resolved`}
                    </span>
                </div>

                {historyRows.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            no resolved history
                        </div>
                        <p className="text-[13px] text-text-dim">
                            Resolved markets you've traded or claimed will appear here.
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {historyRows.map((r) => (
                            <HistoryRow
                                key={r.address}
                                row={r}
                                participation={participationByMarket[r.address.toLowerCase()]}
                            />
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
                </div>
            </div>
        </Link>
    );
}

function HistoryRow({
    row,
    participation,
}: {
    row: Row;
    participation?: Participation;
}) {
    const payout = claimablePayout(row);
    const claimedAmount = participation?.claimedAmount ?? 0n;
    const status = historyStatus(row, participation);
    const statusClass =
        status === "won" || status === "claimed"
            ? "text-yes"
            : status === "lost"
              ? "text-no"
              : "text-text-mute";

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
                        <HistoryShareLine side="yes" shares={row.sharesYes} />
                    )}
                    {row.sharesNo > 0n && (
                        <HistoryShareLine side="no" shares={row.sharesNo} />
                    )}
                    {row.sharesYes === 0n && row.sharesNo === 0n && (
                        <div className="num text-[11px] uppercase tracking-wider text-text-faint">
                            position closed
                        </div>
                    )}
                </div>

                <div className="col-span-6 md:col-span-3 text-right">
                    <div className="num text-[11px] uppercase tracking-[0.16em] text-text-mute">
                        {formatOutcomeLabel(row.outcome)}
                    </div>
                    <div className={`num text-[12.5px] uppercase tracking-[0.14em] mt-1 ${statusClass}`}>
                        {status}
                    </div>
                    {(payout > 0n || claimedAmount > 0n) && (
                        <div className="num text-[10px] text-text-faint mt-1">
                            {payout > 0n
                                ? `$${formatUsdc(payout)} claimable`
                                : `$${formatUsdc(claimedAmount)} claimed`}
                        </div>
                    )}
                </div>
            </div>
        </Link>
    );
}

function HistoryShareLine({ side, shares }: { side: "yes" | "no"; shares: bigint }) {
    const color = side === "yes" ? "text-yes" : "text-no";
    return (
        <div className="flex items-baseline gap-2 num text-[12.5px]">
            <span className={`${color} uppercase tracking-wider text-[10px] w-8`}>
                {side}
            </span>
            <span className="text-text-dim tabular">{formatUsdc(shares)}</span>
        </div>
    );
}

function hasCurrentPosition(row: Row): boolean {
    return row.sharesYes > 0n || row.sharesNo > 0n;
}

function hasParticipated(row: Row, participationByMarket: Record<string, Participation>): boolean {
    if (hasCurrentPosition(row)) return true;
    const participation = participationByMarket[row.address.toLowerCase()];
    return !!participation && (
        participation.bought > 0 ||
        participation.sold > 0 ||
        participation.claimed > 0
    );
}

function claimablePayout(row: Row): bigint {
    if (!row.resolved) return 0n;
    if (row.outcome === Outcome.Yes) return row.sharesYes;
    if (row.outcome === Outcome.No) return row.sharesNo;
    return 0n;
}

function historyStatus(row: Row, participation?: Participation): string {
    if (row.outcome === Outcome.Cancelled) return "cancelled";
    if (claimablePayout(row) > 0n) return "won";
    if (participation && participation.claimed > 0) return "claimed";
    if (hasCurrentPosition(row)) return "lost";
    return "closed";
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
