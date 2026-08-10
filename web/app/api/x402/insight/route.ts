/**
 * YOLO Insight API — an x402-priced endpoint that sells this platform's market
 * intelligence to other agents. This is Leg C of the payment design
 * (see ENCODE_PLAN.md): the first flow where USDC comes *in* from machines.
 *
 * Settlement is Circle Nanopayments (Gateway batched x402) on Arc, so a buyer
 * pays sub-cent, gaslessly, in the same request-response cycle. Priced at
 * $0.0001 — that is the point of nanopayments; a per-call price this small is
 * not expressible with ordinary on-chain transfers, where gas alone dwarfs it.
 *
 * WHAT WE SELL, AND WHY IT IS NOT AN LLM CALL
 * The obvious build is "proxy the question to a model and sell the answer".
 * We deliberately don't:
 *   1. it would make every sale cost us an inference call, inverting the margin;
 *   2. it is not differentiated — the buyer could call the model themselves;
 *   3. it makes the endpoint only as available as our LLM provider, which is a
 *      hard dependency we have watched fail.
 * Instead we sell the thing that is genuinely ours: the *accumulated* estimate
 * our agent has already produced for a market (probability, confidence, edge,
 * reasoning, the Polymarket cross-check) joined to the live on-chain price.
 * That is a real asset, it costs us nothing to serve, and it stays up when the
 * brain is down.
 *
 * FLOW
 *   no PAYMENT-SIGNATURE header  → 402 + PAYMENT-REQUIRED (base64 JSON)
 *   with PAYMENT-SIGNATURE       → facilitator.settle() → 200 + the insight
 *
 * Circle's guidance is to call `settle()` directly rather than verify-then-settle:
 * it is latency-optimised and guarantees settlement, so a separate verify is a
 * wasted round-trip.
 */
import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { getMarket } from "@/lib/markets";
import { readDecisions } from "@/lib/agent-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Payment terms ──────────────────────────────────────────────────────────

const X402_VERSION = 2;
const ARC_TESTNET = "eip155:5042002";
const USDC_ARC = "0x3600000000000000000000000000000000000000";
/** Arc testnet GatewayWallet — the EIP-3009 verifying contract, not the token. */
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/** $0.0001 in USDC micro-units. */
const PRICE_MICRO = process.env.X402_INSIGHT_PRICE_MICRO ?? "100";

/**
 * Batched payment authorizations must stay valid for 7+ days — Gateway settles
 * them in batches, so a short window would expire before settlement. 604900s
 * mirrors what other Gateway sellers advertise.
 */
const MAX_TIMEOUT_SECONDS = 604900;

function payTo(): string | null {
    return (
        process.env.X402_INSIGHT_PAY_TO ||
        process.env.AI_INSIGHT_FEE_RECIPIENT ||
        process.env.TREASURY_ADDRESS ||
        null
    );
}

/**
 * Circle Gateway's x402 facilitator — this is what actually verifies the
 * buyer's EIP-3009 authorization and moves the money.
 *
 * The base host is testnet-specific and is NOT the `gateway.circle.com` shown
 * in the seller quickstart (that domain does not resolve; a wrong value fails
 * as an opaque `fetch failed` at settle time). The SDK's own bundle carries the
 * real pair: `gateway-api-testnet.circle.com` and `gateway-api.circle.com`.
 * The client appends `/v1/x402/settle`, so this must be the bare origin.
 */
const facilitator = new BatchFacilitatorClient({
    url:
        process.env.CIRCLE_GATEWAY_URL ??
        "https://gateway-api-testnet.circle.com",
});

function requirementsFor(recipient: string) {
    return {
        scheme: "exact",
        network: ARC_TESTNET,
        asset: USDC_ARC,
        amount: PRICE_MICRO,
        payTo: recipient,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: {
            name: "GatewayWalletBatched",
            version: "1",
            verifyingContract: GATEWAY_WALLET,
        },
    };
}

function paymentRequired(req: Request, recipient: string, market: string) {
    const body = {
        x402Version: X402_VERSION,
        resource: {
            url: new URL(req.url).toString(),
            description:
                "YOLO Markets agent intelligence for one Arc prediction market: " +
                "live on-chain price plus our agent's latest probability estimate, " +
                "confidence, edge and reasoning.",
            mimeType: "application/json",
        },
        accepts: [requirementsFor(recipient)],
    };
    return NextResponse.json(
        { ...body, market },
        {
            status: 402,
            headers: {
                // Base64 of the same document — the header is what x402 clients read.
                "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
                "cache-control": "no-store",
            },
        },
    );
}

// ── Insight payload ────────────────────────────────────────────────────────

async function buildInsight(address: Address) {
    const market = await getMarket(address);
    if (!market) return null;

    // Our agent's most recent estimate for this market, if it has formed one.
    //
    // `agent_decisions.market` stores CHECKSUMMED addresses (the Python runner
    // writes what web3.py hands it), while most of the web tier passes
    // lowercase. The filter is an exact `IN (…)`, so matching one casing only
    // silently returns nothing — which here would mean charging a buyer and
    // handing back `agentView: null`. Query both forms.
    let latest: Awaited<ReturnType<typeof readDecisions>>["decisions"][number] | undefined;
    try {
        const feed = await readDecisions(1, {
            marketAddresses: new Set([getAddress(address), address.toLowerCase()]),
        });
        latest = feed.decisions[0];
    } catch {
        latest = undefined; // DB down → still sell the on-chain half
    }

    const priceYes = Number(market.priceYes) / 1e18;

    return {
        market: {
            address: market.address,
            question: market.question,
            category: market.category,
            deadline: Number(market.deadline),
            resolved: market.resolved,
            priceYes,
            priceNo: 1 - priceYes,
            liquidityUsdc: Number(market.totalLiquidity) / 1e6,
        },
        // Null when the agent has not yet formed a view — an honest absence
        // beats a fabricated number, and the buyer paid for a real answer.
        agentView: latest
            ? {
                  at: latest.ts,
                  probability: latest.ai_prob,
                  confidence: latest.ai_confidence,
                  edgePoints: latest.edge_pts,
                  action: latest.action,
                  reasoning: latest.reasoning,
                  model: latest.brain_model,
                  polymarketProbability: latest.polymarket_prob,
              }
            : null,
        source: "yolomarkets.fun",
        pricedAt: new Date().toISOString(),
    };
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
    const url = new URL(req.url);
    const market = url.searchParams.get("market") ?? "";

    const recipient = payTo();
    if (!recipient) {
        return NextResponse.json(
            { error: "insight API is not configured (no pay-to address)" },
            { status: 503, headers: { "cache-control": "no-store" } },
        );
    }

    // The 402 challenge must be answerable without a market, so that a client's
    // `supports()` probe (which sends no params) still discovers our terms.
    const signature = req.headers.get("payment-signature");
    if (!signature) return paymentRequired(req, recipient, market);

    if (!market || !isAddress(market)) {
        return NextResponse.json(
            { error: "valid ?market= address required" },
            { status: 400, headers: { "cache-control": "no-store" } },
        );
    }

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
    } catch {
        return NextResponse.json(
            { error: "PAYMENT-SIGNATURE is not valid base64 JSON" },
            { status: 400, headers: { "cache-control": "no-store" } },
        );
    }

    // Build the insight BEFORE taking money: if we cannot serve it, the buyer
    // should not be charged.
    const insight = await buildInsight(market as Address);
    if (!insight) {
        return NextResponse.json(
            { error: "unknown market" },
            { status: 404, headers: { "cache-control": "no-store" } },
        );
    }

    let settlement;
    try {
        settlement = await facilitator.settle(
            payload as never,
            requirementsFor(recipient) as never,
        );
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message.slice(0, 160) : "settlement failed" },
            { status: 502, headers: { "cache-control": "no-store" } },
        );
    }

    if (!settlement?.success) {
        // Payment did not settle — answer 402 again rather than serving for free.
        return NextResponse.json(
            { error: settlement?.errorReason ?? "payment did not settle", market },
            { status: 402, headers: { "cache-control": "no-store" } },
        );
    }

    return NextResponse.json(
        { ...insight, payment: { amountMicro: PRICE_MICRO, network: settlement.network, transaction: settlement.transaction } },
        {
            headers: {
                "cache-control": "no-store",
                "x-payment-transaction": String(settlement.transaction ?? ""),
            },
        },
    );
}
