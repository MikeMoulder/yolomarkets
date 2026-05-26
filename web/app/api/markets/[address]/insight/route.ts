import { NextResponse } from "next/server";
import {
    type Address,
    isAddress,
    type Hash,
} from "viem";
import { estimate } from "@/lib/llm";
import { getMarket, publicClient } from "@/lib/markets";
import { ADDRESSES } from "@/lib/contracts";
import { priceToProb } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSIGHT_FEE_MICRO = 10_000n; // 0.01 USDC with 6 decimals
const ERC20_TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

function parseTransferCalldata(rawInput: `0x${string}`): {
    to: Address;
    value: bigint;
} | null {
    const input = rawInput.toLowerCase() as `0x${string}`;
    if (!input.startsWith(ERC20_TRANSFER_SELECTOR)) return null;
    // 4-byte selector + 32-byte to + 32-byte value = 138 chars including 0x
    if (input.length < 138) return null;

    const toWord = input.slice(10, 74);
    const valueWord = input.slice(74, 138);
    if (toWord.length !== 64 || valueWord.length !== 64) return null;

    const to = `0x${toWord.slice(24)}` as Address;
    let value: bigint;
    try {
        value = BigInt(`0x${valueWord}`);
    } catch {
        return null;
    }

    return { to, value };
}

type Body = {
    txHash?: string;
};

export async function POST(
    req: Request,
    context: { params: Promise<{ address: string }> },
) {
    const { address } = await context.params;
    if (!isAddress(address)) {
        return NextResponse.json({ error: "invalid market address" }, { status: 400 });
    }

    const recipientRaw =
        process.env.AI_INSIGHT_FEE_RECIPIENT ??
        process.env.NEXT_PUBLIC_AI_INSIGHT_FEE_RECIPIENT;
    if (!recipientRaw || !isAddress(recipientRaw)) {
        return NextResponse.json(
            { error: "insight fee recipient not configured" },
            { status: 500 },
        );
    }
    const recipient = recipientRaw.toLowerCase() as Address;

    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }

    const txHash = body.txHash as Hash | undefined;
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return NextResponse.json({ error: "invalid tx hash" }, { status: 400 });
    }

    let receipt;
    try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
        return NextResponse.json(
            { error: "payment receipt not found yet; retry in a moment" },
            { status: 409 },
        );
    }

    if (receipt.status !== "success") {
        return NextResponse.json({ error: "payment transaction not successful" }, { status: 400 });
    }

    const hasValidPaymentByLog = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) return false;
        if (!log.topics?.[0] || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) {
            return false;
        }
        const fromTopic = log.topics[1];
        const toTopic = log.topics[2];
        if (!fromTopic || !toTopic || !log.data || log.data === "0x") return false;

        const eventTo = (`0x${toTopic.slice(-40)}`).toLowerCase();
        let value: bigint;
        try {
            value = BigInt(log.data);
        } catch {
            return false;
        }

        return eventTo === recipient && value >= INSIGHT_FEE_MICRO;
    });

    let hasValidPaymentByCalldata = false;
    try {
        const tx = await publicClient.getTransaction({ hash: txHash });
        const txTo = tx.to?.toLowerCase();
        if (txTo === ADDRESSES.usdc.toLowerCase()) {
            const parsed = parseTransferCalldata(tx.input);
            hasValidPaymentByCalldata =
                !!parsed &&
                parsed.to.toLowerCase() === recipient &&
                parsed.value >= INSIGHT_FEE_MICRO;
        }
    } catch {
        // Keep flow resilient; log-based verification is already primary.
    }

    const hasValidPayment = hasValidPaymentByLog || hasValidPaymentByCalldata;

    if (!hasValidPayment) {
        return NextResponse.json(
            { error: "missing 0.01 USDC payment transfer in tx" },
            { status: 402 },
        );
    }

    const market = await getMarket(address as Address);
    if (!market) {
        return NextResponse.json({ error: "market not found" }, { status: 404 });
    }

    const aiEstimate = await estimate({
        question: market.question,
        criteria: market.resolutionCriteria,
        deadline: new Date(Number(market.deadline) * 1000).toUTCString(),
        marketProb: priceToProb(market.priceYes),
    });

    if (!aiEstimate) {
        return NextResponse.json({ error: "estimate unavailable" }, { status: 503 });
    }

    return NextResponse.json({ ok: true, estimate: aiEstimate });
}
