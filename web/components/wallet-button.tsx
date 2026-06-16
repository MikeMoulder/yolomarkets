"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { isAddress, type Address } from "viem";
import {
    useAccount,
    useConnect,
    useDisconnect,
    useReadContract,
    useSwitchChain,
} from "wagmi";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";
import { useCircleWallet } from "@/lib/circle-session";

type CircleStep =
    | "idle"
    | "starting"
    | "otp"
    | "pin"
    | "wallet"
    | "connected"
    | "error";

type CircleEmailStartResponse = {
    email?: string;
    deviceToken?: string;
    deviceEncryptionKey?: string;
    otpToken?: string;
    error?: string;
    detail?: string;
};

type CircleEmailCompleteResponse = {
    circleUserId?: string;
    challengeId?: string;
    flow?: "login" | "onboarding";
    address?: string | null;
    ready?: boolean;
    wallets?: Array<{
        id?: string;
        address?: string;
        state?: string;
    }>;
    error?: string;
    detail?: string;
};

type CircleEmailLoginResult = {
    userToken: string;
    encryptionKey: string;
    refreshToken?: string;
};

type CircleSdk = {
    getDeviceId: () => Promise<string>;
    updateConfigs: (
        configs: {
            appSettings: { appId: string };
            loginConfigs?: {
                deviceToken: string;
                deviceEncryptionKey: string;
                otpToken?: string;
            };
            authentication?: {
                userToken: string;
                encryptionKey: string;
            };
        },
        onLoginComplete?: (
            error: unknown,
            result?: CircleEmailLoginResult,
        ) => void | Promise<void>,
    ) => void;
    setAuthentication: (auth: {
        userToken: string;
        encryptionKey: string;
    }) => void;
    verifyOtp: () => void;
    execute: (
        challengeId: string,
        onCompleted: (
            error: unknown,
            result?: { status?: string },
        ) => void | Promise<void>,
    ) => void;
};

type CircleWalletResponse = {
    address?: string | null;
    ready?: boolean;
    wallets?: Array<{
        id?: string;
        address?: string;
        state?: string;
    }>;
    error?: string;
    detail?: string;
};

export function WalletButton() {
    const { address, chainId, connector, isConnected } = useAccount();
    const { connectors, connect, isPending } = useConnect();
    const { disconnect } = useDisconnect();
    const { switchChain } = useSwitchChain();
    const { session, connectCircleWallet, disconnectCircleWallet } = useCircleWallet();

    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [circleEmail, setCircleEmail] = useState("");
    const [circleStep, setCircleStep] = useState<CircleStep>("idle");
    const [circleError, setCircleError] = useState<string | null>(null);

    useEffect(() => setMounted(true), []);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") setOpen(false);
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = overflow;
        };
    }, [open]);

    const activeAddress = useMemo(() => {
        if (isConnected && address) return address;
        return session?.address ?? null;
    }, [address, isConnected, session?.address]);

    const activeKind =
        isConnected && address ? (connector?.name ?? "wallet") : session ? "circle" : null;

    const { data: usdcBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
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

    const wrongChain = isConnected && chainId !== arcTestnet.id;

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

    async function connectWithCircle() {
        setCircleError(null);
        setCircleStep("starting");

        const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
        if (!appId) {
            setCircleStep("error");
            setCircleError("NEXT_PUBLIC_CIRCLE_APP_ID is missing.");
            return;
        }

        try {
            const email = circleEmail.trim().toLowerCase();
            if (!email) {
                throw new Error("Email is required for Circle OTP login.");
            }

            const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
            const sdk = new W3SSdk({
                appSettings: { appId },
            }) as CircleSdk;
            const deviceId = await sdk.getDeviceId();

            const startRes = await fetch("/api/circle/email/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, deviceId }),
            });
            const start = (await startRes.json().catch(() => ({}))) as CircleEmailStartResponse;
            if (
                !startRes.ok ||
                !start.deviceToken ||
                !start.deviceEncryptionKey ||
                !start.otpToken
            ) {
                throw new Error(start.detail ?? start.error ?? "Circle email OTP failed.");
            }

            setCircleStep("otp");
            const auth = await verifyCircleEmailOtp(sdk, {
                appId,
                deviceToken: start.deviceToken,
                deviceEncryptionKey: start.deviceEncryptionKey,
                otpToken: start.otpToken,
            });

            const completeRes = await fetch("/api/circle/email/complete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, userToken: auth.userToken }),
            });
            const complete = (await completeRes.json().catch(() => ({}))) as CircleEmailCompleteResponse;
            if (!completeRes.ok || !complete.circleUserId) {
                throw new Error(
                    complete.detail ??
                        complete.error ??
                        "Circle email login completion failed.",
                );
            }

            if (complete.challengeId) {
                setCircleStep("pin");
                sdk.setAuthentication({
                    userToken: auth.userToken,
                    encryptionKey: auth.encryptionKey,
                });
                await executeCircleChallenge(sdk, complete.challengeId);
            }

            setCircleStep("wallet");
            const wallet = complete.address
                ? complete
                : await pollCircleWallet(complete.circleUserId, auth.userToken);
            if (!wallet.address || !isAddress(wallet.address)) {
                throw new Error("Circle did not return a wallet address yet.");
            }

            const normalizedAddress = wallet.address.toLowerCase() as Address;
            const primary = wallet.wallets?.find(
                (w) => w.address?.toLowerCase() === normalizedAddress,
            );
            connectCircleWallet({
                address: normalizedAddress,
                circleUserId: complete.circleUserId,
                walletId: primary?.id ?? null,
                email,
            });
            disconnect();
            setCircleStep("connected");
            setOpen(false);
        } catch (e) {
            setCircleError(formatCircleError(e));
            setCircleStep("error");
            setOpen(true);
        }
    }

    const buttonLabel = activeAddress
        ? shortAddr(activeAddress)
        : isPending
            ? "connecting..."
            : "connect wallet";

    const modal = open
        ? createPortal(
            <div
                className="fixed inset-0 z-[100] grid min-h-dvh place-items-center overflow-y-auto bg-black/68 px-4 py-6 backdrop-blur-md"
                role="dialog"
                aria-modal="true"
                aria-labelledby="wallet-modal-title"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setOpen(false);
                }}
            >
                <div className="w-full max-w-[480px] max-h-[calc(100dvh-48px)] overflow-y-auto border border-border-strong bg-bg-elev shadow-2xl shadow-black/60">
                    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                sign in
                            </div>
                            <h2
                                id="wallet-modal-title"
                                className="mt-1 text-[18px] font-semibold text-text"
                            >
                                Connect wallet
                            </h2>
                        </div>
                        <button
                            onClick={() => setOpen(false)}
                            className="flex h-8 w-8 items-center justify-center border border-border bg-bg-elev-2 text-text-mute transition-colors hover:bg-bg-hover hover:text-text"
                            aria-label="Close wallet modal"
                        >
                            <CloseGlyph />
                        </button>
                    </div>

                    {activeAddress ? (
                        <ConnectedWalletPanel
                            address={activeAddress}
                            kind={activeKind ?? "wallet"}
                            usdcBal={usdcBal}
                            onDisconnect={() => {
                                if (isConnected) disconnect();
                                disconnectCircleWallet();
                                setCircleStep("idle");
                                setOpen(false);
                            }}
                        />
                    ) : (
                        <div className="space-y-4 px-5 py-5">
                            <div className="space-y-2">
                                <CircleWalletOption
                                    email={circleEmail}
                                    setEmail={setCircleEmail}
                                    step={circleStep}
                                    error={circleError}
                                    onSubmit={connectWithCircle}
                                />
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="h-px flex-1 bg-border" />
                                <span className="text-[10px] uppercase tracking-[0.18em] text-text-faint">
                                    or
                                </span>
                                <div className="h-px flex-1 bg-border" />
                            </div>

                            <div className="space-y-2">
                                {connectors.map((connector) => (
                                    <button
                                        key={connector.uid}
                                        onClick={() => {
                                            disconnectCircleWallet();
                                            connect({ connector });
                                            setOpen(false);
                                        }}
                                        disabled={isPending}
                                        className="group flex w-full items-center gap-3 border border-border bg-bg-elev-2 px-3 py-3 text-left transition-colors hover:border-border-bright hover:bg-bg-hover disabled:opacity-50"
                                    >
                                        <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-border-strong bg-bg">
                                            <WalletGlyph kind={connector.name} size="lg" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-[13px] font-medium text-text">
                                                {connector.name}
                                            </span>
                                            <span className="mt-0.5 block text-[11px] text-text-mute">
                                                {connectorHint(connector.name)}
                                            </span>
                                        </span>
                                        <ArrowGlyph />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>,
            document.body,
        )
        : null;

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                className="flex h-8 items-center gap-2 border border-border-strong bg-bg-elev px-3 text-[12px] text-text transition-colors hover:border-border-bright hover:bg-bg-hover"
            >
                <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border-bright bg-bg-elev-2">
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

            {modal}
        </>
    );
}

function verifyCircleEmailOtp(
    sdk: CircleSdk,
    opts: {
        appId: string;
        deviceToken: string;
        deviceEncryptionKey: string;
        otpToken: string;
    },
) {
    return new Promise<CircleEmailLoginResult>((resolve, reject) => {
        sdk.updateConfigs(
            {
                appSettings: { appId: opts.appId },
                loginConfigs: {
                    deviceToken: opts.deviceToken,
                    deviceEncryptionKey: opts.deviceEncryptionKey,
                    otpToken: opts.otpToken,
                },
            },
            (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (!result?.userToken || !result.encryptionKey) {
                    reject(new Error("Circle email verification returned no session."));
                    return;
                }
                resolve({
                    userToken: result.userToken,
                    encryptionKey: result.encryptionKey,
                    refreshToken: result.refreshToken,
                });
            },
        );
        sdk.verifyOtp();
    });
}

function executeCircleChallenge(sdk: CircleSdk, challengeId: string) {
    return new Promise<void>((resolve, reject) => {
        sdk.execute(challengeId, (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            const status = String(result?.status ?? "").toUpperCase();
            if (
                status === "COMPLETE" ||
                status === "IN_PROGRESS" ||
                status === "PENDING"
            ) {
                resolve();
                return;
            }
            if (status === "FAILED" || status === "EXPIRED") {
                reject(
                    new Error(
                        `Circle challenge ended with ${status.toLowerCase()}.`,
                    ),
                );
                return;
            }
            reject(new Error("Circle challenge returned no completion status."));
        });
    });
}

async function pollCircleWallet(circleUserId: string, userToken: string) {
    let last: CircleWalletResponse | null = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
        const res = await fetch("/api/circle/wallet", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ circleUserId, userToken }),
        });
        const body = (await res.json().catch(() => ({}))) as CircleWalletResponse;
        last = body;
        if (res.ok && body.ready && body.address) return body;
        if (!res.ok) {
            throw new Error(body.detail ?? body.error ?? "Circle wallet lookup failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(last?.detail ?? "Circle wallet is still provisioning. Try again in a moment.");
}

function formatCircleError(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
        const candidate = error as {
            message?: unknown;
            code?: unknown;
            error?: unknown;
            detail?: unknown;
        };
        const message =
            typeof candidate.message === "string"
                ? candidate.message
                : typeof candidate.detail === "string"
                    ? candidate.detail
                    : typeof candidate.error === "string"
                        ? candidate.error
                        : null;
        if (message) {
            return candidate.code !== undefined
                ? `Circle ${String(candidate.code)}: ${message}`
                : message;
        }
    }
    return "Circle wallet login failed.";
}

function CircleWalletOption({
    email,
    setEmail,
    step,
    error,
    onSubmit,
}: {
    email: string;
    setEmail: (value: string) => void;
    step: CircleStep;
    error: string | null;
    onSubmit: () => void;
}) {
    const busy =
        step === "starting" ||
        step === "otp" ||
        step === "pin" ||
        step === "wallet";
    return (
        <form
            className="border border-accent/35 bg-accent-bg"
            onSubmit={(event) => {
                event.preventDefault();
                if (!busy) onSubmit();
            }}
        >
            <div className="flex items-start gap-3 px-3 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-accent/35 bg-bg">
                    <WalletGlyph kind="circle" size="lg" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-text">
                        Circle wallet
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-mute">
                        {busy
                            ? circleStepDescription(step)
                            : "Email login with a one-time code from Circle."}
                    </div>
                </div>
            </div>
            <div className="grid gap-2 border-t border-accent/20 px-3 pb-3 pt-2 sm:grid-cols-[1fr_auto]">
                <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    type="email"
                    placeholder="email"
                    required
                    className="h-10 min-w-0 border border-border bg-bg px-3 text-[13px] text-text outline-none transition-colors placeholder:text-text-faint focus:border-accent/70"
                />
                <button
                    type="submit"
                    disabled={busy}
                    className="h-10 border border-accent/50 bg-accent px-4 text-[12px] font-semibold text-bg transition-colors hover:bg-accent-dim disabled:opacity-55"
                >
                    {circleStepLabel(step)}
                </button>
            </div>
            {error && (
                <div className="border-t border-no/20 px-3 py-2 text-[11px] text-no">
                    {error}
                </div>
            )}
        </form>
    );
}

function ConnectedWalletPanel({
    address,
    kind,
    usdcBal,
    onDisconnect,
}: {
    address: Address;
    kind: string;
    usdcBal: bigint | undefined;
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

function circleStepLabel(step: CircleStep) {
    switch (step) {
        case "starting":
            return "starting...";
        case "otp":
            return "verify code...";
        case "pin":
            return "waiting...";
        case "wallet":
            return "provisioning...";
        case "connected":
            return "connected";
        default:
            return "continue";
    }
}

function circleStepDescription(step: CircleStep) {
    switch (step) {
        case "starting":
            return "Starting Circle email login...";
        case "otp":
            return "Enter the one-time code Circle sent to your email.";
        case "pin":
            return "Complete Circle wallet setup to continue.";
        case "wallet":
            return "Fetching your Arc wallet address...";
        default:
            return "Email login with a one-time code from Circle.";
    }
}

function connectorHint(name: string) {
    const normalized = name.toLowerCase();
    if (normalized.includes("walletconnect")) return "Scan with a mobile wallet.";
    if (normalized.includes("coinbase")) return "Use Coinbase Wallet.";
    if (normalized.includes("rabby")) return "Use Rabby Wallet.";
    if (normalized.includes("keplr")) return "Use Keplr.";
    if (normalized.includes("okx")) return "Use OKX Wallet.";
    if (normalized.includes("phantom")) return "Use Phantom.";
    if (normalized.includes("injected")) return "Use your browser wallet.";
    if (normalized.includes("metamask")) return "Use MetaMask.";
    return "Connect an external wallet.";
}

function WalletGlyph({
    kind,
    size = "md",
}: {
    kind: string;
    size?: "sm" | "md" | "lg";
}) {
    const normalized = kind.toLowerCase();
    if (normalized.includes("circle")) {
        return <WalletImage src="/circle-icon.png" alt="" size={size} />;
    }
    if (normalized.includes("coinbase")) {
        return <WalletImage src="/coinbase.png" alt="" size={size} />;
    }
    if (normalized.includes("rabby")) {
        return <WalletImage src="/rabby.png" alt="" size={size} />;
    }
    if (normalized.includes("keplr")) {
        return <WalletImage src="/Keplr.png" alt="" size={size} />;
    }
    if (normalized.includes("okx")) {
        return <WalletImage src="/OKX.png" alt="" size={size} />;
    }
    if (normalized.includes("phantom")) {
        return <WalletImage src="/Phantom.png" alt="" size={size} />;
    }
    if (normalized.includes("injected") || normalized.includes("metamask")) {
        return <WalletImage src="/metamask.svg" alt="" size={size} />;
    }
    return <GenericWalletGlyph size={size} />;
}

function WalletImage({
    src,
    alt,
    size,
}: {
    src: string;
    alt: string;
    size: "sm" | "md" | "lg";
}) {
    const className =
        size === "lg"
            ? "h-[25px] w-[25px] object-contain"
            : size === "sm"
                ? "h-4 w-4 object-contain"
                : "h-5 w-5 object-contain";
    return (
        <Image
            src={src}
            alt={alt}
            width={25}
            height={25}
            className={className}
            draggable={false}
        />
    );
}

function GenericWalletGlyph({ size }: { size: "sm" | "md" | "lg" }) {
    const className =
        size === "lg"
            ? "h-[25px] w-[25px] text-text-dim"
            : size === "sm"
                ? "h-4 w-4 text-text-dim"
                : "h-5 w-5 text-text-dim";
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
            <path
                d="M5 8h13.5a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 18.5 17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h12M16 12.5h.1"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    );
}

function ArrowGlyph() {
    return (
        <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-4 w-4 text-text-faint transition-colors group-hover:text-text-dim"
        >
            <path
                d="M9 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    );
}

function CloseGlyph() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
            <path
                d="m7 7 10 10M17 7 7 17"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
        </svg>
    );
}
