/**
 * Polymarket mirror resolution keeper:
 * - Scans Arc markets for POLYMARKET_MIRROR metadata.
 * - Polls the exact Gamma market by slug.
 * - Resolves Arc mirrors as YES/NO only after Polymarket is final.
 *
 * It deliberately never uses Outcome.Cancelled. Cancellation is reserved for
 * fast markets with no trades.
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import {
    createPublicClient,
    createWalletClient,
    http,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, factoryAbi, marketAbi, Outcome } from "../lib/contracts";
import { parsePolymarketMirrorMeta } from "../lib/polymarket-mirror";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

const GAMMA_BASE =
    process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const DEFAULT_POLL_SECONDS = 300;
const FINAL_EPSILON = 0.005;

type GammaMarket = {
    slug?: string;
    closed?: boolean;
    active?: boolean;
    outcomes?: string;
    outcomePrices?: string;
    umaResolutionStatus?: string | null;
    resolvedBy?: string | null;
};

type MarketRow = {
    address: Address;
    question: string;
    deadline: bigint;
    resolved: boolean;
    resolutionCriteria: string;
};

type ResolutionCheck =
    | { kind: "pending"; reason: string }
    | { kind: "review"; reason: string }
    | { kind: "final"; outcome: Outcome.Yes | Outcome.No; reason: string };

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

function getRpcUrl(): string {
    return process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]!;
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be 32-byte hex");
    }
    return key as `0x${string}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function parseJsonArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((x) => String(x));
    } catch {
        return [];
    }
}

function normalizeOutcome(raw: string): string {
    return raw.trim().toLowerCase();
}

async function fetchGammaMarket(slug: string): Promise<GammaMarket | null> {
    const res = await fetch(`${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`, {
        headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gamma market ${slug} failed: ${res.status}`);
    return (await res.json()) as GammaMarket;
}

function inferResolution(market: GammaMarket | null): ResolutionCheck {
    if (!market) return { kind: "review", reason: "Gamma market not found" };
    if (!market.closed) return { kind: "pending", reason: "Polymarket still open" };

    const status = market.umaResolutionStatus?.toLowerCase() ?? "";
    if (status && !/(resolved|settled|final)/.test(status)) {
        return { kind: "pending", reason: `UMA status=${market.umaResolutionStatus}` };
    }

    const outcomes = parseJsonArray(market.outcomes).map(normalizeOutcome);
    const prices = parseJsonArray(market.outcomePrices).map(Number);
    if (prices.length < 2 || prices.some((x) => !Number.isFinite(x))) {
        return { kind: "review", reason: "Missing final outcome prices" };
    }

    const yesIndex = outcomes.findIndex((x) => x === "yes");
    const noIndex = outcomes.findIndex((x) => x === "no");
    const yes = yesIndex >= 0 ? prices[yesIndex] : prices[0];
    const no = noIndex >= 0 ? prices[noIndex] : prices[1];

    if (yes >= 1 - FINAL_EPSILON && no <= FINAL_EPSILON) {
        return { kind: "final", outcome: Outcome.Yes, reason: `final prices yes=${yes} no=${no}` };
    }
    if (no >= 1 - FINAL_EPSILON && yes <= FINAL_EPSILON) {
        return { kind: "final", outcome: Outcome.No, reason: `final prices yes=${yes} no=${no}` };
    }

    return {
        kind: "review",
        reason: `closed but not binary-final yes=${yes} no=${no}`,
    };
}

async function readFactoryMarkets(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<Address[]> {
    return (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
}

async function readMarketRow(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<MarketRow> {
    const [question, deadline, resolved, resolutionCriteria] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
            { address, abi: marketAbi, functionName: "question" },
            { address, abi: marketAbi, functionName: "deadline" },
            { address, abi: marketAbi, functionName: "resolved" },
            { address, abi: marketAbi, functionName: "resolutionCriteria" },
        ],
    });
    return {
        address,
        question,
        deadline,
        resolved,
        resolutionCriteria,
    } as MarketRow;
}

async function syncMirrorRows(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<MarketRow[]> {
    const addrs = await readFactoryMarkets(publicClient);
    const rows = await Promise.all(addrs.map((address) => readMarketRow(publicClient, address)));
    return rows.filter(
        (row) => !row.resolved && parsePolymarketMirrorMeta(row.resolutionCriteria),
    );
}

async function resolveMirrors(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: Account,
    rows: MarketRow[],
) {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const row of rows) {
        if (Number(row.deadline) > nowSec) continue;

        const meta = parsePolymarketMirrorMeta(row.resolutionCriteria);
        if (!meta) continue;

        let check: ResolutionCheck;
        try {
            check = inferResolution(await fetchGammaMarket(meta.polymarketSlug));
        } catch (err) {
            console.warn(`[poly-resolver] ${meta.polymarketSlug} fetch failed`, err);
            continue;
        }

        if (check.kind === "pending") {
            console.log(`[poly-resolver] pending ${meta.polymarketSlug}: ${check.reason}`);
            continue;
        }
        if (check.kind === "review") {
            console.warn(
                `[poly-resolver] review needed ${meta.polymarketSlug} @ ${row.address}: ${check.reason}`,
            );
            continue;
        }

        const tx = await walletClient.writeContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "resolveMarket",
            args: [row.address, check.outcome],
            account,
            chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log(
            `[poly-resolver] resolved ${meta.polymarketSlug} @ ${row.address} as ${
                check.outcome === Outcome.Yes ? "YES" : "NO"
            } (${check.reason}) tx=${tx}`,
        );
    }
}

async function main() {
    const account = privateKeyToAccount(parsePrivateKey(env("DEPLOYER_PRIVATE_KEY")));
    const rpcUrl = getRpcUrl();
    const pollSeconds = Number(
        process.env.POLYMARKET_RESOLUTION_POLL_SECONDS ?? DEFAULT_POLL_SECONDS,
    );
    const once = flag("once");

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: http(rpcUrl),
    });

    console.log(`[poly-resolver] started as ${account.address}`);
    console.log(`[poly-resolver] polling every ${pollSeconds}s`);

    if (once) {
        const rows = await syncMirrorRows(publicClient);
        console.log(`[poly-resolver] tracking ${rows.length} mirror market(s)`);
        await resolveMirrors(publicClient, walletClient, account, rows);
        return;
    }

    for (;;) {
        try {
            const rows = await syncMirrorRows(publicClient);
            console.log(`[poly-resolver] tracking ${rows.length} mirror market(s)`);
            await resolveMirrors(publicClient, walletClient, account, rows);
        } catch (err) {
            console.error("[poly-resolver] loop error:", err);
        }
        await delay(Math.max(30, pollSeconds) * 1000);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
