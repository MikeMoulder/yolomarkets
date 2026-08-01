/**
 * Serve admin-supplied market cover art.
 *
 * The URL is derived from the (immutable) market address, so callers append
 * `?v=<updated_at>` for cache-busting when the admin replaces an image — see
 * `adminImageUrl`. That lets the response be cached hard: a given `?v=` is
 * genuinely immutable.
 */
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getMarketImage } from "@/lib/market-images";

export const runtime = "nodejs";

export async function GET(
    req: Request,
    context: { params: Promise<{ address: string }> },
) {
    const { address } = await context.params;
    if (!isAddress(address)) {
        return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }

    let image: Awaited<ReturnType<typeof getMarketImage>>;
    try {
        image = await getMarketImage(address);
    } catch {
        return NextResponse.json({ error: "image store unavailable" }, { status: 503 });
    }
    if (!image) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const etag = `W/"${address.toLowerCase()}-${image.updatedAt.getTime()}"`;
    if (req.headers.get("if-none-match") === etag) {
        return new NextResponse(null, { status: 304, headers: { etag } });
    }

    const versioned = new URL(req.url).searchParams.has("v");
    return new NextResponse(new Uint8Array(image.bytes), {
        status: 200,
        headers: {
            "content-type": image.mime,
            "content-length": String(image.bytes.length),
            etag,
            // Versioned URLs are immutable; bare ones must revalidate so a
            // replaced image isn't served stale forever.
            "cache-control": versioned
                ? "public, max-age=31536000, immutable"
                : "public, max-age=60, stale-while-revalidate=300",
        },
    });
}
