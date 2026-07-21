/**
 * Helpers shared between the Next server (reads) and the standalone
 * catalog-indexer script (writes) for the `market_index` catalog cache.
 *
 * Intentionally free of any `lib/db` import: the indexer builds its own
 * postgres client (env is loaded at its entrypoint, after module graph
 * evaluation), and reuses these pure mappers + the `db`-parameterised
 * upsert/meta helpers with that client. The Next side (lib/markets.ts) passes
 * the shared singleton `db`.
 */
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Address } from "viem";
import {
    catalogMeta,
    marketIndex,
    type MarketIndexRow,
    type NewMarketIndexRow,
} from "./db/schema";
import type { Outcome } from "./contracts";
// Type-only: avoids a runtime cycle (markets.ts imports this module's value
// exports; this module only needs the shape of a MarketSummary).
import type { MarketSummary } from "./markets";

// A drizzle instance bound to our schema — same type on both the Next
// singleton and the indexer's own client.
export type CatalogDb = PostgresJsDatabase<Record<string, unknown>>;

export const V2_BACKFILLED_KEY = "v2_backfilled";
export const V2_SYNCED_AT_KEY = "v2_synced_at";

// Raw DDL so the indexer can guarantee its tables exist on boot without
// depending on the drizzle migration runner (this DB is partly hand-migrated —
// see CLAUDE.md). Kept in sync with the drizzle table definitions in schema.ts.
export const MARKET_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS market_index (
    address text PRIMARY KEY,
    factory text NOT NULL,
    legacy boolean NOT NULL DEFAULT false,
    question text NOT NULL,
    category text NOT NULL,
    deadline bigint NOT NULL,
    initial_liquidity numeric NOT NULL DEFAULT '0',
    price_yes numeric NOT NULL DEFAULT '0',
    total_liquidity numeric NOT NULL DEFAULT '0',
    total_shares_yes numeric NOT NULL DEFAULT '0',
    total_shares_no numeric NOT NULL DEFAULT '0',
    resolved boolean NOT NULL DEFAULT false,
    outcome integer NOT NULL DEFAULT 0,
    dynamic_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_index_catalog ON market_index (legacy, resolved, deadline);
CREATE TABLE IF NOT EXISTS catalog_meta (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Postgres `numeric`/`bigint` may come back as string, number, or bigint
 *  depending on the driver path. Normalise to bigint, tolerating a stray
 *  decimal suffix (we only ever store integers here). */
export function toBig(v: string | number | bigint | null | undefined): bigint {
    if (typeof v === "bigint") return v;
    if (v === null || v === undefined) return 0n;
    const s = String(v).split(".")[0];
    if (!s || s === "-") return 0n;
    try {
        return BigInt(s);
    } catch {
        return 0n;
    }
}

export function indexRowToSummary(row: MarketIndexRow): MarketSummary {
    return {
        address: row.address as Address,
        question: row.question,
        category: row.category,
        deadline: toBig(row.deadline),
        priceYes: toBig(row.priceYes),
        totalLiquidity: toBig(row.totalLiquidity),
        initialLiquidity: toBig(row.initialLiquidity),
        resolved: row.resolved,
        outcome: row.outcome as Outcome,
        totalSharesYes: toBig(row.totalSharesYes),
        totalSharesNo: toBig(row.totalSharesNo),
        legacy: row.legacy,
    };
}

export function summaryToIndexRow(s: MarketSummary, factory: Address): NewMarketIndexRow {
    return {
        address: s.address.toLowerCase(),
        factory: factory.toLowerCase(),
        legacy: s.legacy,
        question: s.question,
        category: s.category,
        deadline: s.deadline,
        initialLiquidity: s.initialLiquidity.toString(),
        priceYes: s.priceYes.toString(),
        totalLiquidity: s.totalLiquidity.toString(),
        totalSharesYes: s.totalSharesYes.toString(),
        totalSharesNo: s.totalSharesNo.toString(),
        resolved: s.resolved,
        outcome: s.outcome,
        dynamicSyncedAt: new Date(),
        updatedAt: new Date(),
    };
}

/** Upsert a batch of market rows. Static columns are set on insert; on
 *  conflict only the mutable + sync columns are refreshed from the incoming
 *  row (via `excluded`), so re-indexing an unchanged market is cheap and never
 *  clobbers `created_at`. */
export async function upsertMarketRows(
    db: CatalogDb,
    rows: NewMarketIndexRow[],
): Promise<void> {
    if (rows.length === 0) return;
    await db
        .insert(marketIndex)
        .values(rows)
        .onConflictDoUpdate({
            target: marketIndex.address,
            set: {
                question: sql`excluded.question`,
                category: sql`excluded.category`,
                deadline: sql`excluded.deadline`,
                initialLiquidity: sql`excluded.initial_liquidity`,
                priceYes: sql`excluded.price_yes`,
                totalLiquidity: sql`excluded.total_liquidity`,
                totalSharesYes: sql`excluded.total_shares_yes`,
                totalSharesNo: sql`excluded.total_shares_no`,
                resolved: sql`excluded.resolved`,
                outcome: sql`excluded.outcome`,
                dynamicSyncedAt: sql`excluded.dynamic_synced_at`,
                updatedAt: sql`now()`,
            },
        });
}

export async function setCatalogMeta(
    db: CatalogDb,
    key: string,
    value: string,
): Promise<void> {
    await db
        .insert(catalogMeta)
        .values({ key, value })
        .onConflictDoUpdate({
            target: catalogMeta.key,
            set: { value: sql`excluded.value`, updatedAt: sql`now()` },
        });
}

export async function getCatalogMeta(
    db: CatalogDb,
    key: string,
): Promise<string | null> {
    const rows = await db
        .select({ value: catalogMeta.value })
        .from(catalogMeta)
        .where(sql`${catalogMeta.key} = ${key}`)
        .limit(1);
    return rows[0]?.value ?? null;
}
