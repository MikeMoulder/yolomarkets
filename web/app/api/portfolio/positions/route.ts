/**
 * Every market where a wallet holds shares.
 *
 * The portfolio used to compute this in the browser by walking all v2 markets
 * in 40-market batches. At 5k+ markets that is 133 sequential round-trips —
 * slower than the page's own 30s refetch, so scans overlapped and the public
 * RPC started answering 429 to everything. The scan lives on the server now:
 * one fallback-backed client, 200-market aggregates, bounded concurrency, and a
 * cache shared across tabs and reloads.
 */
import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { listUserPositions } from "@/lib/markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const user = new URL(req.url).searchParams.get("user");
    if (!user || !isAddress(user)) {
        return NextResponse.json({ error: "valid ?user= address required" }, { status: 400 });
    }

    try {
        const positions = await listUserPositions(user as Address);
        return NextResponse.json(
            {
                // bigint doesn't survive JSON — the client parses these back.
                positions: positions.map((p) => ({
                    address: p.address,
                    sharesYes: p.sharesYes.toString(),
                    sharesNo: p.sharesNo.toString(),
                })),
            },
            { headers: { "cache-control": "no-store" } },
        );
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message.slice(0, 160) : "scan failed" },
            { status: 502 },
        );
    }
}
