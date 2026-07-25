import { NextResponse, type NextRequest } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { getAgentWallet } from "@/lib/agent-wallets";
import { verifyProfileAuth } from "@/lib/auth-sig";
import { quoteExit } from "@/lib/agent-positions";
import { publicClient } from "@/lib/markets";
import { marketAbi, Outcome } from "@/lib/contracts";
import {
    executeDeveloperContractCall,
    waitForDeveloperTransaction,
} from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Slippage floor applied to the previewSell quote when computing the on-chain
// `_minReceived` arg. Default 1% (100 bps); override via env for tuning.
const EXIT_SLIPPAGE_BPS = Number(process.env.AGENT_EXIT_SLIPPAGE_BPS ?? "100");

type Body = {
    userAddr?: string;
    market?: string;
    outcome?: number; // 1 = YES, 2 = NO
    shares?: string; // 6-dec micro units, as a string (bigint-safe over JSON)
};

function parseOutcome(o: unknown): Outcome.Yes | Outcome.No | null {
    if (o === Outcome.Yes || o === Outcome.No) return o;
    return null;
}

/** GET — live exit quote for a partial/full amount (no signature required). */
export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams;
    const market = sp.get("market");
    const outcome = parseOutcome(Number(sp.get("outcome")));
    const sharesRaw = sp.get("shares");
    if (!market || !isAddress(market) || outcome === null || !sharesRaw) {
        return NextResponse.json({ error: "bad params" }, { status: 400 });
    }
    let shares: bigint;
    try {
        shares = BigInt(sharesRaw);
    } catch {
        return NextResponse.json({ error: "bad shares" }, { status: 400 });
    }
    if (shares <= 0n) {
        return NextResponse.json({ error: "shares must be > 0" }, { status: 400 });
    }
    try {
        const received = await quoteExit(getAddress(market), outcome, shares);
        return NextResponse.json({ received: received.toString() });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: msg.slice(0, 200) }, { status: 502 });
    }
}

/** POST — execute the exit: sell `shares` of the agent's position. */
export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    if (!body.userAddr || !isAddress(body.userAddr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }
    if (!body.market || !isAddress(body.market)) {
        return NextResponse.json({ error: "invalid market" }, { status: 400 });
    }
    const outcome = parseOutcome(body.outcome);
    if (outcome === null) {
        return NextResponse.json({ error: "invalid outcome" }, { status: 400 });
    }
    let shares: bigint;
    try {
        shares = BigInt(body.shares ?? "0");
    } catch {
        return NextResponse.json({ error: "invalid shares" }, { status: 400 });
    }
    if (shares <= 0n) {
        return NextResponse.json({ error: "shares must be > 0" }, { status: 400 });
    }

    const auth = await verifyProfileAuth(
        req.headers,
        body.userAddr,
        "agent.position.exit",
    );
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // Wallet identity comes from the server-owned binding keyed by the
    // authenticated userAddr — never from a client-writable profile field, so a
    // user can only ever sell positions held by their own wallet (audit C-1).
    const bound = await getAgentWallet(body.userAddr);
    if (!bound?.walletId || !bound.agentAddress) {
        return NextResponse.json({ error: "no agent wallet" }, { status: 404 });
    }

    const market = getAddress(body.market) as Address;
    const agent = getAddress(bound.agentAddress) as Address;

    // Re-validate against live chain state — never trust the client's share
    // count, and refuse if the market resolved or passed its deadline out from
    // under the request (an expired sell reverts PastDeadline on-chain).
    let resolved: boolean;
    let deadline: bigint;
    let held: bigint;
    try {
        [resolved, deadline, held] = (await publicClient.multicall({
            contracts: [
                { address: market, abi: marketAbi, functionName: "resolved" } as const,
                { address: market, abi: marketAbi, functionName: "deadline" } as const,
                {
                    address: market,
                    abi: marketAbi,
                    functionName: outcome === Outcome.Yes ? "sharesYes" : "sharesNo",
                    args: [agent],
                } as const,
            ],
            allowFailure: false,
        })) as [boolean, bigint, bigint];
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: `chain read failed: ${msg.slice(0, 160)}` },
            { status: 502 },
        );
    }

    if (resolved) {
        return NextResponse.json(
            { error: "market resolved — winnings are auto-claimed, not exited" },
            { status: 409 },
        );
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= deadline) {
        return NextResponse.json(
            { error: "market past deadline — trading closed, awaiting resolution" },
            { status: 409 },
        );
    }
    if (held === 0n) {
        return NextResponse.json({ error: "no position to exit" }, { status: 409 });
    }
    if (shares > held) shares = held; // clamp to live balance (full exit)

    // Slippage guard: compute proceeds now, set _minReceived a notch below.
    let minReceived: bigint;
    try {
        const proceeds = await quoteExit(market, outcome, shares);
        minReceived =
            (proceeds * BigInt(10_000 - EXIT_SLIPPAGE_BPS)) / 10_000n;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: `quote failed: ${msg.slice(0, 160)}` },
            { status: 502 },
        );
    }

    try {
        const { txId } = await executeDeveloperContractCall({
            walletId: bound.walletId,
            contractAddress: market,
            abiFunctionSignature: "sell(uint8,uint256,uint256)",
            // uint8 as a number, uint256s as strings — matches the verified
            // buy path in agent/smoke_trading.py.
            abiParameters: [outcome, shares.toString(), minReceived.toString()],
        });
        const txHash = await waitForDeveloperTransaction(txId);
        return NextResponse.json({
            ok: true,
            txHash,
            shares: shares.toString(),
            minReceived: minReceived.toString(),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: `exit failed: ${msg.slice(0, 240)}` },
            { status: 502 },
        );
    }
}
