// Shared between server and client — no `server-only` import. The exact
// string produced here is what the user signs in their wallet, and what the
// API route reconstructs to verify the signature. Any divergence breaks auth.

export type ProfileOp =
    | "profile.put"
    | "profile.delete"
    | "profile.active"
    | "profile.notifications"
    | "agent.wallet.create";

export const AUTH_MAX_AGE_SECONDS = 300;

export function buildAuthMessage(
    op: ProfileOp,
    userAddr: string,
    ts: number,
): string {
    return [
        "YOLO Markets · agent profile auth v1",
        `op: ${op}`,
        `user: ${userAddr.toLowerCase()}`,
        `ts: ${ts}`,
    ].join("\n");
}
