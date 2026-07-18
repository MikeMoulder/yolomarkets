"use client";

import { useCallback } from "react";
import { useCircleWallet } from "@/lib/circle-session";
import { useCircleConfirm, type CircleTxSummary } from "@/lib/circle-confirm";
import { formatUsdc, shortAddr } from "@/lib/format";

export type CircleContractCall = {
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
};

// Human-readable summary of a contract call for the confirm dialog. Params
// arrive as decimal strings (bet-ticket stringifies bigints).
function describeCall(call: CircleContractCall): CircleTxSummary {
    const p = call.abiParameters.map(String);
    const usdc = (v: string) => {
        const n = BigInt(v);
        // Effectively-unlimited approvals read as "unlimited", not a number.
        return n > 10n ** 15n ? "unlimited" : `${formatUsdc(n)} USDC`;
    };
    const shares = (v: string) => `${formatUsdc(BigInt(v))} shares`;
    const side = (v: string) => (v === "1" ? "YES" : "NO");
    switch (call.abiFunctionSignature) {
        case "approve(address,uint256)":
            return {
                title: "Approve USDC",
                lines: [
                    { label: "spender", value: shortAddr(p[0] ?? "") },
                    { label: "amount", value: usdc(p[1] ?? "0") },
                ],
            };
        case "buy(uint8,uint256,uint256)":
            return {
                title: `Buy ${side(p[0] ?? "")} shares`,
                lines: [
                    { label: "market", value: shortAddr(call.contractAddress) },
                    { label: "shares", value: shares(p[1] ?? "0") },
                    { label: "max cost", value: usdc(p[2] ?? "0") },
                ],
            };
        case "sell(uint8,uint256,uint256)":
            return {
                title: `Sell ${side(p[0] ?? "")} shares`,
                lines: [
                    { label: "market", value: shortAddr(call.contractAddress) },
                    { label: "shares", value: shares(p[1] ?? "0") },
                    { label: "min received", value: usdc(p[2] ?? "0") },
                ],
            };
        case "claim()":
            return {
                title: "Claim winnings",
                lines: [{ label: "market", value: shortAddr(call.contractAddress) }],
            };
        default:
            return {
                title: call.abiFunctionSignature,
                lines: [{ label: "contract", value: shortAddr(call.contractAddress) }],
            };
    }
}

async function pollTxHash(txId: string): Promise<`0x${string}`> {
    // Circle SCA transactions on Arc usually confirm within seconds; cap ~90s.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const res = await fetch("/api/circle/tx-hash", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ txId }),
        });
        const body = (await res.json().catch(() => ({}))) as {
            txHash?: string;
            error?: string;
            detail?: string;
        };
        if (res.ok && body.txHash) return body.txHash as `0x${string}`;
        if (res.status !== 202) {
            throw new Error(body.detail ?? body.error ?? "Circle transaction failed.");
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(
        "Circle transaction did not confirm in time. Check your portfolio in a moment.",
    );
}

/**
 * Executes contract calls / withdrawals from the user's Circle wallet and
 * resolves with the confirmed on-chain transaction hash. The hash is already
 * mined when this returns, so callers can feed it straight into wagmi's
 * useWaitForTransactionReceipt (which resolves immediately) and reuse their
 * existing post-confirmation flow.
 *
 * Since 2026-07-18 user wallets are Developer-Controlled (custodial): the
 * server signs via Circle's entity secret, authorized by the user's email-OTP
 * session token. Because there is no wallet popup, every operation first goes
 * through the in-app confirm dialog (skippable via "don't ask again").
 */
export function useCirclePayment() {
    const { session } = useCircleWallet();
    const { confirmCircleTx } = useCircleConfirm();

    const payViaCircle = useCallback(
        async (call: CircleContractCall): Promise<`0x${string}`> => {
            if (!session?.walletId || !session.userToken) {
                throw new Error(
                    "Circle wallet session expired — reconnect your wallet.",
                );
            }

            const ok = await confirmCircleTx(describeCall(call));
            if (!ok) throw new Error("Transaction cancelled.");

            const execRes = await fetch("/api/circle/execute-tx", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    userToken: session.userToken,
                    walletId: session.walletId,
                    ...call,
                }),
            });
            const exec = (await execRes.json().catch(() => ({}))) as {
                txId?: string;
                error?: string;
                detail?: string;
                needsReconnect?: boolean;
            };
            if (execRes.status === 401 || execRes.status === 403 || exec.needsReconnect) {
                throw new Error(
                    "Circle wallet session expired — reconnect your wallet.",
                );
            }
            if (!execRes.ok || !exec.txId) {
                throw new Error(
                    exec.detail ?? exec.error ?? "Failed to start Circle transaction.",
                );
            }
            return pollTxHash(exec.txId);
        },
        [confirmCircleTx, session],
    );

    // Withdraw has its own explicit form, which already acts as the
    // confirmation step — no extra confirm dialog on top.
    const withdrawViaCircle = useCallback(
        async (destinationAddress: string, amountMicro: bigint): Promise<`0x${string}`> => {
            if (!session?.walletId || !session.userToken) {
                throw new Error(
                    "Circle wallet session expired — reconnect your wallet.",
                );
            }
            const res = await fetch("/api/circle/withdraw", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    userToken: session.userToken,
                    walletId: session.walletId,
                    destinationAddress,
                    amountMicro: amountMicro.toString(),
                }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                txId?: string;
                error?: string;
                detail?: string;
                needsReconnect?: boolean;
            };
            if (res.status === 401 || res.status === 403 || body.needsReconnect) {
                throw new Error(
                    "Circle wallet session expired — reconnect your wallet.",
                );
            }
            if (!res.ok || !body.txId) {
                throw new Error(body.detail ?? body.error ?? "Withdraw failed.");
            }
            return pollTxHash(body.txId);
        },
        [session],
    );

    return { payViaCircle, withdrawViaCircle };
}
