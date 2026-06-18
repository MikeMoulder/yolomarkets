import { NextResponse, type NextRequest } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { getAgentWallet } from "@/lib/agent-wallets";
import { verifyProfileAuth } from "@/lib/auth-sig";
import { publicClient } from "@/lib/markets";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import {
    transferFromDeveloperWallet,
    waitForDeveloperTransaction,
} from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    userAddr?: string;
    // Optional 6-dec micro amount as a string. Omitted ⇒ withdraw full balance.
    amountMicro?: string;
};

/** GET — current agent wallet USDC balance (6-dec micro), for the UI. */
export async function GET(req: NextRequest) {
    const addr = req.nextUrl.searchParams.get("userAddr");
    if (!addr || !isAddress(addr)) {
        return NextResponse.json({ error: "invalid userAddr" }, { status: 400 });
    }
    const bound = await getAgentWallet(addr);
    if (!bound?.agentAddress) {
        return NextResponse.json({ balance: "0", agentAddress: null });
    }
    try {
        const bal = (await publicClient.readContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(bound.agentAddress)],
        })) as bigint;
        return NextResponse.json({
            balance: bal.toString(),
            agentAddress: bound.agentAddress,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: msg.slice(0, 200) }, { status: 502 });
    }
}

/** POST — transfer USDC from the agent wallet to the owner's EOA. */
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

    const auth = await verifyProfileAuth(
        req.headers,
        body.userAddr,
        "agent.wallet.withdraw",
    );
    if (!auth.ok) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // Wallet identity comes from the server-owned binding keyed by the
    // authenticated userAddr — never from a client-writable profile field. A
    // user can therefore only ever withdraw their own wallet (audit C-1).
    const bound = await getAgentWallet(body.userAddr);
    if (!bound?.walletId || !bound.agentAddress) {
        return NextResponse.json({ error: "no agent wallet" }, { status: 404 });
    }

    // Destination is always the owner's EOA — never an arbitrary addr.
    const destination = getAddress(body.userAddr) as Address;

    let balance: bigint;
    try {
        balance = (await publicClient.readContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(bound.agentAddress)],
        })) as bigint;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: `balance read failed: ${msg.slice(0, 160)}` },
            { status: 502 },
        );
    }

    let amount: bigint;
    if (body.amountMicro != null) {
        try {
            amount = BigInt(body.amountMicro);
        } catch {
            return NextResponse.json({ error: "invalid amountMicro" }, { status: 400 });
        }
        if (amount <= 0n) {
            return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
        }
        if (amount > balance) {
            return NextResponse.json(
                { error: "amount exceeds wallet balance" },
                { status: 409 },
            );
        }
    } else {
        amount = balance;
    }
    if (amount === 0n) {
        return NextResponse.json({ error: "nothing to withdraw" }, { status: 409 });
    }

    try {
        const { txId } = await transferFromDeveloperWallet({
            walletId: bound.walletId,
            destinationAddress: destination,
            amountMicro: amount,
        });
        const txHash = await waitForDeveloperTransaction(txId);
        return NextResponse.json({
            ok: true,
            txHash,
            amountMicro: amount.toString(),
            destination,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: `withdraw failed: ${msg.slice(0, 240)}` },
            { status: 502 },
        );
    }
}
