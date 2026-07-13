"use client";

import { useCallback } from "react";
import { useCircleWallet } from "@/lib/circle-session";

// Minimal slice of the Circle Web SDK surface we drive. The full type lives in
// @circle-fin/w3s-pw-web-sdk; we only need PIN-confirm of an existing challenge.
type CircleSdk = {
    getDeviceId: () => Promise<string>;
    setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void;
    execute: (
        challengeId: string,
        onCompleted: (error: unknown, result?: { status?: string }) => void,
    ) => void;
};

// Circle SDK errors aren't Error instances — they're objects like
// { code, message }. Unwrap them so the UI shows the real reason instead of a
// generic fallback.
function formatCircleError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
        const e = error as { message?: unknown; code?: unknown; detail?: unknown };
        const message =
            (typeof e.message === "string" && e.message) ||
            (typeof e.detail === "string" && e.detail) ||
            null;
        if (message) {
            return e.code !== undefined ? `Circle ${String(e.code)}: ${message}` : message;
        }
    }
    return "Circle transaction failed.";
}

export type CircleContractCall = {
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
};

/**
 * Executes a contract call from the user's Circle (email/OTP) wallet and
 * resolves with the confirmed on-chain transaction hash. The hash is already
 * mined when this returns, so callers can feed it straight into wagmi's
 * useWaitForTransactionReceipt (which resolves immediately) and reuse their
 * existing post-confirmation flow.
 */
export function useCirclePayment() {
    const { session } = useCircleWallet();

    const payViaCircle = useCallback(
        async (call: CircleContractCall): Promise<`0x${string}`> => {
            if (!session?.walletId || !session.userToken || !session.encryptionKey) {
                throw new Error(
                    "Circle wallet session expired — reconnect your wallet.",
                );
            }
            const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
            if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID is missing.");

            const { userToken, encryptionKey, walletId } = session;
            const sinceMs = Date.now();

            const execRes = await fetch("/api/circle/execute-tx", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ userToken, walletId, ...call }),
            });
            const exec = (await execRes.json().catch(() => ({}))) as {
                challengeId?: string;
                error?: string;
                detail?: string;
            };
            if (!execRes.ok || !exec.challengeId) {
                throw new Error(
                    exec.detail ?? exec.error ?? "Failed to start Circle transaction.",
                );
            }

            const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
            const sdk = new W3SSdk({ appSettings: { appId } }) as unknown as CircleSdk;
            // Initialize the device context before authenticating — the SDK
            // needs it to render the PIN challenge (mirrors the login flow).
            await sdk.getDeviceId();
            sdk.setAuthentication({ userToken, encryptionKey });

            await new Promise<void>((resolve, reject) => {
                sdk.execute(exec.challengeId!, (error, result) => {
                    if (error) {
                        console.error("[circle] challenge execute failed:", error);
                        reject(new Error(formatCircleError(error)));
                        return;
                    }
                    const status = String(result?.status ?? "").toUpperCase();
                    if (status === "FAILED" || status === "EXPIRED") {
                        reject(new Error(`Circle challenge ${status.toLowerCase()}.`));
                        return;
                    }
                    resolve();
                });
            });

            // Each tx-hash call is capped under the serverless time limit, so
            // retry a few windows for slower confirmations.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const res = await fetch("/api/circle/tx-hash", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ userToken, walletId, sinceMs }),
                });
                const body = (await res.json().catch(() => ({}))) as {
                    txHash?: string;
                    error?: string;
                    detail?: string;
                };
                if (res.ok && body.txHash) return body.txHash as `0x${string}`;
                if (res.status !== 504) {
                    throw new Error(
                        body.detail ?? body.error ?? "Circle transaction lookup failed.",
                    );
                }
            }
            throw new Error(
                "Circle transaction did not confirm in time. Check your portfolio in a moment.",
            );
        },
        [session],
    );

    return { payViaCircle };
}
