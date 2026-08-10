"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address } from "viem";
import {
    useAccount,
    useDisconnect,
    useReadContract,
    useSwitchChain,
} from "wagmi";
import { isAddress, parseUnits } from "viem";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";
import { useCircleWallet } from "@/lib/circle-session";
import { useCircleConfirm } from "@/lib/circle-confirm";
import { useCirclePayment } from "@/lib/use-circle-payment";
import { useWalletModal } from "./wallet-modal";
import { BridgeUsdcModal } from "./bridge-usdc";
import { WalletGlyph } from "./wallet-glyphs";

export function WalletButton() {
    const { address, chainId, connector, isConnected } = useAccount();
    const { disconnect } = useDisconnect();
    const { switchChain } = useSwitchChain();
    const { session, disconnectCircleWallet } = useCircleWallet();
    const { openWalletModal } = useWalletModal();

    const [open, setOpen] = useState(false);
    const [bridgeOpen, setBridgeOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    const activeAddress = useMemo(() => {
        if (isConnected && address) return address;
        return session?.address ?? null;
    }, [address, isConnected, session?.address]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") setOpen(false);
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    const activeKind =
        isConnected && address ? (connector?.name ?? "wallet") : session ? "circle" : null;

    // Pinned to Arc: bridging switches the wallet to the source chain for a
    // minute or two, and the header balance should keep reading Arc throughout
    // rather than blanking out on whatever chain the wallet is passing through.
    const { data: usdcBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        chainId: arcTestnet.id,
        args: activeAddress ? [activeAddress] : undefined,
        query: { enabled: !!activeAddress, refetchInterval: 15_000 },
    });

    if (!mounted) {
        return (
            <button className="h-8 w-[112px] border border-border bg-bg-elev text-[12px] text-text-mute">
                {/* placeholder during hydration */}
            </button>
        );
    }

    // A bridge deliberately moves the wallet onto the source chain, so during
    // one the "wrong chain" nag is wrong — pressing it would abandon the
    // transfer mid-flight.
    const wrongChain = isConnected && chainId !== arcTestnet.id && !bridgeOpen;

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

    const buttonLabel = activeAddress ? shortAddr(activeAddress) : "connect wallet";

    return (
        <div className="relative">
            {bridgeOpen && (
                <BridgeUsdcModal onClose={() => setBridgeOpen(false)} />
            )}
            <button
                onClick={() => {
                    if (activeAddress) setOpen((value) => !value);
                    else openWalletModal();
                }}
                aria-haspopup={activeAddress ? "dialog" : undefined}
                aria-expanded={activeAddress ? open : undefined}
                className="flex h-8 items-center gap-2 border border-border-strong bg-bg-elev px-3 text-[12px] text-text transition-colors hover:border-border-bright hover:bg-bg-hover"
            >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border-bright bg-bg-elev-2">
                    <WalletGlyph kind={activeKind ?? "wallet"} size="sm" />
                </span>
                {activeAddress && (
                    <>
                        <span className="hidden sm:inline num text-text">
                            {usdcBal !== undefined ? formatUsdc(usdcBal) : "—"}
                            <span className="text-text-mute"> USDC</span>
                        </span>
                        <span className="hidden h-3 w-px bg-border sm:inline-block" />
                    </>
                )}
                <span className="num text-text-dim">{buttonLabel}</span>
            </button>

            {open && activeAddress && (
                <>
                    <div
                        className="fixed inset-0 z-[90]"
                        aria-hidden="true"
                        onMouseDown={() => setOpen(false)}
                    />
                    <div
                        className="absolute right-0 top-[calc(100%+8px)] z-[100] w-[320px] max-w-[calc(100vw-24px)] border border-border-strong bg-bg-elev shadow-2xl shadow-black/60"
                        role="dialog"
                        aria-label="Wallet details"
                    >
                        <ConnectedWalletPanel
                            address={activeAddress}
                            kind={activeKind ?? "wallet"}
                            usdcBal={usdcBal}
                            onBridge={() => {
                                setOpen(false);
                                setBridgeOpen(true);
                            }}
                            onDisconnect={() => {
                                if (isConnected) disconnect();
                                disconnectCircleWallet();
                                setOpen(false);
                            }}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function CircleWithdrawSection({ usdcBal }: { usdcBal: bigint | undefined }) {
    const { withdrawViaCircle } = useCirclePayment();
    const [open, setOpen] = useState(false);
    const [dest, setDest] = useState("");
    const [amount, setAmount] = useState("");
    const [state, setState] = useState<
        | { phase: "idle" }
        | { phase: "sending" }
        | { phase: "done"; hash: string }
        | { phase: "error"; message: string }
    >({ phase: "idle" });

    // Leave a little behind for gas — SCA transactions cost ~0.01 USDC each.
    const GAS_HEADROOM = 20_000n; // 0.02 USDC
    const maxWithdraw =
        usdcBal !== undefined && usdcBal > GAS_HEADROOM ? usdcBal - GAS_HEADROOM : 0n;

    let amountMicro: bigint | null = null;
    try {
        amountMicro = amount.trim() ? parseUnits(amount.trim(), 6) : null;
    } catch {
        amountMicro = null;
    }
    const valid =
        isAddress(dest.trim()) &&
        amountMicro !== null &&
        amountMicro > 0n &&
        amountMicro <= (usdcBal ?? 0n);

    async function submit() {
        if (!valid || amountMicro === null) return;
        setState({ phase: "sending" });
        try {
            const hash = await withdrawViaCircle(dest.trim(), amountMicro);
            setState({ phase: "done", hash });
            setAmount("");
        } catch (e) {
            setState({
                phase: "error",
                message: e instanceof Error ? e.message : "Withdraw failed.",
            });
        }
    }

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="h-10 w-full border border-border bg-bg text-[12px] text-text-dim transition-colors hover:border-border-bright hover:bg-bg-hover hover:text-text"
            >
                withdraw USDC
            </button>
        );
    }

    return (
        <div className="space-y-2 border border-border bg-bg px-3 py-3">
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.16em] text-text-faint">
                    withdraw USDC
                </span>
                <button
                    onClick={() => {
                        setOpen(false);
                        setState({ phase: "idle" });
                    }}
                    className="text-[11px] text-text-mute hover:text-text"
                >
                    close
                </button>
            </div>
            <input
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="destination address 0x…"
                spellCheck={false}
                className="h-9 w-full border border-border bg-bg-elev-2 px-2 num text-[12px] text-text placeholder:text-text-faint focus:border-border-bright focus:outline-none"
            />
            <div className="flex gap-2">
                <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="amount"
                    inputMode="decimal"
                    className="h-9 min-w-0 flex-1 border border-border bg-bg-elev-2 px-2 num text-[12px] text-text placeholder:text-text-faint focus:border-border-bright focus:outline-none"
                />
                <button
                    onClick={() => setAmount(formatUsdc(maxWithdraw).replace(/,/g, ""))}
                    className="h-9 border border-border bg-bg-elev-2 px-3 text-[11px] text-text-dim hover:border-border-bright hover:text-text"
                >
                    max
                </button>
            </div>
            <button
                onClick={submit}
                disabled={!valid || state.phase === "sending"}
                className="h-10 w-full border border-border-bright bg-bg-elev-2 text-[12px] font-semibold text-text transition-colors hover:bg-bg-hover disabled:opacity-50"
            >
                {state.phase === "sending" ? "withdrawing…" : "withdraw"}
            </button>
            {state.phase === "done" && (
                <a
                    className="block break-all text-[11px] text-yes underline"
                    href={`https://testnet.arcscan.app/tx/${state.hash}`}
                    target="_blank"
                    rel="noreferrer"
                >
                    sent — view transaction
                </a>
            )}
            {state.phase === "error" && (
                <div className="text-[11px] text-no">{state.message}</div>
            )}
        </div>
    );
}

function CircleConfirmToggle() {
    const { skipConfirm, setSkipConfirm } = useCircleConfirm();
    return (
        <label className="flex cursor-pointer items-center justify-between border border-border bg-bg px-3 py-2 text-[11px] text-text-dim">
            <span className="uppercase tracking-[0.14em] text-text-mute">
                confirm before transactions
            </span>
            <input
                type="checkbox"
                checked={!skipConfirm}
                onChange={(e) => setSkipConfirm(!e.target.checked)}
                className="accent-current"
            />
        </label>
    );
}

/**
 * Getting USDC onto Arc, offered at the moment someone sees a zero balance.
 *
 * Both routes are one tap. The bridge opens as its own dialog rather than
 * expanding in place — a 320px dropdown four borders deep has no room for a
 * two-field form, and the flow outlives this popover anyway.
 */
function TopUpSection({ onBridge }: { onBridge: () => void }) {
    return (
        <div className="border border-border bg-bg px-3 py-3">
            <div className="text-[10px] uppercase tracking-[0.16em] text-text-faint">
                need usdc on arc?
            </div>
            {/* Two-line rows: at 320px a label and a right-aligned hint on one
                line wrap into each other. */}
            <div className="mt-2 grid gap-2">
                <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block border border-border bg-bg-elev-2 px-3 py-2.5 transition-colors hover:border-border-bright"
                >
                    <span className="block text-[12px] text-text-dim transition-colors group-hover:text-text">
                        get from faucet
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-text-faint">
                        free test USDC from Circle
                    </span>
                </a>
                <button
                    onClick={onBridge}
                    className="group block w-full border border-border bg-bg-elev-2 px-3 py-2.5 text-left transition-colors hover:border-border-bright"
                >
                    <span className="block text-[12px] text-text-dim transition-colors group-hover:text-text">
                        bridge from another chain
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-text-faint">
                        move USDC you already hold
                    </span>
                </button>
            </div>
        </div>
    );
}

function ConnectedWalletPanel({
    address,
    kind,
    usdcBal,
    onBridge,
    onDisconnect,
}: {
    address: Address;
    kind: string;
    usdcBal: bigint | undefined;
    onBridge: () => void;
    onDisconnect: () => void;
}) {
    return (
        <div className="px-5 py-5">
            <div className="border border-border bg-bg-elev-2">
                <div className="flex items-center gap-3 border-b border-border px-3 py-3">
                    <span className="flex h-10 w-10 items-center justify-center border border-border-strong bg-bg">
                        <WalletGlyph kind={kind} size="lg" />
                    </span>
                    <div>
                        <div className="text-[13px] font-semibold text-text">
                            {kind === "circle" ? "Circle wallet" : "Connected wallet"}
                        </div>
                        <div className="mt-0.5 text-[11px] text-text-mute">
                            {kind === "circle" ? "Arc wallet provisioned by Circle" : "Arc network"}
                        </div>
                    </div>
                </div>
                <div className="space-y-3 px-3 py-3">
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-text-faint">
                            address
                        </div>
                        <div className="mt-1 break-all num text-[12px] text-text-dim">
                            {address}
                        </div>
                    </div>
                    <div className="flex items-center justify-between border border-border bg-bg px-3 py-2">
                        <span className="text-[11px] uppercase tracking-[0.16em] text-text-mute">
                            balance
                        </span>
                        <span className="num text-[13px] text-text">
                            {usdcBal !== undefined ? formatUsdc(usdcBal) : "—"} USDC
                        </span>
                    </div>
                    {kind === "circle" && <CircleWithdrawSection usdcBal={usdcBal} />}
                    {kind === "circle" && <CircleConfirmToggle />}

                    {/* Two ways to top up, shown where the empty balance is
                        actually discovered. The faucet is the quick path on
                        testnet; the bridge is for people who already hold USDC
                        on another chain. */}
                    <TopUpSection onBridge={onBridge} />
                    <button
                        onClick={onDisconnect}
                        className="h-10 w-full border border-border bg-bg text-[12px] text-text-dim transition-colors hover:border-border-bright hover:bg-bg-hover hover:text-text"
                    >
                        disconnect
                    </button>
                </div>
            </div>
        </div>
    );
}
