/**
 * Fast market swarm:
 * - Loads locally generated EOAs from config/fast-market-swarm.wallets.json
 * - Schedules small random buys on active Fast markets
 * - Claims winning shares after resolution
 *
 * Defaults to dry-run. Set FAST_SWARM_LIVE=1 to broadcast transactions.
 */
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    parseUnits,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi, Outcome } from "../lib/contracts";
import { lmsrBuyCost } from "../lib/lmsr";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

type WalletEntry = {
    id: string;
    address: Address;
    privateKey: `0x${string}`;
    target: "fast-markets";
};

type WalletConfig = {
    version: 1;
    chainId: number;
    target: "fast-markets";
    wallets: WalletEntry[];
};

type BetStatus = "pending" | "bought" | "skipped" | "failed" | "claimed" | "lost";

type WalletMarketState = {
    status: BetStatus;
    dueAt: number;
    side?: Outcome.Yes | Outcome.No;
    targetUsdc?: string;
    tx?: `0x${string}`;
    claimTx?: `0x${string}`;
    attempts?: number;
    lastError?: string;
};

type SwarmState = {
    version: 1;
    updatedAt: string;
    wallets: Record<string, { markets: Record<string, WalletMarketState> }>;
};

type MarketRow = {
    address: Address;
    question: string;
    category: string;
    deadline: bigint;
    resolved: boolean;
    outcome: Outcome;
};

const DEFAULT_CONFIG = path.resolve(
    __dirname,
    "..",
    "..",
    "config",
    "fast-market-swarm.wallets.json",
);
const DEFAULT_STATE = path.resolve(
    __dirname,
    "..",
    "..",
    "config",
    "fast-market-swarm.state.json",
);
const CATEGORY = "Fast";
const DEFAULT_POLL_SECONDS = 20;
const DEFAULT_MARKET_SCAN_LIMIT = 96;
const DEFAULT_CLAIM_SCAN_LIMIT = 144;
const DEFAULT_PARTICIPATION_RATE = 0.35;
const DEFAULT_MIN_BET_USDC = "0.25";
const DEFAULT_MAX_BET_USDC = "1.75";
const DEFAULT_RESERVE_USDC = "5";
const DEFAULT_MAX_OPEN_DELAY_SECONDS = 180;
const DEFAULT_MIN_SECONDS_BEFORE_DEADLINE = 45;
const DEFAULT_MAX_TX_PER_LOOP = 8;
const SLIPPAGE_BPS = 200n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_EXECUTABLE_BET_USDC = parseUnits("0.05", 6);

function getRpcUrl(): string {
    return process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]!;
}

function resolveFromWeb(pathish: string | undefined, fallback: string): string {
    if (!pathish) return fallback;
    return path.resolve(__dirname, "..", pathish);
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envUsdc(name: string, fallback: string): bigint {
    return parseUnits(process.env[name] ?? fallback, 6);
}

function toUsdc6(amount: string): bigint {
    return parseUnits(amount, 6);
}

function usdcString(amount: bigint): string {
    return formatUnits(amount, 6);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function marketKey(address: Address): string {
    return address.toLowerCase();
}

function walletKey(address: Address): string {
    return address.toLowerCase();
}

function randomFloat(min: number, max: number): number {
    const unit = randomInt(0, 1_000_001) / 1_000_000;
    return min + (max - min) * unit;
}

function randomUsdc(min: bigint, max: bigint): bigint {
    if (max <= min) return min;
    const span = max - min + 1n;
    if (span <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return min + BigInt(randomInt(Number(span)));
    }
    return min + BigInt(randomInt(1_000_000)) * (span / 1_000_000n);
}

function randomOutcome(): Outcome.Yes | Outcome.No {
    return randomInt(0, 2) === 0 ? Outcome.Yes : Outcome.No;
}

async function loadJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T;
}

async function saveState(file: string, state: SwarmState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function loadState(file: string): Promise<SwarmState> {
    try {
        const state = await loadJson<SwarmState>(file);
        if (state.version === 1 && state.wallets) return state;
    } catch {
        // First run starts with a clean state file.
    }
    return { version: 1, updatedAt: new Date().toISOString(), wallets: {} };
}

function parseWallets(config: WalletConfig): Array<{ entry: WalletEntry; account: Account }> {
    if (config.version !== 1 || config.target !== "fast-markets") {
        throw new Error("Unsupported fast swarm wallet config");
    }
    if (config.chainId !== arcTestnet.id) {
        throw new Error(`Wallet config chainId=${config.chainId}; expected ${arcTestnet.id}`);
    }

    return config.wallets.map((entry) => {
        const account = privateKeyToAccount(entry.privateKey);
        if (account.address.toLowerCase() !== entry.address.toLowerCase()) {
            throw new Error(`Wallet ${entry.id} address does not match private key`);
        }
        return { entry, account };
    });
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
): Promise<MarketRow | null> {
    try {
        const [question, category, deadline, resolved, outcome] = await publicClient.multicall({
            allowFailure: false,
            contracts: [
                { address, abi: marketAbi, functionName: "question" },
                { address, abi: marketAbi, functionName: "category" },
                { address, abi: marketAbi, functionName: "deadline" },
                { address, abi: marketAbi, functionName: "resolved" },
                { address, abi: marketAbi, functionName: "outcome" },
            ],
        });
        return {
            address,
            question,
            category,
            deadline,
            resolved,
            outcome: Number(outcome) as Outcome,
        } as MarketRow;
    } catch (err) {
        console.warn(`[swarm] failed reading market ${address}`, err);
        return null;
    }
}

async function readRecentMarkets(
    publicClient: ReturnType<typeof createPublicClient>,
    scanLimit: number,
): Promise<MarketRow[]> {
    const addresses = await readFactoryMarkets(publicClient);
    const recent = addresses.slice(-Math.max(1, scanLimit));
    const rows: MarketRow[] = [];
    for (const address of recent) {
        const row = await readMarketRow(publicClient, address);
        if (row) rows.push(row);
    }
    return rows;
}

function isFastMarket(row: MarketRow): boolean {
    return row.category.trim().toLowerCase() === CATEGORY.toLowerCase();
}

function ensureWalletState(state: SwarmState, address: Address) {
    const key = walletKey(address);
    state.wallets[key] ??= { markets: {} };
    return state.wallets[key]!;
}

function scheduleNewBets(
    state: SwarmState,
    wallets: Array<{ entry: WalletEntry; account: Account }>,
    activeMarkets: MarketRow[],
    nowSec: number,
    participationRate: number,
    minBet: bigint,
    maxBet: bigint,
    maxOpenDelaySeconds: number,
    minSecondsBeforeDeadline: number,
) {
    for (const row of activeMarkets) {
        const secondsLeft = Number(row.deadline) - nowSec;
        if (secondsLeft <= minSecondsBeforeDeadline) continue;

        for (const wallet of wallets) {
            const walletState = ensureWalletState(state, wallet.account.address);
            const key = marketKey(row.address);
            if (walletState.markets[key]) continue;

            if (randomFloat(0, 1) > participationRate) {
                walletState.markets[key] = {
                    status: "skipped",
                    dueAt: nowSec,
                };
                continue;
            }

            const latestDelay = Math.max(1, Math.min(maxOpenDelaySeconds, secondsLeft - minSecondsBeforeDeadline));
            const dueAt = nowSec + randomInt(1, latestDelay + 1);
            const target = randomUsdc(minBet, maxBet);
            walletState.markets[key] = {
                status: "pending",
                dueAt,
                side: randomOutcome(),
                targetUsdc: usdcString(target),
            };
        }
    }
}

async function readUsdcBalance(
    publicClient: ReturnType<typeof createPublicClient>,
    owner: Address,
): Promise<bigint> {
    return (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
    })) as bigint;
}

async function ensureAllowance(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: Account,
    market: Address,
    minRequired: bigint,
    live: boolean,
) {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, market],
    })) as bigint;
    if (allowance >= minRequired) return;

    if (!live) {
        console.log(
            `[swarm] dry-run approve ${account.address} -> ${market} for ${usdcString(minRequired)} USDC`,
        );
        return;
    }

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [market, MAX_UINT256],
        account,
        chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[swarm] approved ${market} for ${account.address} tx=${tx}`);
}

async function sharesForBudget(
    publicClient: ReturnType<typeof createPublicClient>,
    market: Address,
    side: Outcome.Yes | Outcome.No,
    budget: bigint,
): Promise<{ shares: bigint; quotedCost: bigint }> {
    // Read the LMSR params once, then run the whole budget search locally via
    // lmsrBuyCost (an exact mirror of the on-chain previewBuy). The previous
    // version fired a previewBuy eth_call per binary-search iteration — ~30-40
    // sequential RPC calls per bet — which could trip the RPC's rate limit.
    const [b, qYes, qNo] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
            { address: market, abi: marketAbi, functionName: "b" },
            { address: market, abi: marketAbi, functionName: "qYes" },
            { address: market, abi: marketAbi, functionName: "qNo" },
        ],
    });

    const previewBuy = (shares: bigint) => lmsrBuyCost(b, qYes, qNo, side, shares);

    let low = 0n;
    let lowCost = 0n;
    let high = budget;
    if (high < 1n) high = 1n;

    let highCost = previewBuy(high);
    let expansions = 0;
    while (highCost <= budget && expansions < 24) {
        low = high;
        lowCost = highCost;
        high *= 2n;
        highCost = previewBuy(high);
        expansions += 1;
    }

    while (low < high) {
        const mid = (low + high + 1n) / 2n;
        const midCost = previewBuy(mid);
        if (midCost <= budget) {
            low = mid;
            lowCost = midCost;
        } else {
            high = mid - 1n;
        }
    }

    return { shares: low, quotedCost: lowCost };
}

function shortError(err: unknown): string {
    if (err instanceof Error) return err.message.slice(0, 500);
    return String(err).slice(0, 500);
}

async function executeDueBets(
    publicClient: ReturnType<typeof createPublicClient>,
    wallets: Array<{ entry: WalletEntry; account: Account }>,
    activeMarkets: MarketRow[],
    state: SwarmState,
    nowSec: number,
    reserveUsdc: bigint,
    maxTxPerLoop: number,
    live: boolean,
): Promise<number> {
    const activeByKey = new Map(activeMarkets.map((row) => [marketKey(row.address), row]));
    let txCount = 0;

    for (const wallet of wallets) {
        if (txCount >= maxTxPerLoop) break;
        const walletState = ensureWalletState(state, wallet.account.address);
        const walletClient = createWalletClient({
            account: wallet.account,
            chain: arcTestnet,
            transport: http(getRpcUrl()),
        });

        for (const [key, bet] of Object.entries(walletState.markets)) {
            if (txCount >= maxTxPerLoop) break;
            if (bet.status !== "pending" || bet.dueAt > nowSec || !bet.side || !bet.targetUsdc) continue;

            const row = activeByKey.get(key);
            if (!row) continue;

            try {
                const target = toUsdc6(bet.targetUsdc);
                const balance = await readUsdcBalance(publicClient, wallet.account.address);
                if (balance <= reserveUsdc + MIN_EXECUTABLE_BET_USDC) {
                    bet.lastError = `waiting for funds; balance ${usdcString(balance)} below reserve`;
                    console.log(
                        `[swarm] ${wallet.entry.id} waiting on funds for ${row.address}; balance=${usdcString(balance)} USDC`,
                    );
                    continue;
                }

                const spendTarget = balance < target + reserveUsdc ? balance - reserveUsdc : target;
                const quoteBudget = (spendTarget * 10_000n) / (10_000n + SLIPPAGE_BPS);
                const { shares, quotedCost } = await sharesForBudget(
                    publicClient,
                    row.address,
                    bet.side,
                    quoteBudget,
                );
                if (shares <= 0n || quotedCost <= 0n) {
                    bet.status = "skipped";
                    bet.lastError = "quote produced zero shares";
                    continue;
                }

                await ensureAllowance(publicClient, walletClient, wallet.account, row.address, spendTarget, live);
                const sideLabel = bet.side === Outcome.Yes ? "YES" : "NO";

                if (!live) {
                    console.log(
                        `[swarm] dry-run ${wallet.entry.id} buy ${sideLabel} ${usdcString(shares)} shares on ${row.address} target=${usdcString(spendTarget)} quoted=${usdcString(quotedCost)}`,
                    );
                    txCount += 1;
                    continue;
                }

                const tx = await walletClient.writeContract({
                    address: row.address,
                    abi: marketAbi,
                    functionName: "buy",
                    args: [bet.side, shares, spendTarget],
                    account: wallet.account,
                    chain: arcTestnet,
                });
                await publicClient.waitForTransactionReceipt({ hash: tx });
                bet.status = "bought";
                bet.tx = tx;
                txCount += 1;
                console.log(
                    `[swarm] ${wallet.entry.id} bought ${sideLabel} ${usdcString(shares)} shares on ${row.address} cost<=${usdcString(spendTarget)} tx=${tx}`,
                );
            } catch (err) {
                bet.attempts = (bet.attempts ?? 0) + 1;
                bet.lastError = shortError(err);
                if (bet.attempts >= 3) bet.status = "failed";
                console.warn(`[swarm] ${wallet.entry.id} bet failed on ${row.address}: ${bet.lastError}`);
            }
        }
    }

    return txCount;
}

async function claimResolved(
    publicClient: ReturnType<typeof createPublicClient>,
    wallets: Array<{ entry: WalletEntry; account: Account }>,
    resolvedMarkets: MarketRow[],
    state: SwarmState,
    maxTxPerLoop: number,
    live: boolean,
): Promise<number> {
    let txCount = 0;

    for (const row of resolvedMarkets) {
        if (txCount >= maxTxPerLoop) break;
        if (row.outcome !== Outcome.Yes && row.outcome !== Outcome.No) continue;

        for (const wallet of wallets) {
            if (txCount >= maxTxPerLoop) break;
            const walletState = ensureWalletState(state, wallet.account.address);
            const key = marketKey(row.address);
            const bet = walletState.markets[key];
            if (bet?.status === "claimed" || bet?.status === "lost") continue;

            const shares = (await publicClient.readContract({
                address: row.address,
                abi: marketAbi,
                functionName: row.outcome === Outcome.Yes ? "sharesYes" : "sharesNo",
                args: [wallet.account.address],
            })) as bigint;

            if (shares <= 0n) {
                if (bet?.status === "bought") bet.status = "lost";
                continue;
            }

            const claimState =
                bet ??
                (walletState.markets[key] = {
                    status: "bought",
                    dueAt: 0,
                });

            const walletClient = createWalletClient({
                account: wallet.account,
                chain: arcTestnet,
                transport: http(getRpcUrl()),
            });

            if (!live) {
                console.log(
                    `[swarm] dry-run claim ${wallet.entry.id} ${usdcString(shares)} USDC from ${row.address}`,
                );
                continue;
            }

            try {
                const tx = await walletClient.writeContract({
                    address: row.address,
                    abi: marketAbi,
                    functionName: "claim",
                    args: [],
                    account: wallet.account,
                    chain: arcTestnet,
                });
                await publicClient.waitForTransactionReceipt({ hash: tx });
                claimState.status = "claimed";
                claimState.claimTx = tx;
                txCount += 1;
                console.log(
                    `[swarm] ${wallet.entry.id} claimed ${usdcString(shares)} USDC from ${row.address} tx=${tx}`,
                );
            } catch (err) {
                claimState.lastError = shortError(err);
                console.warn(`[swarm] ${wallet.entry.id} claim failed on ${row.address}: ${claimState.lastError}`);
            }
        }
    }

    return txCount;
}

async function main() {
    const configPath = resolveFromWeb(process.env.FAST_SWARM_WALLETS_CONFIG, DEFAULT_CONFIG);
    const statePath = resolveFromWeb(process.env.FAST_SWARM_STATE_FILE, DEFAULT_STATE);
    const live = process.env.FAST_SWARM_LIVE === "1";
    const pollSeconds = Math.max(5, envNumber("FAST_SWARM_POLL_SECONDS", DEFAULT_POLL_SECONDS));
    const scanLimit = Math.max(1, envNumber("FAST_SWARM_MARKET_SCAN_LIMIT", DEFAULT_MARKET_SCAN_LIMIT));
    const claimScanLimit = Math.max(scanLimit, envNumber("FAST_SWARM_CLAIM_SCAN_LIMIT", DEFAULT_CLAIM_SCAN_LIMIT));
    const participationRate = Math.min(
        1,
        Math.max(0, envNumber("FAST_SWARM_PARTICIPATION_RATE", DEFAULT_PARTICIPATION_RATE)),
    );
    const minBet = envUsdc("FAST_SWARM_MIN_BET_USDC", DEFAULT_MIN_BET_USDC);
    const maxBet = envUsdc("FAST_SWARM_MAX_BET_USDC", DEFAULT_MAX_BET_USDC);
    const reserveUsdc = envUsdc("FAST_SWARM_RESERVE_USDC", DEFAULT_RESERVE_USDC);
    const maxOpenDelaySeconds = Math.max(
        1,
        envNumber("FAST_SWARM_MAX_OPEN_DELAY_SECONDS", DEFAULT_MAX_OPEN_DELAY_SECONDS),
    );
    const minSecondsBeforeDeadline = Math.max(
        1,
        envNumber("FAST_SWARM_MIN_SECONDS_BEFORE_DEADLINE", DEFAULT_MIN_SECONDS_BEFORE_DEADLINE),
    );
    const maxTxPerLoop = Math.max(1, envNumber("FAST_SWARM_MAX_TX_PER_LOOP", DEFAULT_MAX_TX_PER_LOOP));

    const config = await loadJson<WalletConfig>(configPath);
    const wallets = parseWallets(config);
    const state = await loadState(statePath);

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(getRpcUrl()),
    });

    console.log(`[swarm] loaded ${wallets.length} wallets from ${configPath}`);
    console.log(`[swarm] state file ${statePath}`);
    console.log(`[swarm] mode=${live ? "LIVE" : "DRY_RUN"} poll=${pollSeconds}s participation=${participationRate}`);
    console.log(
        `[swarm] random bet range=${usdcString(minBet)}-${usdcString(maxBet)} USDC reserve=${usdcString(reserveUsdc)} maxTxPerLoop=${maxTxPerLoop}`,
    );

    for (;;) {
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            const rows = await readRecentMarkets(publicClient, claimScanLimit);
            const activeMarkets = rows.filter(
                (row) => isFastMarket(row) && !row.resolved && Number(row.deadline) > nowSec,
            );
            const resolvedMarkets = rows.filter((row) => isFastMarket(row) && row.resolved);

            scheduleNewBets(
                state,
                wallets,
                activeMarkets,
                nowSec,
                participationRate,
                minBet,
                maxBet,
                maxOpenDelaySeconds,
                minSecondsBeforeDeadline,
            );

            const claimTxs = await claimResolved(
                publicClient,
                wallets,
                resolvedMarkets,
                state,
                maxTxPerLoop,
                live,
            );
            const betTxs = await executeDueBets(
                publicClient,
                wallets,
                activeMarkets,
                state,
                nowSec,
                reserveUsdc,
                Math.max(1, maxTxPerLoop - claimTxs),
                live,
            );

            if (live) await saveState(statePath, state);
            console.log(
                `[swarm] loop active=${activeMarkets.length} resolved=${resolvedMarkets.length} claimTxs=${claimTxs} betTxs=${betTxs}`,
            );
        } catch (err) {
            console.error("[swarm] loop error:", err);
            if (live) await saveState(statePath, state);
        }

        await delay(pollSeconds * 1000);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
