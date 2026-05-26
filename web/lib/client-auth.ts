"use client";

import { buildAuthMessage, type ProfileOp } from "./auth-sig-shared";

/**
 * Wraps wagmi's signMessageAsync to produce the three headers the
 * /api/agent/profile* routes expect. The user sees one wallet prompt
 * per mutation; the resulting headers are short-lived (5 min) and bound
 * to (op, user, ts) so they can't be replayed.
 */
export async function signProfileOp(args: {
    op: ProfileOp;
    userAddr: string;
    signMessageAsync: (params: { message: string }) => Promise<`0x${string}`>;
}): Promise<{
    "x-yolo-sig": `0x${string}`;
    "x-yolo-ts": string;
}> {
    const ts = Math.floor(Date.now() / 1000);
    const message = buildAuthMessage(args.op, args.userAddr, ts);
    const sig = await args.signMessageAsync({ message });
    return {
        "x-yolo-sig": sig,
        "x-yolo-ts": String(ts),
    };
}
