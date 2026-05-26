"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect, useSignMessage } from "wagmi";

type Step = "idle" | "connecting" | "nonce" | "signing" | "verifying" | "ok" | "error";

function buildClientLoginMessage(
    address: `0x${string}`,
    nonce: string,
    issuedAt: string,
): string {
    return [
        "YOLO Markets — Admin Authentication",
        "",
        `Wallet:   ${address}`,
        `Nonce:    ${nonce}`,
        `Issued:   ${issuedAt}`,
        `Expires:  in 5 minutes`,
        "",
        "By signing this message you authorize a 1-hour admin session.",
        "This signature is OFF-CHAIN and does not move any funds.",
        "If you did not initiate this login, reject the request.",
    ].join("\n");
}

export function LoginClient({ redirectTo }: { redirectTo?: string }) {
    const router = useRouter();
    const { address, isConnected } = useAccount();
    const { connectors, connect, isPending: connectPending } = useConnect();
    const { signMessageAsync, isPending: signPending } = useSignMessage();

    const [step, setStep] = useState<Step>("idle");
    const [error, setError] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    async function handleConnect() {
        setError(null);
        const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
        if (!injected) {
            setError("No injected wallet detected. Install MetaMask or similar.");
            return;
        }
        setStep("connecting");
        try {
            await connect({ connector: injected });
            setStep("idle");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to connect wallet.");
            setStep("error");
        }
    }

    async function handleSignIn() {
        if (!address) return;
        setError(null);
        try {
            setStep("nonce");
            const r = await fetch("/api/admin/nonce", { method: "GET", cache: "no-store" });
            if (!r.ok) throw new Error("Failed to request challenge.");
            const { nonce, issuedAt } = (await r.json()) as {
                nonce: string;
                issuedAt: string;
            };

            setStep("signing");
            const message = buildClientLoginMessage(address, nonce, issuedAt);
            const signature = await signMessageAsync({ message });

            setStep("verifying");
            const v = await fetch("/api/admin/verify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ address, signature }),
            });
            if (!v.ok) {
                const j = (await v.json().catch(() => ({}))) as { error?: string };
                throw new Error(j.error ?? `Verification failed (${v.status}).`);
            }

            setStep("ok");
            // Hard navigation so the new cookie is picked up by the server.
            const target =
                redirectTo && redirectTo.startsWith("/admin") ? redirectTo : "/admin";
            router.replace(target);
            router.refresh();
        } catch (e) {
            const msg =
                e instanceof Error
                    ? e.message
                    : "Authentication failed. Try again.";
            setError(msg);
            setStep("error");
        }
    }

    if (!mounted) {
        return <div className="h-24" />;
    }

    return (
        <div className="flex flex-col gap-4">
            {/* State indicator */}
            <div className="flex items-center justify-between text-[10.5px] num uppercase tracking-[0.18em] text-text-mute">
                <span>session</span>
                <StateBadge step={step} />
            </div>

            {/* Wallet info */}
            <div className="border border-border bg-bg-elev-2/60 px-3 py-3 rounded-sm">
                <div className="text-[9.5px] uppercase tracking-[0.2em] text-text-faint mb-1.5 num">
                    connected wallet
                </div>
                {isConnected && address ? (
                    <div className="num text-[12.5px] tabular text-text break-all">
                        {address}
                    </div>
                ) : (
                    <div className="num text-[12px] text-text-mute">no wallet connected</div>
                )}
            </div>

            {/* Action */}
            {!isConnected ? (
                <button
                    onClick={handleConnect}
                    disabled={connectPending || step === "connecting"}
                    className="h-11 border border-accent/50 bg-accent/10 hover:bg-accent/15 text-accent text-[13px] num uppercase tracking-[0.2em] disabled:opacity-50 transition-colors rounded-sm"
                >
                    {connectPending || step === "connecting"
                        ? "connecting…"
                        : "connect wallet"}
                </button>
            ) : (
                <button
                    onClick={handleSignIn}
                    disabled={
                        signPending ||
                        step === "nonce" ||
                        step === "signing" ||
                        step === "verifying" ||
                        step === "ok"
                    }
                    className="h-11 border border-accent/50 bg-accent/10 hover:bg-accent/15 text-accent text-[13px] num uppercase tracking-[0.2em] disabled:opacity-50 transition-colors rounded-sm"
                >
                    {step === "nonce" && "requesting challenge…"}
                    {step === "signing" && "awaiting signature…"}
                    {step === "verifying" && "verifying signature…"}
                    {step === "ok" && "authorized · redirecting…"}
                    {(step === "idle" || step === "error" || step === "connecting") &&
                        "sign in with wallet"}
                </button>
            )}

            {error && (
                <div className="border border-no/40 bg-no/10 px-3 py-2.5 text-[12px] text-no rounded-sm">
                    {error}
                </div>
            )}
        </div>
    );
}

function StateBadge({ step }: { step: Step }) {
    const map: Record<Step, { label: string; color: string }> = {
        idle: { label: "ready", color: "text-text-mute" },
        connecting: { label: "connecting", color: "text-live" },
        nonce: { label: "challenge", color: "text-live" },
        signing: { label: "signing", color: "text-edge" },
        verifying: { label: "verifying", color: "text-live" },
        ok: { label: "authorized", color: "text-yes" },
        error: { label: "error", color: "text-no" },
    };
    const { label, color } = map[step];
    return <span className={`tabular ${color}`}>{label}</span>;
}
