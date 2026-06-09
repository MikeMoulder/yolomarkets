/**
 * Fast market keeper:
 * - Maintains one active market for each symbol/timeframe pair (BTC/ETH/SOL x 15m/1h)
 * - Resolves expired fast markets using spot prices from CoinGecko
 *
 * Run with:
 *   npm run markets:fast:keeper
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import {
    createPublicClient,
    createWalletClient,
    type Account,
    formatUnits,
    http,
    parseUnits,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi, Outcome } from "../lib/contracts";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

type SymbolCfg = {
    symbol: "BTC" | "ETH" | "SOL";
    coingeckoId: "bitcoin" | "ethereum" | "solana";
    binanceSymbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
};

type WindowCfg = {
    label: "15m" | "1h";
    seconds: number;
};

type FastMeta = {
    version: 1;
    symbol: "BTC" | "ETH" | "SOL";
    timeframe: "15m" | "1h";
    source: "coingecko" | "binance";
    startPrice: string; // decimal string
    startTs: number; // aligned candle open time (seconds)
};

const SYMBOLS: SymbolCfg[] = [
    { symbol: "BTC", coingeckoId: "bitcoin", binanceSymbol: "BTCUSDT" },
    { symbol: "ETH", coingeckoId: "ethereum", binanceSymbol: "ETHUSDT" },
    { symbol: "SOL", coingeckoId: "solana", binanceSymbol: "SOLUSDT" },
];

const WINDOWS: WindowCfg[] = [
    { label: "15m", seconds: 15 * 60 },
    { label: "1h", seconds: 60 * 60 },
];

const CATEGORY = "Fast";
const AUTO_PREFIX = "AUTO_FAST:";
const DEFAULT_SEED_USDC = "5";
const DEFAULT_POLL_SECONDS = 30;
const MARKET_READ_CONCURRENCY = 3;
const MARKET_READ_BATCH_DELAY_MS = 1000;

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

function toUsdc6(amount: string): bigint {
    return parseUnits(amount, 6);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapInBatches<T, R>(
    items: T[],
    batchSize: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        out.push(...(await Promise.all(batch.map(fn))));
        if (i + batchSize < items.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return out;
}

function buildQuestion(symbol: string, timeframe: string, startPrice: string): string {
    return `Will ${symbol} be UP in the next ${timeframe}? (Start: $${startPrice})`;
}

function buildResolutionCriteria(meta: FastMeta): string {
    const sourceLine =
        meta.source === "binance"
            ? "Price source: Binance klines close prices in USDT (treated as USD)."
            : "Price source: CoinGecko simple price endpoint in USD.";
    return [
        `${AUTO_PREFIX}${JSON.stringify(meta)}`,
        "Resolves YES iff candle close at deadline is strictly greater than start price.",
        sourceLine,
        "If equal, resolves NO.",
    ].join("\n");
}

function parseAutoMeta(criteria: string): FastMeta | null {
    const first = criteria.split("\n")[0] ?? "";
    if (!first.startsWith(AUTO_PREFIX)) return null;
    try {
        const parsed = JSON.parse(first.slice(AUTO_PREFIX.length)) as FastMeta;
        if (
            parsed?.version === 1 &&
            (parsed.symbol === "BTC" || parsed.symbol === "ETH" || parsed.symbol === "SOL") &&
            (parsed.timeframe === "15m" || parsed.timeframe === "1h") &&
            (parsed.source === "coingecko" || parsed.source === "binance")
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

function alignedWindowStart(nowSec: number, windowSec: number): number {
    return Math.floor(nowSec / windowSec) * windowSec;
}

function findWindow(timeframe: FastMeta["timeframe"]): WindowCfg {
    const win = WINDOWS.find((w) => w.label === timeframe);
    if (!win) {
        throw new Error(`unsupported timeframe: ${timeframe}`);
    }
    return win;
}

async function fetchBinanceCandleClose(
    symbol: SymbolCfg["binanceSymbol"],
    interval: WindowCfg["label"],
    closeTsSec: number,
): Promise<number> {
    const win = findWindow(interval);
    const startMs = BigInt(closeTsSec - win.seconds) * 1000n;
    const endMs = BigInt(closeTsSec) * 1000n;
    const url =
        `https://api.binance.com/api/v3/klines?symbol=${symbol}` +
        `&interval=${interval}&startTime=${startMs.toString()}&endTime=${endMs.toString()}&limit=1`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Binance kline error: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
        throw new Error(`Missing Binance candle for ${symbol} ${interval} close=${closeTsSec}`);
    }

    const closeRaw = (rows[0] as unknown[])[4];
    const close = Number(closeRaw);
    if (!Number.isFinite(close) || close <= 0) {
        throw new Error(`Bad Binance close for ${symbol} ${interval}`);
    }
    return close;
}

async function fetchUsdPrices(ids: SymbolCfg[]): Promise<Record<string, number>> {
    const list = ids.map((x) => x.coingeckoId).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${list}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const out: Record<string, number> = {};
    for (const id of ids) {
        const v = json[id.coingeckoId]?.usd;
        if (!Number.isFinite(v) || !v || v <= 0) {
            throw new Error(`Missing USD price for ${id.coingeckoId}`);
        }
        out[id.symbol] = v;
    }
    return out;
}

async function ensureApproval(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    minRequired: bigint,
) {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner.address, ADDRESSES.factory],
    })) as bigint;

    if (allowance >= minRequired) return;

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.factory, (1n << 256n) - 1n],
        account: owner,
        chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[keeper] approved factory to spend USDC (tx: ${tx})`);
}

async function readUsdcBalance(
    publicClient: ReturnType<typeof createPublicClient>,
    owner: Account,
): Promise<bigint> {
    return (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner.address],
    })) as bigint;
}

type MarketRow = {
    address: Address;
    question: string;
    category: string;
    deadline: bigint;
    resolved: boolean;
    tradeCount: bigint | null;
    resolutionCriteria: string;
};

async function readTradeCount(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<bigint | null> {
    try {
        return (await publicClient.readContract({
            address,
            abi: marketAbi,
            functionName: "tradeCount",
        })) as bigint;
    } catch {
        return null;
    }
}

async function marketHasTrades(
    publicClient: ReturnType<typeof createPublicClient>,
    row: MarketRow,
): Promise<boolean> {
    if (row.tradeCount !== null) return row.tradeCount > 0n;

    const [buys, sells] = await Promise.all([
        publicClient.getContractEvents({
            address: row.address,
            abi: marketAbi,
            eventName: "Bought",
            fromBlock: 0n,
            toBlock: "latest",
        }),
        publicClient.getContractEvents({
            address: row.address,
            abi: marketAbi,
            eventName: "Sold",
            fromBlock: 0n,
            toBlock: "latest",
        }),
    ]);

    return buys.length + sells.length > 0;
}

async function listFactoryMarkets(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<MarketRow[]> {
    const addrs = (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    if (addrs.length === 0) return [];

    const rows = await mapInBatches(
        addrs,
        MARKET_READ_CONCURRENCY,
        async (address) => {
            const [question, category, deadline, resolved, resolutionCriteria] =
                await publicClient.multicall({
                    allowFailure: false,
                    contracts: [
                        { address, abi: marketAbi, functionName: "question" },
                        { address, abi: marketAbi, functionName: "category" },
                        { address, abi: marketAbi, functionName: "deadline" },
                        { address, abi: marketAbi, functionName: "resolved" },
                        { address, abi: marketAbi, functionName: "resolutionCriteria" },
                    ],
                });
            const trades = await readTradeCount(publicClient, address);
            return {
                address,
                question,
                category,
                deadline,
                resolved,
                tradeCount: trades,
                resolutionCriteria,
            } as MarketRow;
        },
    );

    return rows;
}

async function resolveExpired(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    nowSec: number,
    prices: Record<string, number>,
    rows: MarketRow[],
) {
    for (const row of rows) {
        if (row.resolved) continue;
        if (row.category.trim().toLowerCase() !== CATEGORY.toLowerCase()) continue;
        if (Number(row.deadline) > nowSec) continue;

        const meta = parseAutoMeta(row.resolutionCriteria);
        if (!meta) continue;

        const sym = SYMBOLS.find((s) => s.symbol === meta.symbol);
        if (!sym) continue;

        const start = Number(meta.startPrice);
        if (!Number.isFinite(start) || start <= 0) continue;

        const hadTrades = await marketHasTrades(publicClient, row);
        if (!hadTrades) {
            const cancelTx = await walletClient.writeContract({
                address: ADDRESSES.factory,
                abi: factoryAbi,
                functionName: "resolveMarket",
                args: [row.address, Outcome.Cancelled],
                account: owner,
                chain: arcTestnet,
            });
            await publicClient.waitForTransactionReceipt({ hash: cancelTx });

            const withdrawable = (await publicClient.readContract({
                address: row.address,
                abi: marketAbi,
                functionName: "treasuryWithdrawable",
            })) as bigint;

            if (withdrawable > 0n) {
                const withdrawTx = await walletClient.writeContract({
                    address: ADDRESSES.factory,
                    abi: factoryAbi,
                    functionName: "withdrawMarketTreasury",
                    args: [row.address, owner.address, withdrawable],
                    account: owner,
                    chain: arcTestnet,
                });
                await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
                console.log(
                    `[keeper] cancelled ${meta.symbol} ${meta.timeframe} @ ${row.address} (no trades) and reclaimed ${formatUnits(withdrawable, 6)} USDC tx=${withdrawTx}`,
                );
            } else {
                console.log(
                    `[keeper] cancelled ${meta.symbol} ${meta.timeframe} @ ${row.address} (no trades) tx=${cancelTx}`,
                );
            }
            continue;
        }

        let close = 0;
        if (meta.source === "binance") {
            try {
                close = await fetchBinanceCandleClose(
                    sym.binanceSymbol,
                    meta.timeframe,
                    Number(row.deadline),
                );
            } catch (err) {
                close = prices[meta.symbol] ?? 0;
                console.warn(
                    `[keeper] binance close fetch failed for ${meta.symbol} ${meta.timeframe}; falling back to CoinGecko spot for resolution`,
                    err,
                );
            }
        } else {
            close = prices[meta.symbol] ?? 0;
        }
        if (!Number.isFinite(close) || close <= 0) continue;

        const outcome = close > start ? Outcome.Yes : Outcome.No;
        const tx = await walletClient.writeContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "resolveMarket",
            args: [row.address, outcome],
            account: owner,
            chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log(
            `[keeper] resolved ${meta.symbol} ${meta.timeframe} @ ${row.address} as ${
                outcome === Outcome.Yes ? "YES" : "NO"
            } (start=${start}, close=${close}) tx=${tx}`,
        );
    }
}

async function createMissing(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    seedUsdc: bigint,
    nowSec: number,
    prices: Record<string, number>,
    rows: MarketRow[],
) {
    for (const sym of SYMBOLS) {
        for (const win of WINDOWS) {
            const windowStart = alignedWindowStart(nowSec, win.seconds);
            const deadline = windowStart + win.seconds;

            const hasActive = rows.some((row) => {
                if (row.resolved) return false;
                if (Number(row.deadline) <= nowSec) return false;
                const meta = parseAutoMeta(row.resolutionCriteria);
                return !!meta && meta.symbol === sym.symbol && meta.timeframe === win.label;
            });

            if (hasActive) continue;

            // Prefer Binance candle close for window alignment; if unavailable,
            // keep the keeper running with CoinGecko spot as the start price.
            let startClose = 0;
            let source: FastMeta["source"] = "binance";
            try {
                startClose = await fetchBinanceCandleClose(sym.binanceSymbol, win.label, windowStart);
            } catch (err) {
                startClose = prices[sym.symbol] ?? 0;
                source = "coingecko";
                console.warn(
                    `[keeper] binance candle fetch failed for ${sym.symbol} ${win.label}; using CoinGecko spot to seed market`,
                    err,
                );
            }

            if (!Number.isFinite(startClose) || startClose <= 0) {
                console.warn(
                    `[keeper] missing usable start price for ${sym.symbol} ${win.label}; skipping market creation this loop`,
                );
                continue;
            }

            const startPrice = startClose.toFixed(2);
            const meta: FastMeta = {
                version: 1,
                symbol: sym.symbol,
                timeframe: win.label,
                source,
                startPrice,
                startTs: windowStart,
            };

            const question = buildQuestion(sym.symbol, win.label, startPrice);
            const criteria = buildResolutionCriteria(meta);

            const usdcBalance = await readUsdcBalance(publicClient, owner);
            if (usdcBalance < seedUsdc) {
                console.warn(
                    `[keeper] insufficient USDC to create ${sym.symbol} ${win.label}; ` +
                        `balance=${formatUnits(usdcBalance, 6)} seed=${formatUnits(seedUsdc, 6)}. ` +
                        "Skipping remaining market creation this loop.",
                );
                return;
            }

            const tx = await walletClient.writeContract({
                address: ADDRESSES.factory,
                abi: factoryAbi,
                functionName: "createMarket",
                args: [question, CATEGORY, criteria, BigInt(deadline), seedUsdc],
                account: owner,
                chain: arcTestnet,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            console.log(
                `[keeper] created ${sym.symbol} ${win.label} market (deadline=${deadline}) tx=${tx}`,
            );
        }
    }
}

async function main() {
    const privateKey = parsePrivateKey(env("DEPLOYER_PRIVATE_KEY"));
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = getRpcUrl();
    const pollSeconds = Number(process.env.FAST_MARKET_POLL_SECONDS ?? DEFAULT_POLL_SECONDS);
    const seedUsdc = toUsdc6(process.env.FAST_MARKET_SEED_USDC ?? DEFAULT_SEED_USDC);

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: http(rpcUrl),
    });

    console.log(`[keeper] started as ${account.address}`);
    console.log(`[keeper] seed per market: ${formatUnits(seedUsdc, 6)} USDC`);
    console.log(`[keeper] polling every ${pollSeconds}s`);

    for (;;) {
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            await ensureApproval(publicClient, walletClient, account, seedUsdc);
            const prices = await fetchUsdPrices(SYMBOLS);
            const rows = await listFactoryMarkets(publicClient);
            await resolveExpired(publicClient, walletClient, account, nowSec, prices, rows);
            const refreshed = await listFactoryMarkets(publicClient);
            await createMissing(
                publicClient,
                walletClient,
                account,
                seedUsdc,
                nowSec,
                prices,
                refreshed,
            );
        } catch (err) {
            console.error("[keeper] loop error:", err);
        }

        await delay(Math.max(5, pollSeconds) * 1000);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
