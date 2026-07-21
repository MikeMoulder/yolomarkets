/**
 * Catalog indexer — keeps the `market_index` Postgres table in sync with the
 * v2 factory so the web catalog reads markets from the DB instead of doing a
 * full on-chain read of ~1k (and growing) markets on every refresh.
 *
 * Per tick:
 *   1. Reconcile — if the on-chain marketCount exceeds what we've indexed, pull
 *      the new market addresses and read their full summaries (this is also the
 *      one-time backfill: on an empty table every market is "new").
 *   2. Refresh — re-read the summaries of every still-unresolved v2 market so
 *      prices/liquidity stay fresh and resolutions/cancellations land. Resolved
 *      markets are never re-read again — that's the whole win.
 *
 * The web app treats this as best-effort: if the indexer is down the catalog
 * serves the (slightly stale) table; if the DB is down it falls back to the
 * full RPC read. Only after a complete first pass is `v2_backfilled` set, which
 * is what flips the web read from RPC to DB.
 *
 * Run: npm run markets:catalog:indexer   (or `-- --once` for a single pass)
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

import {
    createPublicClient,
    fallback,
    http,
    type Address,
} from "viem";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, factoryAbi, marketAbi, type Outcome } from "../lib/contracts";
import * as schema from "../lib/db/schema";
import { marketIndex } from "../lib/db/schema";
import type { MarketSummary } from "../lib/markets";
import {
    MARKET_INDEX_DDL,
    V2_BACKFILLED_KEY,
    V2_SYNCED_AT_KEY,
    summaryToIndexRow,
    upsertMarketRows,
    setCatalogMeta,
    type CatalogDb,
} from "../lib/catalog-index";

const FACTORY = ADDRESSES.factory;
const POLL_SECONDS = Number(process.env.CATALOG_INDEXER_POLL_SECONDS ?? 20);
const READ_BATCH = 25; // 25 × 10 fields = 250 sub-calls (free-tier RPC ceiling)
const READ_BATCH_DELAY_MS = 150;
const UPSERT_CHUNK = 100;
const ONCE = process.argv.includes("--once");

function getRpcUrls(): string[] {
    const multi =
        process.env.ARC_TESTNET_RPC_URLS?.split(",")
            .map((x) => x.trim())
            .filter(Boolean) ?? [];
    const one = process.env.ARC_TESTNET_RPC_URL?.trim();
    const urls = [...multi, ...(one ? [one] : []), ...arcTestnet.rpcUrls.default.http];
    return [...new Set(urls)];
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const rpcUrls = getRpcUrls();
const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: fallback(rpcUrls.map((url) => http(url))),
    batch: { multicall: true },
});

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    console.error("[indexer] DATABASE_URL is required");
    process.exit(1);
}
const sqlClient = postgres(dbUrl, { max: 2, idle_timeout: 30, prepare: false });
const db = drizzle(sqlClient, { schema }) as unknown as CatalogDb;

const SUMMARY_FIELDS = [
    "question",
    "category",
    "deadline",
    "priceYes",
    "totalLiquidity",
    "initialLiquidity",
    "resolved",
    "outcome",
    "totalSharesYes",
    "totalSharesNo",
] as const;

async function readSummaryBatch(addrs: Address[]): Promise<MarketSummary[]> {
    const contracts = addrs.flatMap((address) =>
        SUMMARY_FIELDS.map((functionName) => ({ address, abi: marketAbi, functionName })),
    );
    const results = await publicClient.multicall({ allowFailure: true, contracts });

    const rows: MarketSummary[] = [];
    for (let i = 0; i < addrs.length; i++) {
        const slice = results.slice(i * 10, i * 10 + 10);
        if (slice.some((r) => r.status !== "success")) {
            console.warn(`[indexer] skipped unreadable market ${addrs[i]}`);
            continue;
        }
        rows.push({
            address: addrs[i],
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
            legacy: false,
        });
    }
    return rows;
}

async function readSummaries(addrs: Address[]): Promise<MarketSummary[]> {
    const out: MarketSummary[] = [];
    for (let i = 0; i < addrs.length; i += READ_BATCH) {
        const batch = addrs.slice(i, i + READ_BATCH);
        try {
            out.push(...(await readSummaryBatch(batch)));
        } catch (err) {
            console.warn("[indexer] batch read failed; retrying per-market", err);
            for (const a of batch) {
                try {
                    out.push(...(await readSummaryBatch([a])));
                } catch {
                    /* leave for the next tick */
                }
            }
        }
        if (i + READ_BATCH < addrs.length) await delay(READ_BATCH_DELAY_MS);
    }
    return out;
}

async function writeRows(summaries: MarketSummary[]): Promise<void> {
    const rows = summaries.map((s) => summaryToIndexRow(s, FACTORY));
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        await upsertMarketRows(db, rows.slice(i, i + UPSERT_CHUNK));
    }
}

/** Index markets present on-chain but missing from the table. On an empty
 *  table this is the full backfill. Returns whether the table now covers the
 *  full on-chain set. */
async function reconcileNew(): Promise<{ total: number; indexed: number }> {
    const total = Number(
        (await publicClient.readContract({
            address: FACTORY,
            abi: factoryAbi,
            functionName: "marketCount",
        })) as bigint,
    );

    const knownRows = await db
        .select({ address: marketIndex.address })
        .from(marketIndex)
        .where(eq(marketIndex.legacy, false));
    const known = new Set(knownRows.map((r) => r.address.toLowerCase()));

    if (known.size >= total) return { total, indexed: known.size };

    const all = (await publicClient.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    const missing = all.filter((a) => !known.has(a.toLowerCase()));
    console.log(`[indexer] backfilling ${missing.length} new market(s) (on-chain=${total}, indexed=${known.size})`);
    const summaries = await readSummaries(missing);
    await writeRows(summaries);
    return { total, indexed: known.size + summaries.length };
}

/** Re-read every unresolved v2 market so prices/liquidity stay fresh and
 *  resolutions land. Resolved markets are never touched again. */
async function refreshUnresolved(): Promise<number> {
    const rows = await db
        .select({ address: marketIndex.address })
        .from(marketIndex)
        .where(and(eq(marketIndex.legacy, false), eq(marketIndex.resolved, false)));
    const addrs = rows.map((r) => r.address as Address);
    if (addrs.length === 0) return 0;
    const summaries = await readSummaries(addrs);
    await writeRows(summaries);
    return summaries.length;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
    if (schemaReady) return;
    for (const stmt of MARKET_INDEX_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
        await sqlClient.unsafe(stmt);
    }
    schemaReady = true;
}

async function tick(): Promise<void> {
    const started = Date.now();
    // Kept inside the tick (idempotent) so the process survives being started
    // while the DB is unreachable — it retries each poll until the DB is back.
    await ensureSchema();
    const { total, indexed } = await reconcileNew();
    const refreshed = await refreshUnresolved();

    // Flip the web read from RPC to DB only once the table covers the full
    // on-chain set — never serve a half-populated catalog.
    if (total > 0 && indexed >= total) {
        await setCatalogMeta(db, V2_BACKFILLED_KEY, "1");
    }
    await setCatalogMeta(db, V2_SYNCED_AT_KEY, String(Math.floor(Date.now() / 1000)));

    console.log(
        `[indexer] on-chain=${total} indexed=${indexed} unresolved-refreshed=${refreshed} ` +
            `backfilled=${indexed >= total} in ${Date.now() - started}ms`,
    );
}

async function main() {
    console.log(`[indexer] starting — factory=${FACTORY} poll=${POLL_SECONDS}s once=${ONCE}`);
    console.log(`[indexer] rpc: ${rpcUrls.map((u) => new URL(u).origin).join(", ")}`);

    for (;;) {
        try {
            await tick();
        } catch (err) {
            console.error("[indexer] tick error:", err);
        }
        if (ONCE) break;
        await delay(Math.max(5, POLL_SECONDS) * 1000);
    }
    if (ONCE) await sqlClient.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
