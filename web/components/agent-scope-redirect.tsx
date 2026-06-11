"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";

export function AgentScopeRedirect() {
    const { address, isConnected } = useAccount();
    const router = useRouter();

    useEffect(() => {
        if (isConnected && address) {
            router.replace(`/agent?u=${address}`);
        }
    }, [address, isConnected, router]);

    return (
        <div className="mx-auto max-w-[920px] px-6 py-16 text-center">
            <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute num mb-3">
                / agent · private
            </div>
            <h1 className="text-[26px] md:text-[34px] leading-tight tracking-tight font-medium">
                Your agent feed is scoped to your wallet.
            </h1>
            <p className="mt-4 text-[13px] text-text-dim max-w-[56ch] mx-auto leading-relaxed">
                Connect your wallet to open your own decisions, passes, risk
                gates, and trade notifications.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
                <Link
                    href="/agent/setup"
                    className="px-4 h-9 leading-9 border border-accent bg-accent-bg text-accent text-[12px] uppercase tracking-[0.18em] num hover:bg-accent/15"
                >
                    setup
                </Link>
                <Link
                    href="/agent/settings"
                    className="px-4 h-9 leading-9 border border-border-strong text-text-dim text-[12px] uppercase tracking-[0.18em] num hover:text-text hover:bg-bg-hover"
                >
                    settings
                </Link>
            </div>
        </div>
    );
}
