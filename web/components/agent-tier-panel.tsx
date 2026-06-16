"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { AgentProfile } from "@/lib/agent-profiles";

type Tier = "free" | "pro" | "plus";

type SubscriptionState = {
    tier: Tier;
    credits: number;
    autoRenew: boolean;
    expiresAt: string | null;
    x402ReasoningPriceUsdc: string;
};

const PLANS: Array<{
    id: Tier;
    name: string;
    price: string;
    credits: string;
    cadence: string;
    checks: string;
    tradeCap: string;
    dailyTrades: string;
    available: boolean;
}> = [
    {
        id: "free",
        name: "Free",
        price: "$0/mo",
        credits: "30 scan quota/day",
        cadence: "Every 4h",
        checks: "30 AI checks/day",
        tradeCap: "$1 max trade",
        dailyTrades: "3 trades/day",
        available: true,
    },
    {
        id: "pro",
        name: "Pro",
        price: "$5/mo + x402",
        credits: "100 scan quota/day",
        cadence: "Every 1h",
        checks: "100 AI checks/day",
        tradeCap: "$5 max trade",
        dailyTrades: "12 trades/day",
        available: false,
    },
    {
        id: "plus",
        name: "Plus",
        price: "$20/mo + x402",
        credits: "200 scan quota/day",
        cadence: "Every 15m",
        checks: "200 AI checks/day",
        tradeCap: "$25 max trade",
        dailyTrades: "50 trades/day",
        available: false,
    },
];

function tierName(tier: Tier): string {
    return PLANS.find((p) => p.id === tier)?.name ?? "Free";
}

export function AgentTierPanel() {
    const { address, isConnected } = useAccount();
    const [open, setOpen] = useState(false);
    const [profile, setProfile] = useState<AgentProfile | null>(null);
    const [profileLoading, setProfileLoading] = useState(false);
    const [subscription, setSubscription] = useState<SubscriptionState>({
        tier: "free",
        credits: 0,
        autoRenew: false,
        expiresAt: null,
        x402ReasoningPriceUsdc: "0.01",
    });

    useEffect(() => {
        if (!address) {
            setProfile(null);
            setSubscription({
                tier: "free",
                credits: 0,
                autoRenew: false,
                expiresAt: null,
                x402ReasoningPriceUsdc: "0.01",
            });
            return;
        }
        let cancelled = false;
        (async () => {
            setProfileLoading(true);
            try {
                const profileRes = await fetch(`/api/agent/profile?addr=${address}`);
                const profileData = (await profileRes.json()) as {
                    profile: AgentProfile | null;
                };
                if (cancelled) return;
                setProfile(profileData.profile);

                if (!profileData.profile) {
                    setSubscription({
                        tier: "free",
                        credits: 0,
                        autoRenew: false,
                        expiresAt: null,
                        x402ReasoningPriceUsdc: "0.01",
                    });
                    return;
                }

                const subscriptionRes = await fetch(`/api/agent/subscription?addr=${address}`);
                const subscriptionData = (await subscriptionRes.json()) as {
                    subscription?: SubscriptionState;
                };
                if (!cancelled && subscriptionData.subscription) {
                    setSubscription(subscriptionData.subscription);
                }
            } catch {
                if (!cancelled) {
                    setProfile(null);
                    setSubscription({
                        tier: "free",
                        credits: 0,
                        autoRenew: false,
                        expiresAt: null,
                        x402ReasoningPriceUsdc: "0.01",
                    });
                }
            } finally {
                if (!cancelled) setProfileLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address]);

    if (!isConnected || !address || profileLoading || !profile) {
        return null;
    }

    return (
        <section className="border border-border bg-bg-elev/35 px-5 py-5">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                        / agent tier
                    </div>
                    <div className="flex items-baseline gap-3 flex-wrap">
                        <h2 className="text-[20px] font-medium">
                            {isConnected ? tierName(subscription.tier) : "Connect wallet"}
                        </h2>
                        {isConnected && (
                            <span className="num text-[12px] text-text-dim">
                                {subscription.credits.toLocaleString()} scans · $
                                {subscription.x402ReasoningPriceUsdc}/request
                            </span>
                        )}
                    </div>
                </div>
                <button
                    onClick={() => setOpen((v) => !v)}
                    className="self-start md:self-auto px-4 h-9 border border-accent bg-accent-bg text-accent text-[12px] uppercase tracking-[0.18em] num hover:bg-accent/15 transition-colors"
                >
                    {open ? "hide plans" : "upgrade"}
                </button>
            </div>

            {open && (
                <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
                    {PLANS.map((plan) => {
                        const current = isConnected && subscription.tier === plan.id;
                        return (
                            <div
                                key={plan.id}
                                className={`border px-4 py-4 bg-bg/35 ${
                                    current ? "border-accent" : "border-border"
                                }`}
                            >
                                <div className="flex items-start justify-between gap-3 mb-4">
                                    <div>
                                        <div className="text-[15px] font-medium">
                                            {plan.name}
                                        </div>
                                        <div className="num text-[12px] text-text-dim mt-1">
                                            {plan.price}
                                        </div>
                                    </div>
                                    {current && (
                                        <span className="num text-[9.5px] uppercase tracking-[0.18em] text-accent">
                                            current
                                        </span>
                                    )}
                                </div>

                                <div className="space-y-2 text-[12px] text-text-dim">
                                    <PlanRow k="credits" v={plan.credits} />
                                    <PlanRow k="cadence" v={plan.cadence} />
                                    <PlanRow k="checks" v={plan.checks} />
                                    <PlanRow k="trade cap" v={plan.tradeCap} />
                                    <PlanRow k="daily" v={plan.dailyTrades} />
                                    <PlanRow
                                        k="x402"
                                        v={`$${subscription.x402ReasoningPriceUsdc} / AI request`}
                                    />
                                </div>

                                <button
                                    disabled={!plan.available || current}
                                    className="mt-5 w-full h-9 border border-border-strong text-[11px] uppercase tracking-[0.18em] num text-text-dim disabled:opacity-45"
                                >
                                    {current
                                        ? "current plan"
                                        : plan.available
                                            ? "select plan"
                                            : "unavailable"}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

function PlanRow({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex items-baseline justify-between gap-3 border-b border-border/70 pb-1.5">
            <span className="text-[9.5px] uppercase tracking-[0.16em] text-text-mute num">
                {k}
            </span>
            <span className="text-right">{v}</span>
        </div>
    );
}
