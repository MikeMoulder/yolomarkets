import { createPublicClient, http, type Address } from "viem";
import { arcTestnet } from "./chain";
import { ADDRESSES, factoryAbi, marketAbi, Outcome } from "./contracts";

export const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
    batch: { multicall: true },
});

export type MarketSummary = {
    address: Address;
    question: string;
    category: string;
    deadline: bigint;
    priceYes: bigint; // 1e18 = 100%
    totalLiquidity: bigint; // 6-dec
    initialLiquidity: bigint; // 6-dec
    resolved: boolean;
    outcome: Outcome;
    totalSharesYes: bigint;
    totalSharesNo: bigint;
};

export type MarketDetail = MarketSummary & {
    resolutionCriteria: string;
};

export type MarketRevenue = {
    protocolFeeBps: number;
    accruedFees: bigint;
    reserveRequired: bigint;
    treasuryWithdrawable: bigint;
};

async function readMarketSummary(address: Address): Promise<MarketSummary> {
    const r = await publicClient.multicall({
        allowFailure: false,
        contracts: [
            { address, abi: marketAbi, functionName: "question" },
            { address, abi: marketAbi, functionName: "category" },
            { address, abi: marketAbi, functionName: "deadline" },
            { address, abi: marketAbi, functionName: "priceYes" },
            { address, abi: marketAbi, functionName: "totalLiquidity" },
            { address, abi: marketAbi, functionName: "initialLiquidity" },
            { address, abi: marketAbi, functionName: "resolved" },
            { address, abi: marketAbi, functionName: "outcome" },
            { address, abi: marketAbi, functionName: "totalSharesYes" },
            { address, abi: marketAbi, functionName: "totalSharesNo" },
        ],
    });
    return {
        address,
        question: r[0],
        category: r[1],
        deadline: r[2],
        priceYes: r[3],
        totalLiquidity: r[4],
        initialLiquidity: r[5],
        resolved: r[6],
        outcome: r[7] as Outcome,
        totalSharesYes: r[8],
        totalSharesNo: r[9],
    };
}

export async function listMarkets(): Promise<MarketSummary[]> {
    const addrs = (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    if (addrs.length === 0) return [];
    return Promise.all(addrs.map(readMarketSummary));
}

export async function getMarket(address: Address): Promise<MarketDetail | null> {
    try {
        const summary = await readMarketSummary(address);
        const criteria = await publicClient.readContract({
            address,
            abi: marketAbi,
            functionName: "resolutionCriteria",
        });
        return { ...summary, resolutionCriteria: criteria };
    } catch {
        return null;
    }
}

export async function getMarketRevenue(address: Address): Promise<MarketRevenue> {
    try {
        const r = await publicClient.multicall({
            allowFailure: true,
            contracts: [
                { address, abi: marketAbi, functionName: "protocolFeeBps" },
                { address, abi: marketAbi, functionName: "accruedFees" },
                { address, abi: marketAbi, functionName: "reserveRequired" },
                { address, abi: marketAbi, functionName: "treasuryWithdrawable" },
            ],
        });

        return {
            protocolFeeBps:
                r[0]?.status === "success" ? Number((r[0].result as number) ?? 0) : 0,
            accruedFees:
                r[1]?.status === "success" ? (r[1].result as bigint) : 0n,
            reserveRequired:
                r[2]?.status === "success" ? (r[2].result as bigint) : 0n,
            treasuryWithdrawable:
                r[3]?.status === "success" ? (r[3].result as bigint) : 0n,
        };
    } catch {
        return {
            protocolFeeBps: 0,
            accruedFees: 0n,
            reserveRequired: 0n,
            treasuryWithdrawable: 0n,
        };
    }
}

/** Cheap chain-status probe for the footer status indicator. */
export async function chainStatus(): Promise<{ block: bigint; ok: true } | { ok: false }> {
    try {
        const block = await publicClient.getBlockNumber();
        return { block, ok: true };
    } catch {
        return { ok: false };
    }
}
