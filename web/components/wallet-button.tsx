"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useEffect, useState } from "react";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import { useReadContract } from "wagmi";
import { formatUsdc, shortAddr } from "@/lib/format";

export function WalletButton() {
    const { address, chainId, isConnected } = useAccount();
    const { connectors, connect, isPending } = useConnect();
    const { disconnect } = useDisconnect();
    const { switchChain } = useSwitchChain();
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const { data: usdcBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 15_000 },
    });

    if (!mounted) {
        return (
            <button className="h-8 w-[112px] border border-border bg-bg-elev text-[12px] text-text-mute">
                {/* placeholder during hydration */}
            </button>
        );
    }

    if (!isConnected || !address) {
        return (
            <div className="relative">
                <button
                    onClick={() => setOpen((v) => !v)}
                    disabled={isPending || connectors.length === 0}
                    className="h-8 px-3 border border-border-strong bg-bg-elev text-[12px] text-text hover:bg-bg-hover transition-colors disabled:opacity-50"
                >
                    {isPending ? "connecting..." : "connect wallet"}
                </button>
                {open && connectors.length > 0 && (
                    <div className="absolute right-0 mt-1 w-48 border border-border bg-bg-elev shadow-lg z-50">
                        {connectors.map((connector) => (
                            <button
                                key={connector.uid}
                                onClick={() => {
                                    connect({ connector });
                                    setOpen(false);
                                }}
                                disabled={isPending}
                                className="w-full text-left px-3 py-2 text-[12px] text-text-dim hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-50"
                            >
                                {connector.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    const wrongChain = chainId !== arcTestnet.id;

    if (wrongChain) {
        return (
            <button
                onClick={() => switchChain({ chainId: arcTestnet.id })}
                className="h-8 px-3 border border-warn/40 bg-warn/10 text-[12px] text-warn hover:bg-warn/20 transition-colors"
            >
                switch to Arc
            </button>
        );
    }

    return (
        <div className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-3 h-8 px-3 border border-border bg-bg-elev hover:bg-bg-hover transition-colors"
            >
                <span className="num text-[12px] text-text">
                    {usdcBal !== undefined ? formatUsdc(usdcBal) : "—"}
                    <span className="text-text-mute"> USDC</span>
                </span>
                <span className="h-3 w-px bg-border" />
                <span className="num text-[12px] text-text-dim">{shortAddr(address)}</span>
            </button>
            {open && (
                <div className="absolute right-0 mt-1 w-52 border border-border bg-bg-elev shadow-lg">
                    <div className="px-3 py-2 border-b border-border">
                        <div className="text-[10px] uppercase tracking-[0.15em] text-text-mute">
                            wallet
                        </div>
                        <div className="num text-[12px] text-text-dim mt-1 break-all">
                            {address}
                        </div>
                    </div>
                    <button
                        onClick={() => {
                            disconnect();
                            setOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-[12px] text-text-dim hover:bg-bg-hover hover:text-text transition-colors"
                    >
                        disconnect
                    </button>
                </div>
            )}
        </div>
    );
}
