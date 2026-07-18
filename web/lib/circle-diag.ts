/**
 * TEMPORARY diagnostics for the Circle 155118 "invalid encryption key" bug.
 *
 * 155118 means the encryptionKey handed to the Web SDK does not belong to the
 * userToken it was paired with. Each userToken is a JWT with a unique `jti`;
 * each mint gets its own encryptionKey. If the (jti, keyPrefix) fingerprint
 * logged at login-store time differs from the one at execute() time, the app
 * crossed a token from one mint with a key from another.
 *
 * Pure JS (no server-only) so both the browser and route handlers can import.
 * Remove once the bug is fixed.
 */

function decodeJwtBody(token: string): Record<string, unknown> | null {
    try {
        const part = token.split(".")[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        const json =
            typeof atob === "function"
                ? atob(b64)
                : Buffer.from(b64, "base64").toString("utf8");
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Server-only: append a diagnostic line to a file the operator/agent can read
 * directly, so we don't depend on scraping the noisy `next dev` terminal.
 * No-op in the browser. Best-effort — never throws.
 */
export function appendServerDiag(line: string): void {
    if (typeof window !== "undefined") return;
    try {

        const fs = require("node:fs") as typeof import("node:fs");
        const path =
            process.env.CIRCLE_DIAG_FILE ||
            "/tmp/claude-0/-root-yolomarkets/5848592e-cd6c-401c-8d61-ff0bb3d093cd/scratchpad/circle-diag.log";
        fs.appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
        /* ignore */
    }
}

/** Short, non-secret fingerprint of a (userToken, encryptionKey) pair. */
export function circlePairFingerprint(
    userToken: string | null | undefined,
    encryptionKey?: string | null,
): string {
    const body = userToken ? decodeJwtBody(userToken) : null;
    const jti = body && typeof body.jti === "string" ? body.jti.slice(0, 8) : "?";
    const sub = body && typeof body.sub === "string" ? body.sub.slice(0, 8) : "?";
    const exp = body && typeof body.exp === "number" ? body.exp : 0;
    const now = Math.floor(Date.now() / 1000);
    const ttl = exp ? exp - now : 0;
    const key = encryptionKey ? encryptionKey.slice(0, 6) : "—";
    return `jti=${jti} sub=${sub} key=${key} ttl=${ttl}s${ttl <= 0 && exp ? " EXPIRED" : ""}`;
}
