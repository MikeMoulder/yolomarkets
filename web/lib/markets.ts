import { createPublicClient, fallback, http, type Address } from "viem";
import { and, eq } from "drizzle-orm";
import { arcTestnet } from "./chain";
import { ADDRESSES, factoryAbi, marketAbi, Outcome } from "./contracts";
import { db } from "./db";
import { catalogMeta, marketIndex } from "./db/schema";
import { indexRowToSummary, V2_BACKFILLED_KEY } from "./catalog-index";

// 25 markets × 10 fields = 250 sub-calls per multicall — the free-tier Arc
// RPCs reject the older 750-call batches under load ("request limit reached").
const MARKET_READ_BATCH_SIZE = 25;
const MARKET_READ_BATCH_DELAY_MS = 150;

// The factory holds tens of thousands of markets (mostly resolved fast rounds),
// so a full on-chain read takes ~60-80s. The homepage/fast/setup pages are all
// `force-dynamic` and would otherwise pay that on every request. We cache the
// result with stale-while-revalidate: a fresh cache is served instantly; a
// stale one is served instantly while a single background refresh runs. Only a
// genuinely cold cache blocks the request. Detail pages use `getMarket`, which
// is uncached, so a specific market's trade page is always live.
const MARKETS_CACHE_TTL_MS = 30_000;

let marketsCache: { data: MarketSummary[]; at: number } | null = null;
let marketsInflight: Promise<MarketSummary[]> | null = null;

function refreshMarkets(): Promise<MarketSummary[]> {
    if (marketsInflight) return marketsInflight;
    marketsInflight = readAllMarkets()
        .then((rows) => {
            marketsCache = { data: rows, at: Date.now() };
            return rows;
        })
        .catch((err) => {
            // A refresh failing (RPC rate limits during the legacy scan, a
            // flaky node rotation) must never reject unhandled — the SWR
            // caller fires-and-forgets this promise. Serve the stale cache
            // and try again next TTL.
            console.warn("[markets] refresh failed; serving stale cache", err);
            if (marketsCache) return marketsCache.data;
            throw err;
        })
        .finally(() => {
            marketsInflight = null;
        });
    return marketsInflight;
}

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
    // true → market lives on the v1 factory (old bytecode: no claimRefund,
    // admin-key resolution). The catalog only carries unexpired v1 markets;
    // expired ones were deliberately left behind in the 2026-07-18 migration.
    legacy: boolean;
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

async function readMarketSummary(
    address: Address,
    legacy = false,
): Promise<MarketSummary> {
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
        legacy,
    };
}

async function readMarketSummaryBatch(
    addresses: Address[],
    legacy = false,
): Promise<MarketSummary[]> {
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
            legacy,
        });
    }
    return rows;
}

// ── Legacy (v1) liveness scan ──────────────────────────────────────────────
// The v1 factory holds ~13.8k markets, almost all expired fast rounds that
// were deliberately left behind in the 2026-07-18 v2 migration. Deadlines are
// immutable, so the expensive discovery of "which v1 markets are still open"
// runs ONCE per process — gently, to stay under RPC rate limits — and after
// that expiry is decided locally from the cached deadlines. Requests never
// block on this scan: until it completes the catalog simply serves v2 only.

type LegacyLive = { address: Address; deadline: bigint };

let legacyLiveCache: LegacyLive[] | null = null;
let legacyScanInflight: Promise<void> | null = null;

const LEGACY_PROBE_BATCH = 100;
const LEGACY_PROBE_DELAY_MS = 250;

async function scanLegacyLive(addresses: Address[]): Promise<LegacyLive[]> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const live: LegacyLive[] = [];
    let dropped = 0;

    async function probeBatch(batch: Address[]): Promise<Address[]> {
        const failed: Address[] = [];
        const results = await publicClient.multicall({
            allowFailure: true,
            contracts: batch.flatMap((address) => [
                { address, abi: marketAbi, functionName: "deadline" as const },
                { address, abi: marketAbi, functionName: "resolved" as const },
            ]),
        });
        for (let j = 0; j < batch.length; j++) {
            const deadline = results[j * 2];
            const resolved = results[j * 2 + 1];
            if (deadline.status !== "success" || resolved.status !== "success") {
                failed.push(batch[j]);
                continue;
            }
            if ((deadline.result as bigint) > now && !(resolved.result as boolean)) {
                live.push({ address: batch[j], deadline: deadline.result as bigint });
            }
        }
        return failed;
    }

    for (let i = 0; i < addresses.length; i += LEGACY_PROBE_BATCH) {
        let pending = addresses.slice(i, i + LEGACY_PROBE_BATCH);
        for (const backoffMs of [0, 1_000, 3_000]) {
            if (backoffMs > 0) await delay(backoffMs);
            try {
                pending = await probeBatch(pending);
            } catch {
                /* whole batch failed — retry after backoff */
            }
            if (pending.length === 0) break;
        }
        dropped += pending.length;
        if (i + LEGACY_PROBE_BATCH < addresses.length) await delay(LEGACY_PROBE_DELAY_MS);
    }
    if (dropped > 0) {
        console.warn(`[markets] legacy scan: ${dropped} market(s) unprobeable after retries — excluded`);
    }
    console.log(`[markets] legacy scan complete: ${live.length} of ${addresses.length} v1 markets still open`);
    return live;
}

function ensureLegacyScan(addresses: Address[]): void {
    if (legacyLiveCache || legacyScanInflight) return;
    legacyScanInflight = scanLegacyLive(addresses)
        .then((live) => {
            legacyLiveCache = live;
        })
        .catch((err) => {
            console.warn("[markets] legacy scan failed; will retry on next refresh", err);
        })
        .finally(() => {
            legacyScanInflight = null;
        });
}

/** Cached, stale-while-revalidate list of every market the factory has minted.
 *  Safe for the list/discovery pages; see `MARKETS_CACHE_TTL_MS`. */
export async function listMarkets(): Promise<MarketSummary[]> {
    if (marketsCache) {
        const age = Date.now() - marketsCache.at;
        // Serve stale immediately and kick a background refresh (fire-and-forget)
        // when past the TTL so no user request eats the full read.
        if (age > MARKETS_CACHE_TTL_MS && !marketsInflight) {
            void refreshMarkets();
        }
        return marketsCache.data;
    }
    // Cold: no data yet, so this one request has to wait for the read.
    return refreshMarkets();
}

async function readSummaries(
    addrs: Address[],
    legacy: boolean,
): Promise<MarketSummary[]> {
    const rows: MarketSummary[] = [];
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH_SIZE) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH_SIZE);
        try {
            rows.push(...await readMarketSummaryBatch(batch, legacy));
        } catch (err) {
            console.warn("[markets] batch read failed; falling back to per-market reads", err);
            const settled = await Promise.allSettled(
                batch.map((a) => readMarketSummary(a, legacy)),
            );
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

// v2 catalog comes from the Postgres index maintained by
// scripts/catalog-indexer.ts. The on-chain v2 factory now holds ~1k markets
// (mostly churned fast rounds) and grows every 15m, so reading them all per
// refresh was the app's heaviest RPC path. Returns null — so the caller falls
// back to a full RPC read — until the indexer finishes its first backfill (so a
// half-populated table is never served) or if the DB is unreachable.
async function readV2CatalogFromDb(): Promise<MarketSummary[] | null> {
    try {
        const ready = await db
            .select({ value: catalogMeta.value })
            .from(catalogMeta)
            .where(eq(catalogMeta.key, V2_BACKFILLED_KEY))
            .limit(1);
        if (ready[0]?.value !== "1") return null;

        const rows = await db
            .select()
            .from(marketIndex)
            .where(eq(marketIndex.legacy, false));
        return rows.map(indexRowToSummary);
    } catch (err) {
        console.warn("[markets] DB catalog read failed; falling back to RPC", err);
        return null;
    }
}

// v1 is frozen (read-only since the 2026-07-18 migration — no market is ever
// created there again), so its full address list is immutable and safe to read
// exactly once per process instead of on every catalog refresh.
let legacyAddrsCache: Address[] | null = null;
async function readLegacyAddrs(): Promise<Address[]> {
    if (legacyAddrsCache) return legacyAddrsCache;
    legacyAddrsCache = (await publicClient.readContract({
        address: ADDRESSES.factoryLegacy,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    return legacyAddrsCache;
}

/** Catalog source of truth since the 2026-07-18 v2 migration:
 *  - v2 factory: every market, including resolved ones (fast-round history
 *    rebuilds from here as v2 rounds settle). Served from the Postgres index.
 *  - v1 factory: only markets that are still open (unexpired + unresolved).
 *    Its ~13.8k expired fast rounds were deliberately left behind; positions
 *    in them remain claimable via the portfolio, which scans v1 directly. */
async function readAllMarkets(): Promise<MarketSummary[]> {
    // v2 — prefer the Postgres index; fall back to a full RPC read when the
    // indexer hasn't backfilled yet or the DB is unreachable.
    let v2Rows = await readV2CatalogFromDb();
    if (!v2Rows) {
        const v2Addrs = (await publicClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "allMarkets",
        })) as Address[];
        v2Rows = await readSummaries(v2Addrs, false);
    }

    // The v1 legacy liveness scan probes ~13.8k frozen markets over RPC on the
    // first render of every process. That's cheap on a long-running server, but
    // on serverless every cold instance re-runs it and hammers the RPC (it's what
    // made Vercel renders take ~30s), and it runs even when v2 came from the DB.
    // PAUSED by default: the catalog is v2-only unless CATALOG_INCLUDE_LEGACY=1.
    // The ~28 still-open v1 markets are frozen legacy being phased out
    // post-migration and remain reachable by direct URL.
    if (process.env.CATALOG_INCLUDE_LEGACY !== "1") return v2Rows;

    // v1 — frozen factory (addresses cached once). The once-per-process
    // liveness scan decides which are still open; we read just those for fresh
    // prices. Until the scan lands the catalog is v2-only.
    const v1Addrs = await readLegacyAddrs();
    ensureLegacyScan(v1Addrs);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const v1Open = (legacyLiveCache ?? []).filter((m) => m.deadline > nowSec);
    const v1Rows = (await readSummaries(v1Open.map((m) => m.address), true)).filter(
        (r) => !r.resolved && r.deadline > nowSec,
    );
    return [...v2Rows, ...v1Rows];
}

/** Single-market summary from the Postgres catalog index (v2 only). Reliable and
 *  cheap — unlike the chain reads, it can't be rate-limited into failure. */
async function readMarketSummaryFromIndex(
    address: Address,
): Promise<MarketSummary | null> {
    try {
        const rows = await db
            .select()
            .from(marketIndex)
            .where(
                and(
                    eq(marketIndex.legacy, false),
                    eq(marketIndex.address, address.toLowerCase()),
                ),
            )
            .limit(1);
        return rows[0] ? indexRowToSummary(rows[0]) : null;
    } catch {
        return null;
    }
}

export async function getMarket(address: Address): Promise<MarketDetail | null> {
    // Prefer the index for the summary so a rate-limited RPC can't 404 a valid
    // market (that was the Vercel symptom) — and each page does 1 chain read
    // instead of 12. Only resolutionCriteria isn't indexed, so read just that,
    // best-effort: an empty criteria panel beats a 404.
    const indexed = await readMarketSummaryFromIndex(address);
    if (indexed) {
        let resolutionCriteria = "";
        try {
            resolutionCriteria = (await publicClient.readContract({
                address,
                abi: marketAbi,
                functionName: "resolutionCriteria",
            })) as string;
        } catch {
            /* keep "" — the page still renders */
        }
        return { ...indexed, resolutionCriteria };
    }

    // Not in the index (v1 legacy, or the index is cold): read fully from chain.
    try {
        // A market not registered on the v2 factory is a legacy v1 market.
        const onV2 = (await publicClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "isMarket",
            args: [address],
        })) as boolean;
        const summary = await readMarketSummary(address, !onV2);
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
