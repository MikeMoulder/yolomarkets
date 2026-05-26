"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { AgentProfile } from "@/lib/agent-profiles";
import { PATTERNS } from "@/lib/agent-patterns";

/** Top-of-page banner on /agent that reflects the connected wallet's
 *  agent state: not-connected → invite; no profile → setup CTA;
 *  has profile → status pill + settings link.
 *
 *  Phase 1: the underlying decisions feed is still the shared demo agent.
 *  The banner makes it clear that your settings shape your story, even
 *  though the executions aren't per-user yet (Phase 2+). */
export function AgentProfileBanner() {
    const { address, isConnected } = useAccount();
    const [profile, setProfile] = useState<AgentProfile | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!address) {
            setProfile(null);
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const r = await fetch(`/api/agent/profile?addr=${address}`);
                const data = (await r.json()) as { profile: AgentProfile | null };
                if (!cancelled) setProfile(data.profile);
            } catch {
                if (!cancelled) setProfile(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address]);

    // ── State 1: not connected ──────────────────────────────────────────
    if (!isConnected) {
        return (
            <div className="border border-border bg-bg-elev/40 px-5 py-4 flex flex-wrap items-center gap-3">
                <span className="num text-[10.5px] uppercase tracking-[0.22em] text-text-mute">
                    / your agent
                </span>
                <span className="text-[13px] text-text-dim">
                    Connect a wallet to set up an agent that trades for you.
                </span>
            </div>
        );
    }

    // ── State 2: connected, loading ────────────────────────────────────
    if (loading) {
        return (
            <div className="border border-border bg-bg-elev/40 px-5 py-4 text-[12px] text-text-mute num">
                checking profile…
            </div>
        );
    }

    // ── State 3: connected, no profile ─────────────────────────────────
    if (!profile) {
        return (
            <div className="border border-accent/30 bg-accent-bg px-5 py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <span className="num text-[10.5px] uppercase tracking-[0.22em] text-accent">
                        / no agent yet
                    </span>
                    <span className="text-[13.5px] text-text">
                        Pick a trading pattern, set a budget, and let it run
                        while you&apos;re away.
                    </span>
                </div>
                <Link
                    href="/agent/setup"
                    className="shrink-0 px-5 h-10 leading-10 border border-accent bg-bg/40 text-accent text-[12.5px] uppercase tracking-[0.18em] num hover:bg-accent/15 transition-colors text-center"
                >
                    set up your agent →
                </Link>
            </div>
        );
    }

    // ── State 4: connected, has profile ────────────────────────────────
    const p =
        profile.pattern === "custom" ? null : PATTERNS[profile.pattern];

    return (
        <div className="border border-yes/25 bg-yes/[0.03] px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2 min-w-0">
                <span
                    className={`num text-[10.5px] uppercase tracking-[0.22em] inline-flex items-center gap-1.5 ${
                        profile.active ? "text-yes" : "text-text-mute"
                    }`}
                >
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${
                            profile.active ? "bg-yes live-dot" : "bg-text-mute"
                        }`}
                    />
                    your agent · {profile.active ? "active" : "paused"}
                </span>
            </div>
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
                <span className="text-text">{p?.name ?? "Custom"}</span>
                <span className="text-text-faint">·</span>
                <span className="num text-text-dim tabular">
                    every {profile.cadenceMinutes}m
                </span>
                <span className="text-text-faint">·</span>
                <span className="num text-text-dim tabular">
                    ${profile.budgetTotal.toFixed(0)} budget
                </span>
                <span className="text-text-faint">·</span>
                <span className="num text-text-mute">
                    {profile.marketsMode === "all"
                        ? "all markets"
                        : profile.marketsMode === "categories"
                            ? `${profile.categories.length} categories`
                            : `${profile.watchlist.length} watchlist`}
                </span>
                {profile.agentAddress && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="num text-yes text-[11px]">
                            on-chain ◆
                        </span>
                    </>
                )}
                {profile.sessionKeyAddress &&
                    profile.sessionValidUntil &&
                    profile.sessionValidUntil > Math.floor(Date.now() / 1000) && (
                        <>
                            <span className="text-text-faint">·</span>
                            <span className="num text-yes text-[11px]">
                                session live ⚡
                            </span>
                        </>
                    )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <Link
                    href={`/agent?u=${address}`}
                    className="text-[11.5px] uppercase tracking-[0.18em] num text-accent hover:text-text transition-colors"
                >
                    my feed →
                </Link>
                <Link
                    href="/agent/settings"
                    className="text-[11.5px] uppercase tracking-[0.18em] num text-text-dim hover:text-text transition-colors"
                >
                    settings →
                </Link>
            </div>
        </div>
    );
}
