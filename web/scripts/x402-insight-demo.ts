/**
 * Demo: buy our own x402 Insight API, agent-to-agent, on Arc.
 *
 * Drives the full Leg C loop end to end — request terms, sign a real
 * EIP-3009 authorization as the nanopay payer EOA, present it, and get the
 * insight back. Settlement is real: $0.0001 leaves the payer's Gateway
 * balance and lands with the treasury.
 *
 * Calls the route handler directly rather than over HTTP so it runs without
 * a Next server (this box OOMs on `next dev`).
 *
 * Run: npm run x402:demo -- [marketAddress]
 */
import "./load-env";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { GET } from "../app/api/x402/insight/route";

const BASE = "https://yolomarkets.fun/api/x402/insight";
const MARKET = process.argv[2] ?? "0x13e97fFA9068452001Df8Df7EbEd043B35763237";

async function main() {
    // 1. Ask our own endpoint for its terms (the real 402 challenge).
    const challenge = await GET(new Request(`${BASE}?market=${MARKET}`));
    const header = challenge.headers.get("payment-required")!;
    const doc = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const reqs = doc.accepts[0];
    console.log("1. challenge:", challenge.status, "price", reqs.amount, "micro ->", reqs.payTo);

    // 2. Sign a real payment authorization as the nanopay payer EOA.
    const account = privateKeyToAccount(process.env.NANOPAY_PAYER_PRIVATE_KEY as Hex);
    const scheme = new BatchEvmScheme(account as never);
    const signed = await scheme.createPaymentPayload(2, reqs);
    // A real buyer's HTTP transport attaches `resource` and `accepted`; the
    // facilitator rejects the payload without them (400 "resource: Required").
    const payload = { ...signed, resource: doc.resource, accepted: reqs };
    console.log("2. signed payload by", account.address);

    // 3. Present it to the endpoint — this settles for real through Circle.
    const paid = await GET(
        new Request(`${BASE}?market=${MARKET}`, {
            headers: {
                "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64"),
            },
        }),
    );
    const body = await paid.json();
    console.log("3. paid request ->", paid.status);
    console.log("   settlement tx:", paid.headers.get("x-payment-transaction"));
    console.log("   payload:", JSON.stringify(body).slice(0, 600));
}
void main();
