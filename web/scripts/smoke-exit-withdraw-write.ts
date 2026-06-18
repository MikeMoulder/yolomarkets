/**
 * WRITE smoke for the manual-exit / withdraw feature — moves real testnet USDC.
 *
 * Picks ONE profile + its smallest open position and:
 *   1. sells 25% of that position via the same Circle helper the exit route
 *      uses (sell(uint8,uint256,uint256)), with a 1% slippage floor
 *   2. re-reads on-chain shares to confirm the decrease
 *   3. withdraws $0.10 from the agent wallet to the owner EOA (transfer)
 *   4. re-reads the agent USDC balance to confirm the decrease
 *
 * Deliberately tiny + deterministic. Run from web/:
 *   node_modules/.bin/tsx scripts/smoke-exit-withdraw-write.ts
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import postgres from "postgres";
import { getAddress, type Address } from "viem";

loadEnv({ path: "../.env" });
loadEnv({ path: ".env" });

import { loadAgentPositions, quoteExit } from "../lib/agent-positions";
import { publicClient } from "../lib/markets";
import { ADDRESSES, erc20Abi, marketAbi, Outcome } from "../lib/contracts";
import {
    executeDeveloperContractCall,
    transferFromDeveloperWallet,
    waitForDeveloperTransaction,
} from "../lib/circle";

const SLIPPAGE_BPS = 100n; // 1%
const WITHDRAW_MICRO = 100_000n; // $0.10

function usd(m: bigint): string {
    return `$${(Number(m) / 1e6).toFixed(4)}`;
}
function sh(m: bigint): string {
    return (Number(m) / 1e6).toFixed(4);
}

async function shareBalance(
    market: Address,
    outcome: Outcome.Yes | Outcome.No,
    owner: Address,
): Promise<bigint> {
    return (await publicClient.readContract({
        address: market,
        abi: marketAbi,
        functionName: outcome === Outcome.Yes ? "sharesYes" : "sharesNo",
        args: [owner],
    })) as bigint;
}
async function usdcBalance(owner: Address): Promise<bigint> {
    return (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
    })) as bigint;
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    const sql = postgres(url, { max: 1 });

    try {
        const [p] = await sql<
            { user_addr: string; agent_address: string; circle_wallet_id: string }[]
        >`select user_addr, agent_address, circle_wallet_id
          from agent_profiles
          where circle_wallet_id is not null and agent_address is not null
          limit 1`;
        if (!p) {
            console.log("no Circle-backed profile — nothing to write-smoke.");
            return;
        }

        const owner = getAddress(p.user_addr) as Address;
        const agent = getAddress(p.agent_address) as Address;
        console.log(`profile owner=${owner}\nagent=${agent}\nwallet=${p.circle_wallet_id}\n`);

        const rows = await sql<{ market: string }[]>`
            select distinct market from agent_decisions
            where agent_addr = ${p.agent_address.toLowerCase()}
              and action <> 'pass' and paper = false`;
        const markets = rows.map((r) => getAddress(r.market) as Address);
        const positions = await loadAgentPositions(agent, markets);
        if (positions.length === 0) {
            console.log("no open positions to exit.");
            return;
        }

        // Smallest position by shares — least funds at risk.
        const pos = positions.reduce((a, b) => (a.shares <= b.shares ? a : b));
        const side = pos.outcome === Outcome.Yes ? "YES" : "NO";
        const sellShares = pos.shares / 4n; // 25%
        console.log(
            `target: ${pos.market} ${side}  held=${sh(pos.shares)}sh  ` +
                `selling 25% = ${sh(sellShares)}sh`,
        );
        if (sellShares <= 0n) {
            console.log("position too small to slice 25% — skipping sell.");
        } else {
            // ── 1. SELL ──────────────────────────────────────────────────────
            const proceeds = await quoteExit(pos.market, pos.outcome, sellShares);
            const minReceived = (proceeds * (10_000n - SLIPPAGE_BPS)) / 10_000n;
            console.log(
                `  quote=${usd(proceeds)}  minReceived=${usd(minReceived)}`,
            );
            const before = await shareBalance(pos.market, pos.outcome, agent);
            const { txId } = await executeDeveloperContractCall({
                walletId: p.circle_wallet_id,
                contractAddress: pos.market,
                abiFunctionSignature: "sell(uint8,uint256,uint256)",
                abiParameters: [
                    pos.outcome,
                    sellShares.toString(),
                    minReceived.toString(),
                ],
            });
            console.log(`  sell tx submitted: ${txId} — waiting…`);
            const hash = await waitForDeveloperTransaction(txId);
            const after = await shareBalance(pos.market, pos.outcome, agent);
            const ok = after < before;
            console.log(
                `  CONFIRMED ${hash}\n  shares ${sh(before)} → ${sh(after)}  ` +
                    `${ok ? "OK (decreased)" : "BAD (no decrease)"}`,
            );
            if (!ok) throw new Error("sell did not reduce share balance");
        }

        // ── 2. WITHDRAW ──────────────────────────────────────────────────────
        const balBefore = await usdcBalance(agent);
        const ownerBefore = await usdcBalance(owner);
        const amount = balBefore < WITHDRAW_MICRO ? balBefore : WITHDRAW_MICRO;
        console.log(
            `\nwithdraw ${usd(amount)} → owner  (agent bal ${usd(balBefore)})`,
        );
        if (amount === 0n) {
            console.log("  agent wallet empty — skipping withdraw.");
        } else {
            const { txId } = await transferFromDeveloperWallet({
                walletId: p.circle_wallet_id,
                destinationAddress: owner,
                amountMicro: amount,
            });
            console.log(`  transfer tx submitted: ${txId} — waiting…`);
            const hash = await waitForDeveloperTransaction(txId);
            const balAfter = await usdcBalance(agent);
            const ownerAfter = await usdcBalance(owner);
            const ok = balAfter < balBefore && ownerAfter > ownerBefore;
            console.log(
                `  CONFIRMED ${hash}\n  agent ${usd(balBefore)} → ${usd(balAfter)}` +
                    `  owner ${usd(ownerBefore)} → ${usd(ownerAfter)}  ` +
                    `${ok ? "OK" : "BAD"}`,
            );
            if (!ok) throw new Error("withdraw did not move funds as expected");
        }

        console.log("\nWRITE SMOKE PASS — sell + transfer confirmed on-chain.");
    } finally {
        await sql.end();
    }
}

main().catch((e) => {
    console.error("WRITE SMOKE ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
});
