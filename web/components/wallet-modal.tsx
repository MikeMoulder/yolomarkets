"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { isAddress, type Address } from "viem";
import { useConnect, useDisconnect } from "wagmi";
import { useCircleWallet } from "@/lib/circle-session";
import { circlePairFingerprint } from "@/lib/circle-diag";
import { useActiveWallet } from "@/lib/use-active-wallet";

// TEMPORARY 155118 diagnostics: mirrors each login step into the server diag
// file (fire-and-forget) so the whole trace is readable in one place.
function diag(line: string) {
    console.log(`[circle-diag] ${line}`);
    void fetch("/api/circle/diag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line }),
    }).catch(() => {});
}

function describeCircleError(error: unknown): string {
    if (error && typeof error === "object") {
        const e = error as { code?: unknown; message?: unknown };
        return `code=${String(e.code)} msg=${String(e.message)}`;
    }
    return String(error);
}
import { ArrowGlyph, CloseGlyph, WalletGlyph } from "./wallet-glyphs";

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

type WalletModalContextValue = {
    openWalletModal: () => void;
    closeWalletModal: () => void;
};

const WalletModalContext = createContext<WalletModalContextValue | null>(null);

/** Global access to the connect-wallet modal. Any component below the
 *  provider (bet ticket, market grid, header button, …) can summon it. */
export function useWalletModal(): WalletModalContextValue {
    const ctx = useContext(WalletModalContext);
    if (!ctx) {
        throw new Error("useWalletModal must be used inside WalletModalProvider");
    }
    return ctx;
}

export function WalletModalProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const { isConnected } = useActiveWallet();

    useEffect(() => setMounted(true), []);

    const openWalletModal = useCallback(() => setOpen(true), []);
    const closeWalletModal = useCallback(() => setOpen(false), []);

    // A successful connection (from any path) dismisses the modal.
    useEffect(() => {
        if (open && isConnected) setOpen(false);
    }, [open, isConnected]);

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

    return (
        <WalletModalContext.Provider value={{ openWalletModal, closeWalletModal }}>
            {children}
            {mounted && open && !isConnected
                ? createPortal(
                    <ConnectWalletModal onClose={closeWalletModal} />,
                    document.body,
                )
                : null}
        </WalletModalContext.Provider>
    );
}

function ConnectWalletModal({ onClose }: { onClose: () => void }) {
    const { connectors, connect, isPending } = useConnect();
    const { disconnect } = useDisconnect();
    const { connectCircleWallet, disconnectCircleWallet } = useCircleWallet();

    const [circleEmail, setCircleEmail] = useState("");
    const [circleStep, setCircleStep] = useState<CircleStep>("idle");
    const [circleError, setCircleError] = useState<string | null>(null);

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
            diag(`login step1 deviceId=${deviceId.slice(0, 10)}`);

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

            diag(
                `login step2 start OK devTok=${start.deviceToken.slice(0, 8)} devKey=${start.deviceEncryptionKey.slice(0, 6)} otpTok=${start.otpToken.slice(0, 8)}`,
            );

            setCircleStep("otp");
            let auth: CircleEmailLoginResult;
            try {
                auth = await verifyCircleEmailOtp(sdk, {
                    appId,
                    deviceToken: start.deviceToken,
                    deviceEncryptionKey: start.deviceEncryptionKey,
                    otpToken: start.otpToken,
                });
            } catch (e) {
                diag(`login step3 verifyOtp FAILED ${describeCircleError(e)}`);
                throw e;
            }
            diag(
                `login step3 verifyOtp OK pair=[${circlePairFingerprint(
                    auth.userToken,
                    auth.encryptionKey,
                )}] refreshTok=${auth.refreshToken ? auth.refreshToken.slice(0, 8) : "MISSING"}`,
            );

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

            diag(
                `login step4 complete flow=${complete.flow} user=${String(
                    complete.circleUserId,
                ).slice(0, 8)} address=${complete.address ?? "none"}`,
            );

            // Developer-controlled wallets are provisioned synchronously by
            // the complete route — no PIN challenge, address always present.
            setCircleStep("wallet");
            if (!complete.address || !isAddress(complete.address)) {
                throw new Error("Circle did not return a wallet address yet.");
            }

            const normalizedAddress = complete.address.toLowerCase() as Address;
            const primary = complete.wallets?.find(
                (w) => w.address?.toLowerCase() === normalizedAddress,
            );
            connectCircleWallet({
                address: normalizedAddress,
                circleUserId: complete.circleUserId,
                walletId: primary?.id ?? null,
                email,
                userToken: auth.userToken,
                encryptionKey: auth.encryptionKey,
                refreshToken: auth.refreshToken ?? null,
            });
            disconnect();
            setCircleStep("connected");
            onClose();
        } catch (e) {
            diag(`login ABORTED ${describeCircleError(e)}`);
            setCircleError(formatCircleError(e));
            setCircleStep("error");
        }
    }

    return (
        <div
            className="fixed inset-0 z-[100] grid min-h-dvh place-items-center overflow-y-auto bg-black/68 px-4 py-6 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
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
                        onClick={onClose}
                        className="flex h-8 w-8 items-center justify-center border border-border bg-bg-elev-2 text-text-mute transition-colors hover:bg-bg-hover hover:text-text"
                        aria-label="Close wallet modal"
                    >
                        <CloseGlyph />
                    </button>
                </div>

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
                                    onClose();
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
            </div>
        </div>
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
