"use client";

import { useState } from "react";
import {
    useAccount,
    useReadContract,
    useWriteContract,
    useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits } from "viem";
import { ADDRESSES, agentAccountAbi, erc20Abi } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";

/** Settings-page widget for the user's deployed AgentAccount.
 *  Shows balance, an arcscan link, and lets them deposit USDC from their
 *  main wallet or withdraw it back. */
export function AgentAccountCard({
    agentAddress,
}: {
    agentAddress: `0x${string}`;
}) {
    const { address: ownerAddr } = useAccount();
    const [mode, setMode] = useState<"deposit" | "withdraw" | null>(null);

    const { data: agentBal, refetch: refetchAgentBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agentAddress],
        query: { refetchInterval: 8000 },
    });
    const { data: ownerBal, refetch: refetchOwnerBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: ownerAddr ? [ownerAddr] : undefined,
        query: { enabled: !!ownerAddr, refetchInterval: 8000 },
    });

    function onTxConfirmed() {
        void refetchAgentBal();
        void refetchOwnerBal();
        setMode(null);
    }

    return (
        <div className="border border-yes/25 bg-yes/[0.03] px-5 py-5">
            <div className="flex items-center justify-between gap-4 mb-4">
                <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-yes num">
                        / agent account · live on arc
                    </div>
                    <a
                        href={`https://testnet.arcscan.app/address/${agentAddress}`}
                        target="_blank"
                        rel="noreferrer"
                        className="num text-[12.5px] text-text hover:text-accent transition-colors break-all mt-1 block"
                    >
                        {shortAddr(agentAddress, 8)}
                    </a>
                </div>
                <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        balance
                    </div>
                    <div className="num text-[24px] tabular text-text leading-none mt-1">
                        ${agentBal !== undefined ? formatUsdc(agentBal) : "—"}
                    </div>
                </div>
            </div>

            <div className="flex gap-2">
                <button
                    onClick={() => setMode("deposit")}
                    className="flex-1 h-9 border border-yes/40 bg-bg/40 text-yes text-[12px] uppercase tracking-[0.18em] num hover:bg-yes/10 transition-colors"
                >
                    deposit USDC →
                </button>
                <button
                    onClick={() => setMode("withdraw")}
                    disabled={agentBal === undefined || agentBal === 0n}
                    className="flex-1 h-9 border border-border-strong bg-bg/40 text-text-dim text-[12px] uppercase tracking-[0.18em] num hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-40"
                >
                    ← withdraw
                </button>
            </div>

            {mode === "deposit" && (
                <DepositForm
                    agentAddress={agentAddress}
                    ownerBalance={ownerBal ?? 0n}
                    onConfirmed={onTxConfirmed}
                    onCancel={() => setMode(null)}
                />
            )}
            {mode === "withdraw" && ownerAddr && (
                <WithdrawForm
                    agentAddress={agentAddress}
                    ownerAddr={ownerAddr}
                    agentBalance={agentBal ?? 0n}
                    onConfirmed={onTxConfirmed}
                    onCancel={() => setMode(null)}
                />
            )}
        </div>
    );
}

// ── Deposit: owner EOA → USDC.transfer(agent, amount) ────────────────────

function DepositForm({
    agentAddress,
    ownerBalance,
    onConfirmed,
    onCancel,
}: {
    agentAddress: `0x${string}`;
    ownerBalance: bigint;
    onConfirmed: () => void;
    onCancel: () => void;
}) {
    const [amount, setAmount] = useState("5");
    const { writeContract, data: txHash, isPending, error, reset } =
        useWriteContract();
    const { isLoading: confirming, isSuccess } =
        useWaitForTransactionReceipt({ hash: txHash });

    if (isSuccess) {
        setTimeout(onConfirmed, 250);
    }

    const parsed = safeParseUsdc(amount);
    const tooMuch = parsed !== null && parsed > ownerBalance;
    const valid = parsed !== null && parsed > 0n && !tooMuch;

    function submit() {
        if (!valid) return;
        reset();
        writeContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "transfer",
            args: [agentAddress, parsed],
        });
    }

    return (
        <div className="mt-4 border-t border-yes/15 pt-4">
            <ActionRow
                label="Deposit"
                sub={`from your wallet · $${formatUsdc(ownerBalance)} available`}
                amount={amount}
                onAmount={setAmount}
                onCancel={onCancel}
                onSubmit={submit}
                disabled={!valid || isPending || confirming}
                busy={isPending || confirming}
                error={
                    error
                        ? error.message.split("\n")[0]
                        : tooMuch
                            ? "more than wallet balance"
                            : null
                }
                cta={confirming ? "confirming…" : "send →"}
            />
        </div>
    );
}

// ── Withdraw: AgentAccount.withdraw(USDC, amount, owner) ─────────────────

function WithdrawForm({
    agentAddress,
    ownerAddr,
    agentBalance,
    onConfirmed,
    onCancel,
}: {
    agentAddress: `0x${string}`;
    ownerAddr: `0x${string}`;
    agentBalance: bigint;
    onConfirmed: () => void;
    onCancel: () => void;
}) {
    const [amount, setAmount] = useState(formatUsdc(agentBalance));
    const { writeContract, data: txHash, isPending, error, reset } =
        useWriteContract();
    const { isLoading: confirming, isSuccess } =
        useWaitForTransactionReceipt({ hash: txHash });

    if (isSuccess) {
        setTimeout(onConfirmed, 250);
    }

    const parsed = safeParseUsdc(amount);
    const tooMuch = parsed !== null && parsed > agentBalance;
    const valid = parsed !== null && parsed > 0n && !tooMuch;

    function submit() {
        if (!valid) return;
        reset();
        writeContract({
            address: agentAddress,
            abi: agentAccountAbi,
            functionName: "withdraw",
            args: [ADDRESSES.usdc, parsed, ownerAddr],
        });
    }

    return (
        <div className="mt-4 border-t border-border pt-4">
            <ActionRow
                label="Withdraw"
                sub={`to your wallet · $${formatUsdc(agentBalance)} in agent`}
                amount={amount}
                onAmount={setAmount}
                onCancel={onCancel}
                onSubmit={submit}
                disabled={!valid || isPending || confirming}
                busy={isPending || confirming}
                error={
                    error
                        ? error.message.split("\n")[0]
                        : tooMuch
                            ? "more than agent balance"
                            : null
                }
                cta={confirming ? "confirming…" : "withdraw →"}
            />
        </div>
    );
}

// ── Shared row ───────────────────────────────────────────────────────────

function ActionRow({
    label,
    sub,
    amount,
    onAmount,
    onCancel,
    onSubmit,
    disabled,
    busy,
    error,
    cta,
}: {
    label: string;
    sub: string;
    amount: string;
    onAmount: (v: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
    disabled: boolean;
    busy: boolean;
    error: string | null;
    cta: string;
}) {
    return (
        <div>
            <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-text-mute num">
                    / {label}
                </span>
                <span className="text-[11px] text-text-faint num">{sub}</span>
            </div>
            <div className="flex items-stretch gap-2">
                <div className="flex-1 flex items-baseline gap-2 border border-border bg-bg-elev px-3 py-2">
                    <span className="num text-[12px] text-text-mute">$</span>
                    <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={amount}
                        onChange={(e) => onAmount(e.target.value)}
                        className="num text-[18px] bg-transparent border-0 outline-none w-full tabular text-text"
                        disabled={busy}
                    />
                    <span className="text-[10px] text-text-faint num">USDC</span>
                </div>
                <button
                    onClick={onCancel}
                    disabled={busy}
                    className="px-3 text-[11px] text-text-mute hover:text-text border border-border transition-colors num uppercase tracking-[0.18em]"
                >
                    cancel
                </button>
                <button
                    onClick={onSubmit}
                    disabled={disabled}
                    className="px-4 text-[12px] uppercase tracking-[0.18em] num border border-accent bg-accent-bg text-accent hover:bg-accent/15 disabled:opacity-40 transition-colors"
                >
                    {cta}
                </button>
            </div>
            {error && (
                <div className="mt-2 text-[11px] text-no">{error}</div>
            )}
        </div>
    );
}

function safeParseUsdc(input: string): bigint | null {
    const v = input.trim();
    if (!v) return null;
    if (!/^\d*\.?\d*$/.test(v)) return null;
    try {
        return parseUnits(v, 6);
    } catch {
        return null;
    }
}
