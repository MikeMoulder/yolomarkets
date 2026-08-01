/**
 * Production self-diagnosis: times each server-render dependency in the
 * environment that actually matters.
 *
 * Built after a full-site outage where `/` streamed HTTP 200 and then hung
 * forever. Every dependency was healthy when tested from a VPS, and the only
 * way to tell which one stalled *on Vercel* was to reason from which routes
 * happened to be prerendered. This endpoint replaces that guesswork.
 *
 * Returns timings only — no secrets, no row contents. Each probe is bounded, so
 * this route can never hang either.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listMarkets, publicClient } from "@/lib/markets";
import { getNativeImageOverlayResult } from "@/lib/native-image-overlay";
import { getAdminImageVersionsSafe, adminImageFor } from "@/lib/market-images";
import { isFastMarket } from "@/lib/fast-markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 20_000;

type Probe = { name: string; ms: number; ok: boolean; detail: string };

async function probe(name: string, fn: () => Promise<string>): Promise<Probe> {
    const started = Date.now();
    try {
        const detail = await Promise.race([
            fn(),
            new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error(`no answer in ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
            ),
        ]);
        return { name, ms: Date.now() - started, ok: true, detail };
    } catch (e) {
        return {
            name,
            ms: Date.now() - started,
            ok: false,
            detail: e instanceof Error ? e.message.slice(0, 160) : "failed",
        };
    }
}

export async function GET() {
    const started = Date.now();

    // Sequential on purpose: a shared connection pool means concurrent probes
    // would mask which dependency is actually the slow one.
    const probes: Probe[] = [];
    probes.push(
        await probe("postgres.ping", async () => {
            const r = await db.execute(sql`select 1 as ok`);
            return `rows=${Array.isArray(r) ? r.length : 1}`;
        }),
    );
    probes.push(
        await probe("arc.rpc.blockNumber", async () => `block=${await publicClient.getBlockNumber()}`),
    );
    probes.push(
        await probe("listMarkets", async () => `markets=${(await listMarkets()).length}`),
    );
    probes.push(
        await probe("adminImages", async () => `entries=${(await getAdminImageVersionsSafe()).size}`),
    );
    probes.push(
        await probe("polymarketOverlay", async () => {
            const r = await getNativeImageOverlayResult();
            return `available=${r.available}`;
        }),
    );

    // Catalog funnel — why the homepage shows N markets. Added after the site
    // rendered an EMPTY catalog: every probe was green, so the failure had to be
    // in the filter, and there was no way to see the filter from outside.
    let funnel: Record<string, number | boolean | string> = { error: "not run" };
    try {
        const nowSec = Math.floor(Date.now() / 1000);
        const [native, overlay, adminImages] = await Promise.all([
            listMarkets(),
            getNativeImageOverlayResult(),
            getAdminImageVersionsSafe(),
        ]);
        const unresolved = native.filter((m) => !m.resolved);
        const live = unresolved.filter((m) => Number(m.deadline) > nowSec);
        const gate = (m: (typeof live)[number]) =>
            !overlay.available ||
            isFastMarket(m) ||
            adminImageFor(adminImages, m.address) !== null ||
            overlay.lookup(m.question) !== null;
        funnel = {
            total: native.length,
            unresolved: unresolved.length,
            liveUnexpired: live.length,
            overlayAvailable: overlay.available,
            adminImageEntries: adminImages.size,
            passFast: live.filter(isFastMarket).length,
            passAdminArt: live.filter((m) => adminImageFor(adminImages, m.address) !== null).length,
            passOverlayMatch: live.filter((m) => overlay.lookup(m.question) !== null).length,
            FINAL_shownOnHomepage: live.filter(gate).length,
        };
    } catch (e) {
        funnel = { error: e instanceof Error ? e.message.slice(0, 160) : "failed" };
    }

    const slowest = [...probes].sort((a, b) => b.ms - a.ms)[0];
    return NextResponse.json(
        {
            totalMs: Date.now() - started,
            // The headline: what to fix first.
            slowest: slowest ? `${slowest.name} (${slowest.ms}ms)` : null,
            failing: probes.filter((p) => !p.ok).map((p) => p.name),
            catalogFunnel: funnel,
            probes,
            env: {
                vercel: !!process.env.VERCEL,
                region: process.env.VERCEL_REGION ?? null,
                // Which Supabase pooler is in use: 5432 = session (caps ~15
                // clients and BLOCKS when exhausted), 6543 = transaction.
                pgPort: process.env.DATABASE_URL?.match(/:(\d+)\//)?.[1] ?? null,
                catalogIncludeLegacy: process.env.CATALOG_INCLUDE_LEGACY === "1",
                polymarketTimeoutMs: process.env.POLYMARKET_TIMEOUT_MS ?? "4000 (default)",
                ssrDeadlineMs: process.env.SSR_DEADLINE_MS ?? "8000 (default)",
            },
        },
        { headers: { "cache-control": "no-store" } },
    );
}
