import "server-only";

import {
    type Address,
    getAddress,
    isAddress,
    recoverMessageAddress,
} from "viem";
import {
    AUTH_MAX_AGE_SECONDS,
    buildAuthMessage,
    type ProfileOp,
} from "./auth-sig-shared";

export type AuthResult =
    | { ok: true; signer: Address }
    | { ok: false; status: number; error: string };

/**
 * Verifies that the request was signed by `expectedUserAddr` recently enough.
 *
 * Headers consumed:
 *   x-yolo-sig — hex personal_sign signature
 *   x-yolo-ts  — unix seconds the message claims to have been signed at
 *
 * The server reconstructs the exact message via buildAuthMessage and recovers
 * the signer. Because the message embeds the op + user + ts, a sig captured
 * for `profile.active` can't be replayed against `profile.delete`, can't be
 * replayed against a different user, and can't be replayed > 5 minutes later.
 */
export async function verifyProfileAuth(
    headers: Headers,
    expectedUserAddr: string,
    op: ProfileOp,
): Promise<AuthResult> {
    if (!isAddress(expectedUserAddr)) {
        return { ok: false, status: 400, error: "invalid userAddr" };
    }
    const sig = headers.get("x-yolo-sig");
    const tsRaw = headers.get("x-yolo-ts");
    if (!sig || !tsRaw) {
        return { ok: false, status: 401, error: "missing auth headers" };
    }

    const ts = Number.parseInt(tsRaw, 10);
    if (!Number.isFinite(ts)) {
        return { ok: false, status: 400, error: "bad ts header" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > AUTH_MAX_AGE_SECONDS) {
        return { ok: false, status: 401, error: "stale signature" };
    }

    const message = buildAuthMessage(op, expectedUserAddr, ts);

    let recovered: Address;
    try {
        recovered = await recoverMessageAddress({
            message,
            signature: sig as `0x${string}`,
        });
    } catch {
        return { ok: false, status: 401, error: "bad signature" };
    }

    if (recovered.toLowerCase() !== expectedUserAddr.toLowerCase()) {
        return { ok: false, status: 401, error: "signer / user mismatch" };
    }

    return { ok: true, signer: getAddress(recovered) };
}
