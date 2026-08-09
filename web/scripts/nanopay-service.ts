/**
 * Nanopay service — a thin HTTP bridge that lets the Python agent spend USDC
 * through Circle Nanopayments (Gateway batched x402) on Arc.
 *
 * Why a service and not a library call: `@circle-fin/x402-batching` is a
 * TypeScript/viem package and the trading agent is Python. Rather than
 * reimplement EIP-3009 signing in Python (and own that security surface), the
 * agent POSTs here and this process does the signing. `agent/x402.py` keeps its
 * existing `X402Receipt` shape, so loop.py and policy.py need no changes.
 *
 * Why an EOA: nanopayments settle as an EIP-3009 `TransferWithAuthorization`
 * signed against the GatewayWallet contract. Smart-contract-account wallets
 * are NOT supported, so the user's Circle SCA agent wallet can never be the
 * payer. This process holds a dedicated EOA (`NANOPAY_PAYER_PRIVATE_KEY`)
 * that is neither the factory admin nor the resolver.
 *
 * Spend control is deterministic and lives HERE, not in the model's prompt:
 * a per-payment cap plus a rolling daily cap, both enforced before any
 * signature is produced. The agent may ask to spend; it can never widen the
 * limit. Same philosophy as the `check_trade` risk gate.
 *
 * Run: npm run nanopay:service   (or `-- --once` to self-check and exit)
 */
import "./load-env";

import http from "node:http";
import { GatewayClient, BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { createCircleSigner } from "../lib/circle-signer";

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env.NANOPAY_PORT ?? 8090);
const CHAIN = (process.env.NANOPAY_CHAIN ?? "arcTestnet") as "arcTestnet";
const PRIVATE_KEY = process.env.NANOPAY_PAYER_PRIVATE_KEY as Hex | undefined;
const SHARED_SECRET = process.env.NANOPAY_SHARED_SECRET ?? "";

/**
 * RPC fallback list, tried in order.
 *
 * Do NOT put quicknode first here. It is the endpoint the *browser* wants
 * (gotcha #3: it sends CORS headers), but server-side that buys nothing and it
 * rate-limits `eth_call` brutally — measured 2026-08-05: one call succeeds,
 * every subsequent one returns `-32011 request limit reached`, while
 * blockdaemon / dRPC / the Arc default all answered 3/3. The Gateway deposit
 * path does an `allowance()` read before it can do anything, so a rate-limited
 * eth_call blocks the entire flow.
 */
const RPC_URLS = (
    process.env.NANOPAY_RPC_URLS ??
    process.env.NANOPAY_RPC_URL ??
    [
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://arc-testnet.drpc.org",
        "https://rpc.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
    ].join(",")
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Hard ceiling for a single payment, in USDC micro-units (6 dec). */
const MAX_PAYMENT_MICRO = BigInt(process.env.NANOPAY_MAX_PAYMENT_MICRO ?? "10000"); // $0.01
/** Default per-decision metering fee, USDC micro-units ($0.0001). */
const PRICE_FEE_MICRO = process.env.NANOPAY_FEE_MICRO ?? "100";
/** Rolling 24h ceiling across all payments, in USDC micro-units. */
const DAILY_CAP_MICRO = BigInt(process.env.NANOPAY_DAILY_CAP_MICRO ?? "1000000"); // $1.00

// ── Deterministic spend ledger ─────────────────────────────────────────────

type Debit = { at: number; micro: bigint };

/**
 * Ledgers are PER PAYER, not global.
 *
 * This service began with a single platform payer, where one ledger was
 * correct. It now also signs for each user's own payments wallet — and a shared
 * ledger meant every user drew down the same 24h cap, so one busy agent could
 * starve the others and the platform's own purchases. Keyed by payer address,
 * each wallet gets its own allowance.
 *
 * Still in-process and still resets on restart: the on-chain Gateway balance is
 * the real hard limit. This exists to stop a runaway loop, not to be a system
 * of record — settled payments are persisted by the agent into
 * `agent_decisions`, which is the durable trail.
 */
const ledgers = new Map<string, Debit[]>();

function ledgerFor(payer: string): Debit[] {
    const key = payer.toLowerCase();
    let l = ledgers.get(key);
    if (!l) {
        l = [];
        ledgers.set(key, l);
    }
    return l;
}

function spentLast24h(payer: string): bigint {
    const l = ledgerFor(payer);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let total = 0n;
    for (let i = l.length - 1; i >= 0; i--) {
        if (l[i].at < cutoff) break;
        total += l[i].micro;
    }
    return total;
}

function recordDebit(payer: string, micro: bigint): void {
    ledgerFor(payer).push({ at: Date.now(), micro });
}

function pruneDebits(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const l of ledgers.values()) {
        while (l.length && l[0].at < cutoff) l.shift();
    }
}

/** Returns a refusal reason, or null when the spend is allowed for this payer. */
function refuseSpend(micro: bigint, payer: string): string | null {
    if (micro <= 0n) return "amount must be positive";
    if (micro > MAX_PAYMENT_MICRO) {
        return `payment ${fmt(micro)} exceeds per-payment cap ${fmt(MAX_PAYMENT_MICRO)}`;
    }
    const spent = spentLast24h(payer);
    if (spent + micro > DAILY_CAP_MICRO) {
        return `payment ${fmt(micro)} would breach this wallet's 24h cap ${fmt(DAILY_CAP_MICRO)} (spent ${fmt(spent)})`;
    }
    return null;
}

function fmt(micro: bigint): string {
    return `$${(Number(micro) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

// ── Gateway client ─────────────────────────────────────────────────────────

let client: GatewayClient | null = null;
let activeRpc: string | null = null;

/**
 * Probe the fallback list with the exact call that fails under rate limiting —
 * an `eth_call` — and keep the first endpoint that answers.
 *
 * Probing up front rather than retrying mid-flight is deliberate: `deposit()`
 * broadcasts a transaction, and a naive "retry on a different RPC" wrapper
 * around a broadcast risks double-sending. Choosing a known-good endpoint
 * before any state-changing work avoids that class of bug entirely.
 */
async function pickRpc(): Promise<string> {
    if (activeRpc) return activeRpc;
    // `allowance(address,address)` with zero args — cheap, never reverts, and
    // is the same *method* the deposit path reads first, so a pass here means
    // the deposit can proceed. Two address words = 2 × 64 hex chars; getting
    // that length wrong makes the call revert and every RPC look unhealthy.
    const probe = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
            {
                to: "0x3600000000000000000000000000000000000000",
                data: "0xdd62ed3e" + "0".repeat(64) + "0".repeat(64),
            },
            "latest",
        ],
    };
    for (const url of RPC_URLS) {
        try {
            const r = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(probe),
                signal: AbortSignal.timeout(8000),
            });
            const j = (await r.json()) as { error?: { message?: string } };
            if (!j.error) {
                activeRpc = url;
                console.log(`[nanopay] rpc=${url}`);
                return url;
            }
            console.warn(`[nanopay] rpc rejected (${j.error.message}): ${url}`);
        } catch (e) {
            console.warn(
                `[nanopay] rpc unreachable (${e instanceof Error ? e.message : e}): ${url}`,
            );
        }
    }
    throw new Error(`no usable Arc RPC among: ${RPC_URLS.join(", ")}`);
}

/** The platform's own payer address — its ledger is separate from users'. */
function platformPayer(): string {
    return PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY).address : "platform";
}

function gateway(): GatewayClient {
    if (!PRIVATE_KEY) {
        throw new Error("NANOPAY_PAYER_PRIVATE_KEY is not set");
    }
    if (!client) {
        if (!activeRpc) {
            throw new Error("RPC not selected yet — call pickRpc() first");
        }
        client = new GatewayClient({
            chain: CHAIN,
            privateKey: PRIVATE_KEY,
            rpcUrl: activeRpc,
        });
        // Defence in depth. `handlePay` already prices and caps the call, but
        // this hook is the last gate before a signature exists at all: if any
        // path ever reaches `pay()` without going through the handler, an
        // over-cap payment still cannot be signed.
        client.onBeforePaymentCreation(async (ctx) => {
            const amount = BigInt(ctx.selectedRequirements?.amount ?? "0");
            const refusal = refuseSpend(amount, platformPayer());
            if (refusal) return { abort: true, reason: refusal };
        });
    }
    return client;
}

/** Ensure an RPC is selected, then hand back the client. */
async function ready(): Promise<GatewayClient> {
    await pickRpc();
    return gateway();
}

/**
 * `supports()` costs a network round-trip and its answer is a property of the
 * service, not of the moment, so cache it. This matters because the Circle
 * Discovery catalogue's `network` field does NOT reflect what a host will
 * actually negotiate — several hosts advertise only Base/Polygon yet settle on
 * Arc when asked by an Arc client, and most advertise categories but refuse
 * Arc entirely. Probing is the only reliable test; caching keeps it cheap.
 */
const supportsCache = new Map<string, { at: number; value: unknown }>();
const SUPPORTS_TTL_MS = Number(process.env.NANOPAY_SUPPORTS_TTL_MS ?? 3_600_000);

async function supportsCached(url: string): Promise<unknown> {
    const hit = supportsCache.get(url);
    if (hit && Date.now() - hit.at < SUPPORTS_TTL_MS) return hit.value;
    const value = await (await ready()).supports(url);
    supportsCache.set(url, { at: Date.now(), value });
    return value;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

/** bigint-safe JSON — the SDK returns bigints for every balance field. */
function toJson(value: unknown): string {
    return JSON.stringify(value, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
    );
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = toJson(body);
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function authorized(req: http.IncomingMessage): boolean {
    // Unset secret means "local trusted socket" — the same posture the agent
    // chat endpoint takes. Set it in any shared environment.
    if (!SHARED_SECRET) return true;
    return req.headers["x-nanopay-secret"] === SHARED_SECRET;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error("body is not valid JSON");
    }
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleBalance(res: http.ServerResponse): Promise<void> {
    const balances = await (await ready()).getBalances();
    pruneDebits();
    send(res, 200, {
        chain: CHAIN,
        balances,
        spendLast24hMicro: spentLast24h(platformPayer()).toString(),
        dailyCapMicro: DAILY_CAP_MICRO.toString(),
        maxPaymentMicro: MAX_PAYMENT_MICRO.toString(),
    });
}

async function handleSupports(res: http.ServerResponse, url: string): Promise<void> {
    send(res, 200, { url, result: await supportsCached(url) });
}

/**
 * Pay for an x402 resource. The caller may lower the ceiling with
 * `maxAmountMicro` but never raise it above `MAX_PAYMENT_MICRO`.
 */
async function handlePay(
    res: http.ServerResponse,
    body: Record<string, unknown>,
): Promise<void> {
    const url = typeof body.url === "string" ? body.url : "";
    if (!url) return send(res, 400, { error: "url is required" });

    // Price the call BEFORE signing anything, so the cap is applied to the
    // amount the service will actually charge rather than to a guess.
    const support = (await supportsCached(url)) as {
        supported?: boolean;
        requirements?: { amount?: string; network?: string; asset?: string };
    };
    if (!support?.supported || !support.requirements?.amount) {
        return send(res, 422, {
            error: "resource does not offer Gateway-batched payment on this chain",
            url,
            chain: CHAIN,
        });
    }

    const price = BigInt(support.requirements.amount);
    const callerCeiling =
        typeof body.maxAmountMicro === "string" ? BigInt(body.maxAmountMicro) : null;
    if (callerCeiling !== null && price > callerCeiling) {
        return send(res, 409, {
            error: "price exceeds caller ceiling",
            priceMicro: price.toString(),
            ceilingMicro: callerCeiling.toString(),
        });
    }

    const refusal = refuseSpend(price, platformPayer());
    if (refusal) return send(res, 429, { error: refusal, priceMicro: price.toString() });

    const started = Date.now();
    const result = await (await ready()).pay(url, {
        method: (body.method as "GET" | "POST" | undefined) ?? "GET",
        body: body.body,
        headers: (body.headers as Record<string, string> | undefined) ?? undefined,
    });

    // Debit only after the payment actually settled.
    recordDebit(platformPayer(), price);

    send(res, 200, {
        url,
        paid: true,
        amountMicro: price.toString(),
        amountUsdc: (Number(price) / 1e6).toFixed(6),
        network: support.requirements.network,
        asset: support.requirements.asset,
        elapsedMs: Date.now() - started,
        result,
    });
}

/**
 * Paid Arc RPC passthrough.
 *
 * This is the point of Leg B. QuickNode sells Arc testnet RPC as an x402
 * resource (`/arc-testnet/`) for $0.0001 a call, and that buys exactly what
 * the free endpoints refuse — notably `eth_call`, which quicknode's own free
 * tier rate-limits to about one per period (see CLAUDE.md gotcha #4) and which
 * every market read depends on.
 *
 * The response is the RAW JSON-RPC body, not a wrapper, so this URL is a
 * drop-in provider endpoint: point web3.py or viem at it and every call is
 * paid transparently.
 *
 * Cost is bounded by batching, not by sessions. We already aggregate reads
 * through Multicall3, so a full ~5,300-market scan is ~27 aggregate calls —
 * about $0.0027. (QuickNode does issue a 1h JWT session per payment, but the
 * SDK does not surface settlement-response extensions, so claiming it would
 * mean hand-rolling the x402 flow. Not worth it at these volumes.)
 */
const PAID_RPC_RESOURCE =
    process.env.NANOPAY_RPC_RESOURCE ?? "https://x402.quicknode.com/arc-testnet/";

async function handlePaidRpc(
    res: http.ServerResponse,
    body: Record<string, unknown> | unknown[],
): Promise<void> {
    const support = (await supportsCached(PAID_RPC_RESOURCE)) as {
        supported?: boolean;
        requirements?: { amount?: string };
    };
    if (!support?.supported || !support.requirements?.amount) {
        return send(res, 422, { error: "paid RPC resource unavailable", resource: PAID_RPC_RESOURCE });
    }
    const price = BigInt(support.requirements.amount);
    const refusal = refuseSpend(price, platformPayer());
    if (refusal) return send(res, 429, { error: refusal });

    const result = await (await ready()).pay<unknown>(PAID_RPC_RESOURCE, {
        method: "POST",
        body,
    });
    recordDebit(platformPayer(), price);

    // Raw JSON-RPC passthrough — keeps this usable as a provider URL.
    const payload = toJson(result.data);
    res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-nanopay-cost-micro": price.toString(),
    });
    res.end(payload);
}

/**
 * Metering fee paid BY A USER'S OWN AGENT WALLET.
 *
 * This is the piece that retires the old pseudo-x402 fee. Previously the agent
 * "paid" for reasoning with a plain USDC transfer that merely resembled x402.
 * Now the user's agent signs a real EIP-3009 authorization and Circle's
 * facilitator settles it on the same batched rail as every other nanopayment.
 *
 * Two things make it possible, both established the hard way:
 *   · the payer is a per-user **EOA** wallet — an SCA cannot produce this
 *     signature, which is why each profile carries a separate payments wallet;
 *   · the key stays in Circle's MPC and signing is delegated over the API
 *     (see lib/circle-signer.ts), so the platform never holds a user's key.
 *
 * There is deliberately no HTTP resource in the middle. A fee is not a remote
 * service, and standing up a 402 endpoint for the agent to pay itself through
 * would be ceremony, not settlement. The facilitator still requires `resource`
 * and `accepted` on the payload, so we describe the fee honestly and pass that.
 */
const facilitator = new BatchFacilitatorClient({
    url: process.env.CIRCLE_GATEWAY_URL ?? "https://gateway-api-testnet.circle.com",
});

async function handleFeePayment(
    res: http.ServerResponse,
    body: Record<string, unknown>,
): Promise<void> {
    const walletId = typeof body.walletId === "string" ? body.walletId : "";
    const address = typeof body.address === "string" ? body.address : "";
    const payTo = typeof body.payTo === "string" ? body.payTo : "";
    if (!walletId || !address || !payTo) {
        return send(res, 400, { error: "walletId, address and payTo are required" });
    }

    const amount = BigInt(
        typeof body.amountMicro === "string" ? body.amountMicro : PRICE_FEE_MICRO,
    );
    const refusal = refuseSpend(amount, address);
    if (refusal) return send(res, 429, { error: refusal, amountMicro: amount.toString() });

    const requirements = {
        scheme: "exact",
        network: "eip155:5042002",
        asset: "0x3600000000000000000000000000000000000000",
        amount: amount.toString(),
        payTo,
        // Batched authorizations must stay valid 7+ days or they expire before
        // the batch settles.
        maxTimeoutSeconds: 604900,
        extra: {
            name: "GatewayWalletBatched",
            version: "1",
            verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        },
    };
    const resource = {
        url: typeof body.resource === "string" ? body.resource : "yolo://agent/reasoning",
        description:
            typeof body.description === "string"
                ? body.description
                : "YOLO Markets agent reasoning — per-decision metering fee",
        mimeType: "application/json",
    };

    const signer = createCircleSigner(walletId, address as `0x${string}`);
    const started = Date.now();
    let signed;
    try {
        signed = await new BatchEvmScheme(signer as never).createPaymentPayload(
            2,
            requirements as never,
        );
    } catch (e) {
        return send(res, 502, {
            error: `signing failed: ${e instanceof Error ? e.message : String(e)}`,
        });
    }

    const settlement = await facilitator.settle(
        { ...signed, resource, accepted: requirements } as never,
        requirements as never,
    );
    if (!settlement?.success) {
        return send(res, 402, {
            error: settlement?.errorReason ?? "fee did not settle",
            amountMicro: amount.toString(),
        });
    }

    recordDebit(address, amount);
    send(res, 200, {
        paid: true,
        payer: address,
        payTo,
        amountMicro: amount.toString(),
        amountUsdc: (Number(amount) / 1e6).toFixed(6),
        network: settlement.network,
        transaction: settlement.transaction,
        elapsedMs: Date.now() - started,
    });
}

/**
 * Move USDC from the payer EOA's wallet balance into its Gateway balance.
 * This is the one onchain, gas-paying operation in the whole flow; everything
 * after it is gasless. Deliberately requires an explicit amount — no default —
 * because it spends real balance.
 */
async function handleDeposit(
    res: http.ServerResponse,
    body: Record<string, unknown>,
): Promise<void> {
    const amount = typeof body.amount === "string" ? body.amount : "";
    if (!amount) return send(res, 400, { error: "amount is required (decimal USDC string)" });
    const result = await (await ready()).deposit(amount);
    send(res, 200, { deposited: amount, result });
}

const server = http.createServer((req, res) => {
    void (async () => {
        try {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

            if (req.method === "GET" && ["/", "/health", "/healthz"].includes(url.pathname)) {
                return send(res, 200, {
                    ok: true,
                    chain: CHAIN,
                    // Derived from the key, not the client: /health must stay
                    // cheap and must answer even when every RPC is refusing.
                    payer: PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY).address : null,
                    rpc: activeRpc,
                    configured: Boolean(PRIVATE_KEY),
                });
            }

            if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

            if (req.method === "GET" && url.pathname === "/balance") {
                return await handleBalance(res);
            }
            if (req.method === "GET" && url.pathname === "/supports") {
                const target = url.searchParams.get("url");
                if (!target) return send(res, 400, { error: "url query param is required" });
                return await handleSupports(res, target);
            }
            if (req.method === "POST" && url.pathname === "/pay") {
                return await handlePay(res, await readBody(req));
            }
            if (req.method === "POST" && url.pathname === "/rpc") {
                // Raw JSON-RPC in, raw JSON-RPC out — may be an object or a
                // batch array, so it does not go through readBody's object type.
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                let parsed: Record<string, unknown> | unknown[];
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                    return send(res, 400, { error: "body is not valid JSON" });
                }
                return await handlePaidRpc(res, parsed);
            }
            if (req.method === "POST" && url.pathname === "/pay-fee") {
                return await handleFeePayment(res, await readBody(req));
            }
            if (req.method === "POST" && url.pathname === "/deposit") {
                return await handleDeposit(res, await readBody(req));
            }
            send(res, 404, { error: "not found" });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error("[nanopay] error:", message);
            send(res, 500, { error: message });
        }
    })();
});

async function selfCheck(): Promise<void> {
    console.log(`[nanopay] chain=${CHAIN} rpcCandidates=${RPC_URLS.length}`);
    if (!PRIVATE_KEY) {
        console.error("[nanopay] NANOPAY_PAYER_PRIVATE_KEY is not set — cannot run");
        process.exitCode = 1;
        return;
    }
    const g = await ready();
    console.log(`[nanopay] payer=${g.address}`);
    const balances = await g.getBalances();
    console.log(`[nanopay] balances=${toJson(balances)}`);
    console.log(
        `[nanopay] caps: per-payment ${fmt(MAX_PAYMENT_MICRO)}, 24h ${fmt(DAILY_CAP_MICRO)}`,
    );
}

async function main(): Promise<void> {
    if (process.argv.includes("--once")) {
        await selfCheck();
        return;
    }
    await selfCheck();
    server.listen(PORT, "127.0.0.1", () => {
        console.log(`[nanopay] listening on 127.0.0.1:${PORT}`);
    });
}

void main();
