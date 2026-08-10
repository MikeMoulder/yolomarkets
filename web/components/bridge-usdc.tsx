"use client";

/**
 * Bring USDC to Arc from another chain, using Circle's App Kit (Bridge).
 *
 * The onboarding wall this removes: to do anything here you need USDC already
 * sitting on Arc. Most people who hold USDC hold it somewhere else, and asking
 * them to work out bridging on their own loses them. This lets them pick the
 * chain they already have funds on and moves the money for them.
 *
 * The transfer is CCTP under the hood, so the USDC is burned on the source
 * chain and minted on Arc rather than being wrapped. What arrives is real USDC.
 *
 * Layout note: this form is hosted both in a ~420px modal and full-width on the
 * agent setup page, so it sizes off `@container` rather than viewport
 * breakpoints — a `sm:` row silently collapses when the host is narrow but the
 * window is not, which is exactly how it ended up unusable inside the wallet
 * dropdown.
 */

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnectorClient } from "wagmi";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { shortAddr } from "@/lib/format";
import { CloseGlyph } from "./wallet-glyphs";

/** Testnet sources people plausibly already hold USDC on. */
const SOURCES = [
    { id: "Base_Sepolia", label: "Base Sepolia" },
    { id: "Ethereum_Sepolia", label: "Ethereum Sepolia" },
    { id: "Arbitrum_Sepolia", label: "Arbitrum Sepolia" },
    { id: "Avalanche_Fuji", label: "Avalanche Fuji" },
    { id: "Optimism_Sepolia", label: "Optimism Sepolia" },
] as const;

type SourceId = (typeof SOURCES)[number]["id"];

type Phase =
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; explorerUrl: string | null; pending: boolean }
    | { kind: "error"; message: string; detail: string | null };

const LABEL = "text-[10px] uppercase tracking-[0.16em] text-text-faint";
const FIELD =
    "h-11 w-full border border-border bg-bg px-3 text-[13px] text-text outline-none transition-colors placeholder:text-text-faint focus:border-accent/70 disabled:opacity-50";

export function BridgeUsdc({
    /** Where the funds should land. Defaults to the connected wallet. */
    recipient,
    onBridged,
}: {
    recipient?: `0x${string}`;
    onBridged?: () => void;
}) {
    const { address } = useAccount();
    const { data: connectorClient } = useConnectorClient();

    // Scoped so a second instance on the page can't steal the first one's
    // label associations.
    const uid = useId();
    const sourceId = `${uid}-source`;
    const amountId = `${uid}-amount`;

    const [source, setSource] = useState<SourceId>("Base_Sepolia");
    const [amount, setAmount] = useState("");
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });

    const to = recipient ?? address;
    const busy = phase.kind === "busy";
    const parsed = Number(amount);
    const amountOk = Number.isFinite(parsed) && parsed > 0;
    const valid = amountOk && !!to;
    const sourceLabel = SOURCES.find((s) => s.id === source)?.label ?? source;

    // App Kit resolves the signer from the connected wallet, so `address` must
    // NOT be passed for a user-controlled adapter — it throws outright. A
    // *different* destination (the agent's Circle wallet on the setup page) is
    // a separate field, and passing it when it matches the signer is pointless.
    const elsewhere =
        !!to && !!address && to.toLowerCase() !== address.toLowerCase();

    async function handleBridge() {
        if (!valid || !to) return;
        setPhase({ kind: "busy" });
        try {
            // wagmi's connector client carries the EIP-1193 provider that App
            // Kit's adapter expects, so the user signs with the wallet they are
            // already connected with rather than a second connection flow.
            const provider = connectorClient?.transport as unknown as
                | Parameters<typeof createViemAdapterFromProvider>[0]["provider"]
                | undefined;
            if (!provider) {
                throw new Error("Connect a wallet before bridging.");
            }

            const adapter = await createViemAdapterFromProvider({ provider });
            const kit = new AppKit();

            const result = await kit.bridge({
                from: { adapter, chain: BridgeChain[source] },
                to: {
                    adapter,
                    chain: BridgeChain.Arc_Testnet,
                    ...(elsewhere ? { recipientAddress: to } : {}),
                },
                amount,
            });

            setPhase({
                kind: "done",
                explorerUrl: lastExplorerUrl(result),
                pending: result?.state !== "success",
            });
            onBridged?.();
        } catch (e) {
            setPhase({ kind: "error", ...describeBridgeError(e) });
        }
    }

    return (
        <div className="@container border border-border bg-bg-elev/30">
            {/* pr-12 keeps the copy clear of the modal's floating close button. */}
            <div className="border-b border-border px-4 py-4 pr-12">
                <div className={LABEL}>bridge to arc</div>
                <div className="mt-1.5 text-[14px] font-medium text-text">
                    Already hold USDC somewhere else?
                </div>
                <p className="mt-2 max-w-[52ch] text-[12px] leading-relaxed text-text-dim">
                    Move it to Arc without leaving this page. Your USDC is burned on
                    the other chain and reissued here, so what arrives is the real
                    thing rather than a wrapped copy.
                </p>
            </div>

            {/* Capped so the setup page's ~872px doesn't stretch a two-field
                form and its button across the whole column. */}
            <div className="max-w-[620px] space-y-4 px-4 py-4">
                {/* @md = 28rem: two columns only where a chain name and an
                    amount both fit comfortably. The modal (~400px container)
                    stacks; the setup page goes side by side. */}
                <div className="grid gap-4 @md:grid-cols-2">
                    <div className="space-y-1.5">
                        <label className={LABEL} htmlFor={sourceId}>
                            from
                        </label>
                        <select
                            id={sourceId}
                            value={source}
                            onChange={(e) => setSource(e.target.value as SourceId)}
                            disabled={busy}
                            className={FIELD}
                        >
                            {SOURCES.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className={LABEL} htmlFor={amountId}>
                            amount
                        </label>
                        <div className="relative">
                            <input
                                id={amountId}
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="10.00"
                                inputMode="decimal"
                                disabled={busy}
                                className={`${FIELD} num pr-16`}
                            />
                            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center num text-[11px] text-text-faint">
                                USDC
                            </span>
                        </div>
                    </div>
                </div>

                {/* A cross-chain transfer is three transactions on two networks.
                    Saying so up front is the difference between "it's stuck" and
                    "it's working" when the wallet pops a network-switch prompt. */}
                <ol className="space-y-1.5 border border-border bg-bg px-4 py-3 text-[11.5px] text-text-dim">
                    <Step n="1">
                        Approve and burn on{" "}
                        <span className="text-text">{sourceLabel}</span>
                    </Step>
                    <Step n="2">Circle attests the burn</Step>
                    <Step n="3">
                        Mint on <span className="text-text">Arc</span>
                        {elsewhere && to ? (
                            <>
                                {" "}
                                to <span className="num text-text">{shortAddr(to)}</span>
                            </>
                        ) : null}
                    </Step>
                </ol>

                <button
                    onClick={handleBridge}
                    disabled={!valid || busy}
                    className="h-11 w-full border border-accent/50 bg-accent text-[12.5px] font-semibold text-bg transition-colors hover:bg-accent-dim disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-elev-2 disabled:text-text-mute"
                >
                    {busy
                        ? "bridging…"
                        : amountOk
                            ? `bridge ${amount.trim()} USDC to Arc`
                            : "bridge to Arc"}
                </button>

                <p className="text-[11px] leading-relaxed text-text-mute">
                    {busy
                        ? "Keep this open — your wallet will ask to switch networks and to sign twice."
                        : "Your wallet will ask to switch networks. Takes a couple of minutes."}
                </p>

                {phase.kind === "error" && (
                    <div className="border border-no/30 bg-no/5 px-4 py-3">
                        <div className="text-[12px] text-no">{phase.message}</div>
                        {phase.detail && (
                            <div className="mt-1.5 break-words text-[11px] text-text-mute">
                                {phase.detail}
                            </div>
                        )}
                    </div>
                )}

                {phase.kind === "done" && (
                    <div className="border border-yes/30 bg-yes/5 px-4 py-3">
                        <div className="text-[12px] text-yes">
                            {phase.pending ? "Burn submitted." : "Bridged."}
                        </div>
                        <div className="mt-1.5 text-[11px] text-text-dim">
                            Cross-chain transfers take a few minutes to arrive. Your
                            Arc balance updates on its own.
                        </div>
                        {phase.explorerUrl && (
                            <a
                                href={phase.explorerUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-block text-[11px] text-accent underline underline-offset-2"
                            >
                                view transaction
                            </a>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function Step({ n, children }: { n: string; children: React.ReactNode }) {
    return (
        <li className="flex gap-2.5">
            <span className="num text-text-faint">{n}</span>
            <span>{children}</span>
        </li>
    );
}

/**
 * The bridge as a standalone dialog.
 *
 * It has to live outside the wallet dropdown: App Kit switches the wallet to
 * the source chain, and anything keyed on "connected to Arc" unmounts the
 * moment that happens — taking the in-flight bridge's UI with it.
 */
export function BridgeUsdcModal({
    recipient,
    onBridged,
    onClose,
}: {
    recipient?: `0x${string}`;
    onBridged?: () => void;
    onClose: () => void;
}) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    useEffect(() => {
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = overflow;
        };
    }, []);

    if (!mounted) return null;
    return createPortal(
        <div
            className="fixed inset-0 z-[120] grid min-h-dvh place-items-center overflow-y-auto bg-black/68 px-4 py-6 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-label="Bridge USDC to Arc"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            {/* The form supplies its own frame — wrapping it in a second
                bordered card is the nesting this redesign set out to remove,
                so the close button just floats over the header instead. */}
            <div className="relative w-full max-w-[440px] max-h-[calc(100dvh-48px)] overflow-y-auto border border-border-strong bg-bg-elev shadow-2xl shadow-black/60">
                <button
                    onClick={onClose}
                    className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center border border-border bg-bg-elev-2 text-text-mute transition-colors hover:bg-bg-hover hover:text-text"
                    aria-label="Close bridge"
                >
                    <CloseGlyph />
                </button>
                <BridgeUsdc recipient={recipient} onBridged={onBridged} />
            </div>
        </div>,
        document.body,
    );
}

/** The burn/mint hashes live on the steps; there is no top-level hash. */
function lastExplorerUrl(result: unknown): string | null {
    const steps = (result as { steps?: Array<{ explorerUrl?: string }> })?.steps;
    if (!Array.isArray(steps)) return null;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const url = steps[i]?.explorerUrl;
        if (url) return url;
    }
    return null;
}

/**
 * App Kit's validation errors are written for the integrator, not the person
 * holding the wallet ("Address should not be provided for user-controlled
 * adapters" once shipped straight to the UI). Lead with something actionable
 * and keep the raw text underneath.
 */
function describeBridgeError(error: unknown): {
    message: string;
    detail: string | null;
} {
    const raw =
        error instanceof Error
            ? error.message
            : typeof error === "string"
                ? error
                : "";
    const normalized = raw.toLowerCase();

    if (
        normalized.includes("user rejected") ||
        normalized.includes("user denied") ||
        normalized.includes("rejected the request")
    ) {
        return { message: "You cancelled the request in your wallet.", detail: null };
    }
    if (
        normalized.includes("insufficient") ||
        normalized.includes("exceeds balance")
    ) {
        return {
            message: "Not enough USDC on the source chain to cover this transfer.",
            detail: raw || null,
        };
    }
    if (
        normalized.includes("switch") &&
        (normalized.includes("chain") || normalized.includes("network"))
    ) {
        return {
            message:
                "Your wallet wouldn't switch networks. Switch to the source chain manually, then try again.",
            detail: raw || null,
        };
    }
    if (normalized.includes("connect a wallet")) {
        return { message: raw, detail: null };
    }
    return {
        message: "Bridge failed.",
        detail: raw || "No details returned.",
    };
}
