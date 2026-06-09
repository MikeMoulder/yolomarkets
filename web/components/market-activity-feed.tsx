"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address } from "viem";
import { usePublicClient } from "wagmi";
import { arcTestnet } from "@/lib/chain";
import { marketAbi, Outcome } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";

type ActivitySide = "YES" | "NO";
type ActivityStatus = "routing" | "mined";

type ActivityRow = {
    id: string;
    trader: string;
    side: ActivitySide;
    shares: bigint;
    amount: bigint;
    status: ActivityStatus;
    txHash?: `0x${string}`;
};

const MAX_ROWS = 8;
const SIM_WALLETS = [
    "0x8fa2dC10994418f86E4e473e54a8768C9aC417a2",
    "0x7197a02e8b65Ba53E3c59380FA550aEe821E1160",
    "0x42f00B3A03Fbb76226b90140dAA215084fA99631",
    "0x6e7B00E986CC99829d05C0b55e4Cb5894366417e",
    "0x91b3dbD6BCfE8D4fd2CBAec69FAf93ee12A3441",
    "0xA05B1E7b1fBcC5D84370bb610bdE1454045e9e0F",
] as const;

function hashSeed(input: string): number {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function nextSeed(seed: number): number {
    return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function simulatedRow(market: Address, tick: number): ActivityRow {
    let seed = hashSeed(`${market}:${tick}`);
    const wallet = SIM_WALLETS[seed % SIM_WALLETS.length]!;
    seed = nextSeed(seed);
    const side = seed % 2 === 0 ? "YES" : "NO";
    seed = nextSeed(seed);
    const amount = BigInt(250_000 + (seed % 1_450_000));
    seed = nextSeed(seed);
    const shares = amount + BigInt(seed % 900_000);

    return {
        id: `sim-${tick}-${seed}`,
        trader: shortAddr(wallet, 4),
        side,
        shares,
        amount,
        status: "routing",
    };
}

export function MarketActivityFeed({
    market,
    resolved,
}: {
    market: Address;
    resolved: boolean;
}) {
    const publicClient = usePublicClient({ chainId: arcTestnet.id });
    const [rows, setRows] = useState<ActivityRow[]>([]);
    const [pulse, setPulse] = useState(0);

    const totals = useMemo(() => {
        return rows.reduce(
            (acc, row) => {
                if (row.side === "YES") acc.yes += 1;
                else acc.no += 1;
                return acc;
            },
            { yes: 0, no: 0 },
        );
    }, [rows]);

    useEffect(() => {
        if (!publicClient) return;
        let cancelled = false;

        async function readEvents() {
            try {
                const events = await publicClient.getContractEvents({
                    address: market,
                    abi: marketAbi,
                    eventName: "Bought",
                    fromBlock: 0n,
                    toBlock: "latest",
                });

                if (cancelled) return;

                const mapped = events
                    .slice(-MAX_ROWS)
                    .reverse()
                    .map((event) => {
                        const side: ActivitySide =
                            Number(event.args.outcome) === Outcome.Yes ? "YES" : "NO";
                        return {
                            id: `${event.transactionHash}-${event.logIndex.toString()}`,
                            trader: shortAddr(event.args.who ?? "0x", 4),
                            side,
                            shares: event.args.shares ?? 0n,
                            amount: event.args.cost ?? 0n,
                            status: "mined" as const,
                            txHash: event.transactionHash,
                        };
                    });

                setRows((current) => {
                    const synthetic = current.filter((row) => row.status === "routing");
                    const merged = [...synthetic.slice(0, 2), ...mapped];
                    const seen = new Set<string>();
                    return merged
                        .filter((row) => {
                            if (seen.has(row.id)) return false;
                            seen.add(row.id);
                            return true;
                        })
                        .slice(0, MAX_ROWS);
                });
            } catch (err) {
                console.warn("[activity] failed to read market buys", err);
            }
        }

        void readEvents();
        const interval = window.setInterval(() => void readEvents(), 8_000);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [market, publicClient]);

    useEffect(() => {
        if (resolved) return;

        const interval = window.setInterval(() => {
            setPulse((value) => value + 1);
            setRows((current) => {
                const next = simulatedRow(market, Date.now());
                return [next, ...current].slice(0, MAX_ROWS);
            });
        }, 2_400);

        return () => window.clearInterval(interval);
    }, [market, resolved]);

    return (
        <section className="border border-border bg-bg-elev/40 overflow-hidden">
            <div className="border-b border-border px-5 py-2.5 flex items-center justify-between gap-3">
                <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                    / live orders
                </h3>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-text-faint">
                    <span className="live-dot h-1.5 w-1.5 bg-live" />
                    <span>{resolved ? "settled" : "active"}</span>
                </div>
            </div>

            <div className="relative h-[92px] border-b border-border bg-bg-elev/25 overflow-hidden">
                <div className="absolute left-5 right-5 top-1/2 h-px bg-border-strong" />
                <div
                    key={pulse}
                    className="market-activity-spark absolute top-1/2 h-2 w-2 -mt-1 bg-live"
                />
                <div className="absolute inset-x-5 top-[24px] flex justify-between">
                    {[0, 1, 2, 3, 4].map((i) => (
                        <span
                            key={i}
                            className="h-2 w-px bg-border-strong"
                            style={{ opacity: 0.45 + i * 0.08 }}
                        />
                    ))}
                </div>
                <div className="absolute left-5 top-5 text-[10px] uppercase tracking-[0.16em] text-text-faint">
                    incoming
                </div>
                <div className="absolute right-5 bottom-4 grid grid-cols-2 gap-2 text-[10px] uppercase tracking-[0.14em]">
                    <span className="text-yes">{totals.yes} yes</span>
                    <span className="text-no">{totals.no} no</span>
                </div>
            </div>

            <div className="relative h-[246px] overflow-hidden">
                <div className="absolute inset-0 overflow-y-auto no-scrollbar px-3 py-3 space-y-2">
                    {rows.length === 0 ? (
                        <div className="shimmer h-[42px] border border-border bg-bg-elev" />
                    ) : (
                        rows.map((row) => (
                            <ActivityItem key={row.id} row={row} />
                        ))
                    )}
                </div>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg-elev/95 to-transparent" />
            </div>
        </section>
    );
}

function ActivityItem({ row }: { row: ActivityRow }) {
    const sideClass =
        row.side === "YES"
            ? "border-yes/30 bg-yes/5 text-yes"
            : "border-no/30 bg-no/5 text-no";

    return (
        <div className="market-activity-row grid grid-cols-[1fr_auto] gap-3 border border-border bg-bg-elev px-3 py-2.5">
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <span className="num text-[12px] text-text-dim">{row.trader}</span>
                    <span className={`px-1.5 py-0.5 border text-[10px] ${sideClass}`}>
                        {row.side}
                    </span>
                    {row.status === "routing" && (
                        <span className="text-[10px] uppercase tracking-[0.14em] text-live">
                            routing
                        </span>
                    )}
                </div>
                <div className="mt-1 text-[11px] text-text-mute">
                    <span className="num text-text-dim">{formatUsdc(row.shares)}</span>
                    {" "}shares · <span className="num">${formatUsdc(row.amount)}</span>
                </div>
            </div>
            {row.txHash ? (
                <a
                    href={`https://testnet.arcscan.app/tx/${row.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="num self-center text-[10px] text-text-faint hover:text-text-dim transition-colors"
                >
                    {shortAddr(row.txHash, 4)}
                </a>
            ) : (
                <div className="self-center h-1.5 w-10 overflow-hidden bg-bg-elev-2">
                    <span className="market-activity-meter block h-full w-1/2 bg-live/70" />
                </div>
            )}
        </div>
    );
}
