import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";

// Agent v2 · M2 — chat proxy.
// The browser never talks to the Python agent service directly. This route is
// the gateway: it validates the request, attaches the internal shared secret,
// and streams the Server-Sent Events back to the browser unchanged.
//
// Auth (M2, read-only): the caller's connected wallet address identifies whose
// data to read. Chat reads are low-sensitivity (positions are public on-chain;
// the agent's notes are per-user but not secret), so no signature is required
// just to ask questions. Write actions (M3) will require the SIWE session +
// per-trade wallet approval.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A chat turn streams while the model + tools run (often 15–40s). Raise the
// serverless function budget so the stream isn't cut short. Note: this is
// capped by your Vercel plan (Hobby is lower; Pro allows up to 300).
export const maxDuration = 60;

const AGENT_URL = process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:8080";

type ChatBody = {
    message?: string;
    userAddr?: string;
    history?: { role?: string; content?: string }[];
    // The market the user is currently viewing (from /markets/<address>), so
    // the agent can resolve "this market". Read-only hint — validated, but not
    // trusted for anything a tool doesn't independently re-check.
    currentMarket?: string;
};

function bad(message: string, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
    let body: ChatBody;
    try {
        body = (await req.json()) as ChatBody;
    } catch {
        return bad("invalid JSON body");
    }

    // Hard cap on message length. The UI limits to 600; this is a defensive
    // ceiling for direct callers so a huge prompt can't run up model spend.
    const MAX_CHARS = 2000;
    const message = (body.message ?? "").trim();
    const userAddr = (body.userAddr ?? "").trim();
    if (!message) return bad("message is required");
    if (message.length > MAX_CHARS) return bad("message is too long");
    if (!isAddress(userAddr)) return bad("a connected wallet is required");

    const currentMarket = (body.currentMarket ?? "").trim();
    const marketHint = isAddress(currentMarket) ? currentMarket : undefined;

    // Keep only the last few turns and only the fields the agent needs.
    const history = (Array.isArray(body.history) ? body.history : [])
        .filter((h) => (h.role === "user" || h.role === "assistant") && h.content)
        .slice(-10)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 4000) }));

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.AGENT_CHAT_SHARED_SECRET) {
        headers["X-Agent-Secret"] = process.env.AGENT_CHAT_SHARED_SECRET;
    }

    let upstream: Response;
    try {
        upstream = await fetch(`${AGENT_URL}/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                message,
                user_addr: userAddr,
                history,
                current_market: marketHint,
            }),
        });
    } catch {
        return bad("agent service is unreachable", 502);
    }

    if (!upstream.ok || !upstream.body) {
        return bad(`agent service error (${upstream.status})`, 502);
    }

    // Pass the SSE stream straight through to the browser.
    return new Response(upstream.body, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
