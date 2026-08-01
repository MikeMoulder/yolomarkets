/**
 * Admin-supplied market cover art.
 *
 * Card and hero artwork is normally *derived* — `lib/native-image-overlay`
 * fuzzy-matches a market's question back to Polymarket event imagery, and fast
 * markets get a hardcoded token logo. Neither helps a market the admin wrote by
 * hand from Telegram, which is what this module fixes: an explicit image, keyed
 * by market address, that wins over both.
 *
 * Bytes live in Postgres (see migration 0011) and are served by
 * `/api/markets/<address>/image`. Telegram photos are a few hundred KB, so this
 * stays well inside what Postgres is happy holding and needs no object-store
 * credentials.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { marketImages } from "./db/schema";

/** Telegram compresses photos hard; anything past this is a document upload
 *  that has no business being a card thumbnail. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export function isAllowedImageMime(mime: string): boolean {
    return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime.toLowerCase());
}

/** Map a Telegram file path (`photos/file_42.jpg`) to a mime type. Telegram
 *  omits mime for compressed photos — they're always JPEG in practice. */
export function mimeFromPath(filePath: string): string {
    const ext = filePath.toLowerCase().split(".").pop() ?? "";
    if (ext === "png") return "image/png";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    return "image/jpeg";
}

/** Version token → `?v=` so a replaced image busts caches while the URL (which
 *  is derived from the immutable address) stays stable. */
export type ImageVersionMap = Map<string, number>;

export function adminImageUrl(address: string, version?: number): string {
    const base = `/api/markets/${address.toLowerCase()}/image`;
    return version ? `${base}?v=${version}` : base;
}

/** Addresses (lowercased) that have admin art, with a version stamp. One cheap
 *  query — the bytes are never loaded here, only `updated_at`. */
export async function getAdminImageVersions(): Promise<ImageVersionMap> {
    const rows = await db
        .select({ address: marketImages.address, updatedAt: marketImages.updatedAt })
        .from(marketImages);
    return new Map(rows.map((r) => [r.address.toLowerCase(), Math.floor(r.updatedAt.getTime() / 1000)]));
}

/** Never throws: the catalog must still render when the DB is unreachable —
 *  callers just fall back to the derived overlay art. */
export async function getAdminImageVersionsSafe(): Promise<ImageVersionMap> {
    try {
        return await getAdminImageVersions();
    } catch {
        return new Map();
    }
}

/** Resolve a market's admin image URL from a preloaded version map. */
export function adminImageFor(versions: ImageVersionMap, address: string): string | null {
    const v = versions.get(address.toLowerCase());
    return v === undefined ? null : adminImageUrl(address, v);
}

export async function getMarketImage(
    address: string,
): Promise<{ mime: string; bytes: Buffer; updatedAt: Date } | null> {
    const [row] = await db
        .select()
        .from(marketImages)
        .where(eq(marketImages.address, address.toLowerCase()))
        .limit(1);
    if (!row) return null;
    return { mime: row.mime, bytes: row.bytes, updatedAt: row.updatedAt };
}

export async function putMarketImage(
    address: string,
    mime: string,
    bytes: Buffer,
    source = "telegram",
): Promise<void> {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large");
    if (!isAllowedImageMime(mime)) throw new Error(`unsupported image type ${mime}`);
    const key = address.toLowerCase();
    await db
        .insert(marketImages)
        .values({ address: key, mime, bytes, byteSize: bytes.length, source })
        .onConflictDoUpdate({
            target: marketImages.address,
            set: { mime, bytes, byteSize: bytes.length, source, updatedAt: sql`now()` },
        });
}

export async function deleteMarketImage(address: string): Promise<void> {
    await db.delete(marketImages).where(eq(marketImages.address, address.toLowerCase()));
}

export function formatBytes(n: number): string {
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
