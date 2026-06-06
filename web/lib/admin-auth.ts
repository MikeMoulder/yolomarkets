/**
 * Admin authentication primitives.
 *
 * Flow (EIP-191 signed-message login, no on-chain transaction needed):
 *
 *   1.  Client requests a one-shot challenge from /api/admin/nonce. Server
 *       returns {nonce, issuedAt} and stores both inside a short-lived
 *       (5-minute) signed cookie `__yolo_admin_challenge`.
 *   2.  Client builds the canonical login message (see `buildLoginMessage`),
 *       has the user sign it via their wallet, POSTs the signature to
 *       /api/admin/verify with their address.
 *   3.  Server reads the challenge cookie, verifies the signature with
 *       `verifyMessage` (viem), confirms the recovered address matches the
 *       claimed one AND is on the whitelist, then issues a 1-hour session
 *       cookie `__yolo_admin_session` (signed JWT containing the address).
 *   4.  proxy.ts runs an optimistic presence check on /admin/* paths.
 *   5.  Each protected page re-verifies the session server-side via
 *       `requireAdminSession()` and rejects on failure.
 */

import { SignJWT, jwtVerify } from "jose";
import { buildAdminLoginMessage } from "./admin-auth-shared";

export const ADMIN_SESSION_COOKIE = "__yolo_admin_session";
export const ADMIN_CHALLENGE_COOKIE = "__yolo_admin_challenge";
export const SESSION_TTL_SECONDS = 60 * 60;        // 1 hour
export const CHALLENGE_TTL_SECONDS = 5 * 60;       // 5 minutes

const ISSUER_SESSION = "yolo-markets:admin";
const ISSUER_CHALLENGE = "yolo-markets:admin-challenge";

/** A development-only fallback. In production this MUST be set via env. */
const DEFAULT_DEV_SECRET =
    "DEV_ONLY_change_me_via_ADMIN_COOKIE_SECRET_in_dot_env_or_secrets_manager";

function getSecret(): Uint8Array {
    const raw = process.env.ADMIN_COOKIE_SECRET ?? DEFAULT_DEV_SECRET;
    if (raw === DEFAULT_DEV_SECRET && process.env.NODE_ENV === "production") {
        throw new Error(
            "ADMIN_COOKIE_SECRET is required in production. Refusing to use dev fallback.",
        );
    }
    return new TextEncoder().encode(raw);
}

/** Parse the whitelist on each call so it stays in sync with env updates. */
export function getAdminWhitelist(): Set<string> {
    const raw = process.env.ADMIN_ADDRESSES ?? "";
    return new Set(
        raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    );
}

export function isAdminAddress(addr: string): boolean {
    return getAdminWhitelist().has(addr.toLowerCase());
}

export type SessionPayload = { address: string };

export async function issueAdminSessionJwt(address: `0x${string}`): Promise<string> {
    return new SignJWT({ address: address.toLowerCase() })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(ISSUER_SESSION)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
        .sign(getSecret());
}

export async function verifyAdminSessionJwt(token: string): Promise<SessionPayload | null> {
    try {
        const { payload } = await jwtVerify(token, getSecret(), {
            issuer: ISSUER_SESSION,
        });
        const address = String(payload.address ?? "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
        if (!isAdminAddress(address)) return null;
        return { address };
    } catch {
        return null;
    }
}

export type ChallengePayload = { nonce: string; issuedAt: string };

export async function issueChallengeJwt(payload: ChallengePayload): Promise<string> {
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(ISSUER_CHALLENGE)
        .setIssuedAt()
        .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
        .sign(getSecret());
}

export async function verifyChallengeJwt(token: string): Promise<ChallengePayload | null> {
    try {
        const { payload } = await jwtVerify(token, getSecret(), {
            issuer: ISSUER_CHALLENGE,
        });
        const nonce = String(payload.nonce ?? "");
        const issuedAt = String(payload.issuedAt ?? "");
        if (!nonce || !issuedAt) return null;
        return { nonce, issuedAt };
    } catch {
        return null;
    }
}

/** The canonical message users sign to prove wallet ownership for admin access.
 *  Format is deterministic and self-describing so a user reading the wallet
 *  prompt understands what they're authorizing. */
export function buildLoginMessage(
    address: `0x${string}`,
    nonce: string,
    issuedAt: string,
): string {
    return buildAdminLoginMessage(address, nonce, issuedAt);
}
