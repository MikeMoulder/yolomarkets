import { createPublicClient, fallback, http, type Address } from "viem";
import { arcTestnet } from "./chain";
import { ADDRESSES, factoryAbi, marketAbi, Outcome } from "./contracts";

const MARKET_READ_BATCH_SIZE = 40;
const MARKET_READ_BATCH_DELAY_MS = 100;

function rpcTransport() {
    const urls = [
        ...(process.env.ARC_TESTNET_RPC_URLS?.split(",")
            .map((x) => x.trim())
            .filter(Boolean) ?? []),
        ...(process.env.ARC_TESTNET_RPC_URL ? [process.env.ARC_TESTNET_RPC_URL] : []),
        ...arcTestnet.rpcUrls.default.http,
    ];
    return fallback([...new Set(urls)].map((url) => http(url)));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: rpcTransport(),
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

async function readMarketSummaryBatch(addresses: Address[]): Promise<MarketSummary[]> {
    const contracts = addresses.flatMap((address) => [
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
    ]);
    const results = await publicClient.multicall({
        allowFailure: true,
        contracts,
    });

    const rows: MarketSummary[] = [];
    for (let i = 0; i < addresses.length; i++) {
        const offset = i * 10;
        const slice = results.slice(offset, offset + 10);
        if (slice.some((row) => row.status !== "success")) {
            console.warn("[markets] failed to read market summary", addresses[i]);
            continue;
        }
        rows.push({
            address: addresses[i],
            question: slice[0].result as string,
            category: slice[1].result as string,
            deadline: slice[2].result as bigint,
            priceYes: slice[3].result as bigint,
            totalLiquidity: slice[4].result as bigint,
            initialLiquidity: slice[5].result as bigint,
            resolved: slice[6].result as boolean,
            outcome: slice[7].result as Outcome,
            totalSharesYes: slice[8].result as bigint,
            totalSharesNo: slice[9].result as bigint,
        });
    }
    return rows;
}

export async function listMarkets(): Promise<MarketSummary[]> {
    const addrs = (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    if (addrs.length === 0) return [];

    const rows: MarketSummary[] = [];
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH_SIZE) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH_SIZE);
        try {
            rows.push(...await readMarketSummaryBatch(batch));
        } catch (err) {
            console.warn("[markets] batch read failed; falling back to per-market reads", err);
            const settled = await Promise.allSettled(batch.map(readMarketSummary));
            for (const row of settled) {
                if (row.status === "fulfilled") rows.push(row.value);
                else console.warn("[markets] failed to read market summary", row.reason);
            }
        }
        if (i + MARKET_READ_BATCH_SIZE < addrs.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return rows;
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
