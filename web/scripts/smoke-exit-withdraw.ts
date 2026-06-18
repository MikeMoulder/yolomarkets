/**
 * Read-only smoke for the manual-exit / withdraw feature.
 *
 * Exercises the live read pipeline that powers the positions panel + the GET
 * sides of the exit/withdraw routes, against real Arc testnet state:
 *   1. pick a profile with a Circle agent wallet from the DB
 *   2. loadAgentPositions() across its broadcast-traded markets
 *   3. read the agent wallet USDC balance (the withdraw GET path)
 *   4. quoteExit() at full + 50% for any open position (the exit GET path)
 *
 * Does NOT broadcast sell()/transfer — those move real funds. This proves the
 * reads function end-to-end; the write paths reuse the same Circle helpers as
 * agent/smoke_trading.py, which is already verified.
 *
 * Run from web/:  node_modules/.bin/tsx scripts/smoke-exit-withdraw.ts
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import postgres from "postgres";
import { getAddress, type Address } from "viem";

// Load repo-root .env too (DATABASE_URL / RPC live there).
loadEnv({ path: "../.env" });
loadEnv({ path: ".env" });

import { loadAgentPositions, quoteExit } from "../lib/agent-positions";
import { publicClient } from "../lib/markets";
import { ADDRESSES, erc20Abi, Outcome } from "../lib/contracts";

function usd(micro: bigint): string {
    return `$${(Number(micro) / 1e6).toFixed(4)}`;
}
function sh(micro: bigint): string {
    return (Number(micro) / 1e6).toFixed(2);
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    const sql = postgres(url, { max: 1 });

    let failures = 0;
    try {
        const profiles = await sql<
            { user_addr: string; agent_address: string; circle_wallet_id: string }[]
        >`select user_addr, agent_address, circle_wallet_id
          from agent_profiles
          where circle_wallet_id is not null and agent_address is not null
          limit 5`;

        console.log(`[0] profiles with agent wallet: ${profiles.length}`);
        if (profiles.length === 0) {
            console.log("    no Circle-backed profiles — nothing to smoke. PASS (vacuous)");
            return;
        }

        for (const p of profiles) {
            const agent = getAddress(p.agent_address) as Address;
            console.log(`\n=== ${p.user_addr}  agent=${agent} ===`);

            // Markets this agent actually broadcast trades into.
            const rows = await sql<{ market: string }[]>`
                select distinct market from agent_decisions
                where agent_addr = ${p.agent_address.toLowerCase()}
                  and action <> 'pass' and paper = false`;
            const markets = rows.map((r) => getAddress(r.market) as Address);
            console.log(`[1] traded markets: ${markets.length}`);

            // Wallet balance (withdraw GET path).
            const bal = (await publicClient.readContract({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [agent],
            })) as bigint;
            console.log(`[2] agent USDC balance: ${usd(bal)}`);

            // Open positions (positions panel + exit candidates).
            const positions = await loadAgentPositions(agent, markets);
            console.log(`[3] open positions: ${positions.length}`);

            for (const pos of positions) {
                const side = pos.outcome === Outcome.Yes ? "YES" : "NO";
                console.log(
                    `    ${pos.market} ${side}  held=${sh(pos.shares)}sh  ` +
                        `fullExit=${usd(pos.exitProceeds)}`,
                );
                // quoteExit at 50% (exit GET path) — sanity: 0 < half <= full.
                const half = pos.shares / 2n;
                if (half > 0n) {
                    const q = await quoteExit(pos.market, pos.outcome, half);
                    const ok = q > 0n && q <= pos.exitProceeds + 1n;
                    console.log(
                        `      50% quote=${usd(q)}  ${ok ? "OK" : "BAD (monotonicity)"}`,
                    );
                    if (!ok) failures++;
                }
            }
        }
    } finally {
        await sql.end();
    }

    if (failures > 0) {
        console.error(`\nSMOKE FAILED: ${failures} bad quote(s)`);
        process.exit(1);
    }
    console.log("\nSMOKE PASS — read pipeline healthy.");
}

main().catch((e) => {
    console.error("SMOKE ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
});
