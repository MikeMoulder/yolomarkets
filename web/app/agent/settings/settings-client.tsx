"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import type { AgentProfile } from "@/lib/agent-profiles";
import { PATTERNS } from "@/lib/agent-patterns";
import { AgentAccountCard } from "@/components/agent-account-card";
import { AgentSessionCard } from "@/components/agent-session-card";
import { signProfileOp } from "@/lib/client-auth";

export function SettingsClient() {
    const { address, isConnected } = useAccount();
    const { signMessageAsync } = useSignMessage();
    const router = useRouter();

    const [profile, setProfile] = useState<AgentProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!address) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const r = await fetch(`/api/agent/profile?addr=${address}`);
                const data = (await r.json()) as { profile: AgentProfile | null };
                if (!cancelled) setProfile(data.profile);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : "load failed");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address]);

    async function togglePause() {
        if (!profile || !address) return;
        setBusy(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.active",
                userAddr: address,
                signMessageAsync,
            });
            const r = await fetch("/api/agent/profile/active", {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({
                    userAddr: address,
                    active: !profile.active,
                }),
            });
            const data = (await r.json()) as { profile?: AgentProfile; error?: string };
            if (data.profile) setProfile(data.profile);
            else if (data.error) setError(data.error);
        } catch (e) {
            setError(e instanceof Error ? e.message : "signature rejected");
        } finally {
            setBusy(false);
        }
    }

    async function destroy() {
        if (!address) return;
        if (!confirm("Delete this agent profile? This can't be undone.")) return;
        setBusy(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.delete",
                userAddr: address,
                signMessageAsync,
            });
            const r = await fetch(`/api/agent/profile?addr=${address}`, {
                method: "DELETE",
                headers: authHeaders,
            });
            if (!r.ok) {
                const data = (await r.json().catch(() => ({}))) as { error?: string };
                setError(data.error ?? `delete failed (${r.status})`);
                return;
            }
            router.push("/agent");
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "signature rejected");
        } finally {
            setBusy(false);
        }
    }

    if (!isConnected) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-16 text-center">
                <h1 className="text-[24px] font-medium mb-3">
                    Connect your wallet
                </h1>
                <p className="text-[13px] text-text-dim">
                    Agent settings are scoped to your wallet address.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-16 text-center text-text-mute text-[13px]">
                loading…
            </div>
        );
    }

    if (!profile) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-16 text-center">
                <h1 className="text-[24px] font-medium mb-3">
                    No agent yet
                </h1>
                <p className="text-[13px] text-text-dim mb-6">
                    You don&apos;t have an agent profile on this wallet.
                </p>
                <Link
                    href="/agent/setup"
                    className="inline-block px-5 h-10 leading-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] num hover:bg-accent/15"
                >
                    set one up →
                </Link>
            </div>
        );
    }

    const p =
        profile.pattern === "custom" ? null : PATTERNS[profile.pattern];

    return (
        <div className="mx-auto max-w-[920px] px-6 py-10">
            <div className="mb-6">
                <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                    / agent settings
                </div>
                <h1 className="text-[26px] md:text-[32px] leading-tight tracking-tight font-medium">
                    {p?.name ?? "Custom"} agent
                </h1>
                <div className="mt-3 flex items-center gap-3 text-[12px] text-text-dim">
                    <span
                        className={`num text-[10px] uppercase tracking-[0.22em] inline-flex items-center gap-1.5 ${
                            profile.active ? "text-yes" : "text-text-mute"
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${
                                profile.active ? "bg-yes live-dot" : "bg-text-mute"
                            }`}
                        />
                        {profile.active ? "active" : "paused"}
                    </span>
                    <span className="text-text-faint">·</span>
                    <span className="num text-text-mute">
                        created {formatDate(profile.createdAt)}
                    </span>
                </div>
            </div>

            {error && (
                <div className="mb-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                    {error}
                </div>
            )}

            {profile.agentAddress && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                    <AgentAccountCard agentAddress={profile.agentAddress} />
                    {profile.sessionKeyAddress && (
                        <AgentSessionCard
                            agentAddress={profile.agentAddress}
                            sessionKeyAddress={profile.sessionKeyAddress}
                        />
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border border border-border mb-6">
                <Card label="pattern">
                    <div className="text-[14px] text-text">{p?.name ?? "Custom"}</div>
                    {p && (
                        <div className="text-[12px] text-text-dim mt-1 leading-snug">
                            {p.oneLiner}
                        </div>
                    )}
                </Card>
                <Card label="cadence">
                    <div className="text-[14px] text-text num">
                        every {profile.cadenceMinutes}m
                    </div>
                </Card>
                <Card label="markets">
                    <div className="text-[13px] text-text-dim">
                        {profile.marketsMode === "all"
                            ? "All live markets"
                            : profile.marketsMode === "categories"
                                ? profile.categories.join(", ") || "—"
                                : `${profile.watchlist.length} hand-picked`}
                    </div>
                </Card>
                <Card label="signals">
                    <div className="text-[13px] text-text-dim num uppercase tracking-wide">
                        {profile.signals.join(" + ")}
                    </div>
                </Card>
                <Card label="risk knobs">
                    <div className="text-[12px] text-text-dim num space-y-0.5">
                        <div>kelly × {profile.kellyMult.toFixed(2)}</div>
                        <div>edge ≥ {(profile.edgeThreshold * 100).toFixed(1)}pt</div>
                        <div>conf ≥ {Math.round(profile.minConfidence * 100)}%</div>
                    </div>
                </Card>
                <Card label="budget">
                    <div className="text-[12px] text-text-dim num space-y-0.5 tabular">
                        <div>${profile.budgetTotal.toFixed(2)} total</div>
                        <div>${profile.budgetPerMarket.toFixed(2)} per market</div>
                        <div>${profile.budgetPerDay.toFixed(2)} per day</div>
                    </div>
                </Card>
            </div>

            <div className="flex flex-wrap gap-3">
                <Link
                    href="/agent/setup"
                    className="px-4 h-9 leading-9 border border-border-strong text-text text-[12px] uppercase tracking-[0.18em] num hover:bg-bg-hover transition-colors"
                >
                    edit →
                </Link>
                <button
                    onClick={togglePause}
                    disabled={busy}
                    className="px-4 h-9 border border-border text-text-dim text-[12px] uppercase tracking-[0.18em] num hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-50"
                >
                    {profile.active ? "pause" : "resume"}
                </button>
                <button
                    onClick={destroy}
                    disabled={busy}
                    className="ml-auto px-4 h-9 border border-no/40 text-no text-[12px] uppercase tracking-[0.18em] num hover:bg-no/10 transition-colors disabled:opacity-50"
                >
                    delete profile
                </button>
            </div>
        </div>
    );
}

function Card({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="bg-bg p-5">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-2 num">
                / {label}
            </div>
            {children}
        </div>
    );
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
}
