"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    useAccount,
    useChainId,
    usePublicClient,
    useSwitchChain,
    useWriteContract,
} from "wagmi";
import { type Address } from "viem";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, factoryAbi } from "@/lib/contracts";

type WithdrawItem = {
    market: Address;
    withdrawable: string;
};

export function WithdrawAllButton({ items }: { items: WithdrawItem[] }) {
    const router = useRouter();
    const publicClient = usePublicClient({ chainId: arcTestnet.id });
    const { address } = useAccount();
    const chainId = useChainId();
    const onArc = chainId === arcTestnet.id;
    const { switchChain } = useSwitchChain();

    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const actionable = useMemo(
        () =>
            items
                .map((i) => ({ market: i.market, withdrawable: BigInt(i.withdrawable) }))
                .filter((i) => i.withdrawable > 0n),
        [items],
    );

    const { writeContractAsync } = useWriteContract();

    async function onWithdrawAll() {
        if (!address) {
            setError("Connect admin wallet");
            return;
        }
        if (!onArc) {
            await switchChain({ chainId: arcTestnet.id });
            return;
        }
        if (!publicClient || actionable.length === 0) return;

        setError(null);
        setDone(0);
        setRunning(true);

        try {
            for (let i = 0; i < actionable.length; i++) {
                const row = actionable[i]!;
                const hash = await writeContractAsync({
                    address: ADDRESSES.factory,
                    abi: factoryAbi,
                    functionName: "withdrawMarketTreasury",
                    args: [row.market, address, row.withdrawable],
                });
                await publicClient.waitForTransactionReceipt({ hash });
                setDone(i + 1);
            }
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "batch withdrawal failed");
        } finally {
            setRunning(false);
        }
    }

    return (
        <div className="flex items-center gap-2">
            <button
                onClick={onWithdrawAll}
                disabled={running || actionable.length === 0}
                className="h-8 px-3 border border-accent/55 bg-accent/10 text-accent text-[10.5px] uppercase tracking-[0.14em] num disabled:opacity-40 rounded-sm"
            >
                {running
                    ? `withdrawing ${done}/${actionable.length}…`
                    : `withdraw all (${actionable.length})`}
            </button>
            {error && <span className="text-[10px] text-no">{error}</span>}
        </div>
    );
}
