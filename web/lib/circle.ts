/**
 * Minimal Circle User-Controlled Wallets API client.
 *
 * We do not depend on `@circle-fin/user-controlled-wallets` (the official
 * server SDK) for two reasons:
 *   1. The repo already keeps deps tight (raw `viem` over a wagmi-style
 *      higher-level abstraction; `postgres-js` over Prisma; etc.). A 200KB
 *      SDK for ~6 endpoints is overkill.
 *   2. Pinning the wire format here makes Console-config issues easier to
 *      diagnose — we always know exactly what bytes go on the wire.
 *
 * REQUIRES the following env vars (see .env.example):
 *   CIRCLE_API_KEY       — TEST API key from console.circle.com
 *   CIRCLE_ENTITY_SECRET — 64-hex-char secret you generated locally; the
 *                          ciphertext is sent on every state-changing call
 *   CIRCLE_APP_ID        — your project's "App ID" from Console
 *   CIRCLE_WALLET_SET_ID — Developer-Controlled Wallets wallet set ID
 *
 * The Console setup is documented in CIRCLE_SETUP.md at the repo root.
 */

import "server-only";
import { randomUUID, publicEncrypt, constants, createHash } from "node:crypto";

const CIRCLE_BASE = "https://api.circle.com/v1/w3s";

// Arc Testnet blockchain identifier in Circle's catalog. If Circle docs
// later use a different slug, override via CIRCLE_BLOCKCHAIN — Arc is new
// and the slug may shift before GA.
export const CIRCLE_BLOCKCHAIN =
    process.env.CIRCLE_BLOCKCHAIN ?? "ARC-TESTNET";

// Pulled lazily because route handlers run module-scope code at build time
// in some Next setups; missing keys shouldn't break the build.
function requireEnv(name: string): string {
    const v = process.env[name]?.trim();
    if (!v)
        throw new Error(
            `${name} is required for Circle wallets — see CIRCLE_SETUP.md`,
        );
    return v;
}

// ── Entity-secret ciphertext ──────────────────────────────────────────────
// Every state-changing Circle call carries an `entitySecretCiphertext` field:
// the entity secret encrypted with Circle's per-project RSA public key, in
// RSA-OAEP-SHA256, base64-encoded. The ciphertext is single-use — Circle
// rotates it server-side per request, so we recompute each call.
//
// Circle exposes the project's RSA public key via GET /v1/w3s/config/entity/
// publicKey. We cache it in-memory for the process lifetime; it changes only
// when you rotate the entity secret in Console.

let _publicKeyPem: string | null = null;

async function getProjectPublicKey(): Promise<string> {
    if (_publicKeyPem) return _publicKeyPem;
    const res = await fetch(`${CIRCLE_BASE}/config/entity/publicKey`, {
        headers: {
            Authorization: `Bearer ${requireEnv("CIRCLE_API_KEY")}`,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
            `Circle publicKey fetch failed: ${res.status} ${body.slice(0, 200)}`,
        );
    }
    const json = (await res.json()) as { data?: { publicKey?: string } };
    const pem = json.data?.publicKey;
    if (!pem) throw new Error("Circle publicKey response missing data.publicKey");
    _publicKeyPem = pem;
    return pem;
}

async function encryptEntitySecret(): Promise<string> {
    const secret = requireEnv("CIRCLE_ENTITY_SECRET");
    // The entity secret is a 64-hex-char string; we encrypt the raw bytes.
    const plain = Buffer.from(secret, "hex");
    if (plain.length !== 32) {
        throw new Error(
            "CIRCLE_ENTITY_SECRET must be 64 hex characters (32 bytes)",
        );
    }
    const pem = await getProjectPublicKey();
    const enc = publicEncrypt(
        {
            key: pem,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        plain,
    );
    return enc.toString("base64");
}

// ── Typed wrappers around the REST endpoints we use ───────────────────────

async function circlePost<T>(
    path: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const res = await fetch(`${CIRCLE_BASE}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${requireEnv("CIRCLE_API_KEY")}`,
            "Content-Type": "application/json",
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
            `Circle ${path} ${res.status}: ${errBody.slice(0, 300)}`,
        );
    }
    return (await res.json()) as T;
}

async function circleGet<T>(
    path: string,
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const res = await fetch(`${CIRCLE_BASE}${path}`, {
        headers: {
            Authorization: `Bearer ${requireEnv("CIRCLE_API_KEY")}`,
            ...extraHeaders,
        },
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
            `Circle ${path} ${res.status}: ${errBody.slice(0, 300)}`,
        );
    }
    return (await res.json()) as T;
}

// ── Email-OTP auth (identity only) ────────────────────────────────────────
// Since 2026-07-18 the email OTP is purely the auth layer: the browser SDK
// verifies the code and returns a userToken; getCurrentUser(userToken) gives
// the stable Circle user id we key custodial (Developer-Controlled) wallets
// on. No user-controlled wallets or PIN challenges are created anymore.

export type CircleEmailOtpToken = {
    deviceToken: string;
    deviceEncryptionKey: string;
    otpToken: string;
};

export async function createEmailOtpToken(opts: {
    email: string;
    deviceId: string;
    idempotencyKey?: string;
}): Promise<CircleEmailOtpToken> {
    const res = await circlePost<{ data: CircleEmailOtpToken }>(
        "/users/email/token",
        {
            idempotencyKey: opts.idempotencyKey ?? randomUUID(),
            deviceId: opts.deviceId,
            email: opts.email,
        },
    );
    return res.data;
}

export async function getCurrentUser(
    userToken: string,
): Promise<{ id: string; status?: string; pinStatus?: string }> {
    const res = await circleGet<{
        data: { id: string; status?: string; pinStatus?: string };
    }>("/user", { "X-User-Token": userToken });
    return res.data;
}

// ── Developer-Controlled Wallets for autonomous agent execution ───────────

export type CircleDeveloperWallet = {
    id: string;
    address: string;
    blockchain?: string;
    accountType?: string;
    state?: string;
};

function uuidV5Dns(name: string): string {
    const ns = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
    const hash = createHash("sha1").update(ns).update(name).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join("-");
}

// Developer-Controlled wallet for an email-login user. Same product as the
// agent wallets (server signs via entity secret) but keyed by the Circle user
// id from the email-OTP session, so repeat calls return the same wallet.
// This replaced the User-Controlled (PIN) wallet provisioning on 2026-07-18:
// Circle's PIN-setup challenges started failing with 155118 (backend-side,
// reproduced with provably matched pairs), so user wallets
// are custodial for now. Arcana-style UX: OTP in, wallet ready, no PIN.
export async function createDeveloperEmailWallet(
    circleUserId: string,
): Promise<CircleDeveloperWallet> {
    const walletSetId = requireEnv("CIRCLE_WALLET_SET_ID");
    const res = await circlePost<{ data: { wallets: CircleDeveloperWallet[] } }>(
        "/developer/wallets",
        {
            idempotencyKey: uuidV5Dns(`email-wallet-${circleUserId}`),
            walletSetId,
            blockchains: [CIRCLE_BLOCKCHAIN],
            accountType: "SCA",
            entitySecretCiphertext: await encryptEntitySecret(),
            // NB: metadata is one object PER wallet — its length must equal
            // `count` (Circle 155503 otherwise). The email lives in our DB.
            metadata: [{ name: "yolo_email_user", refId: circleUserId }],
            count: 1,
        },
    );
    const wallet = res.data.wallets[0];
    if (!wallet?.id || !wallet.address) {
        throw new Error("Circle returned no developer wallet");
    }
    return wallet;
}

export async function createDeveloperAgentWallet(
    userAddr: string,
): Promise<CircleDeveloperWallet> {
    const walletSetId = requireEnv("CIRCLE_WALLET_SET_ID");
    const res = await circlePost<{ data: { wallets: CircleDeveloperWallet[] } }>(
        "/developer/wallets",
        {
            idempotencyKey: uuidV5Dns(`agent-${userAddr.toLowerCase()}`),
            walletSetId,
            blockchains: [CIRCLE_BLOCKCHAIN],
            accountType: "SCA",
            entitySecretCiphertext: await encryptEntitySecret(),
            metadata: [{ name: "yolo_user", value: userAddr.toLowerCase() }],
            count: 1,
        },
    );
    const wallet = res.data.wallets[0];
    if (!wallet?.id || !wallet.address) {
        throw new Error("Circle returned no developer wallet");
    }
    return wallet;
}

// ── Developer-Controlled execution: contract calls & transfers ────────────
// The autonomous agent's wallets are Developer-Controlled (SCA). Their signing
// keys live in Circle's MPC behind our entity secret, so on-chain actions
// (sell to exit a position, withdraw USDC to the owner) are initiated here by
// the server, not by the user's EOA. This mirrors agent/circle_wallets.py:
//   execute_contract_call → POST /developer/transactions/contractExecution
//   transfer_usdc         → POST /developer/transactions/transfer
// Both return a Circle transaction id; poll getDeveloperTransaction() for the
// on-chain hash once the tx is CONFIRMED.

function attachGasStationPolicy(body: Record<string, unknown>): void {
    const policyId = process.env.CIRCLE_GAS_STATION_POLICY;
    if (policyId) body.feePayerPolicyId = policyId;
}

export async function executeDeveloperContractCall(p: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string; // e.g. "sell(uint8,uint256,uint256)"
    abiParameters: unknown[];
    idempotencyKey?: string;
}): Promise<{ txId: string }> {
    const body: Record<string, unknown> = {
        idempotencyKey: p.idempotencyKey ?? randomUUID(),
        walletId: p.walletId,
        contractAddress: p.contractAddress,
        abiFunctionSignature: p.abiFunctionSignature,
        abiParameters: p.abiParameters,
        feeLevel: "MEDIUM",
        entitySecretCiphertext: await encryptEntitySecret(),
    };
    attachGasStationPolicy(body);
    const res = await circlePost<{ data: { id: string } }>(
        "/developer/transactions/contractExecution",
        body,
    );
    return { txId: res.data.id };
}

export async function transferFromDeveloperWallet(p: {
    walletId: string;
    destinationAddress: string;
    amountMicro: bigint;
    idempotencyKey?: string;
}): Promise<{ txId: string }> {
    // Circle expects a decimal string in human units (not micro).
    const amountHuman = (Number(p.amountMicro) / 1_000_000).toFixed(6);
    const body: Record<string, unknown> = {
        idempotencyKey: p.idempotencyKey ?? randomUUID(),
        walletId: p.walletId,
        destinationAddress: p.destinationAddress,
        amounts: [amountHuman],
        tokenAddress:
            process.env.USDC_ADDRESS ??
            "0x3600000000000000000000000000000000000000",
        blockchain: CIRCLE_BLOCKCHAIN,
        feeLevel: "MEDIUM",
        entitySecretCiphertext: await encryptEntitySecret(),
    };
    attachGasStationPolicy(body);
    const res = await circlePost<{ data: { id: string } }>(
        "/developer/transactions/transfer",
        body,
    );
    return { txId: res.data.id };
}

export type CircleTxState =
    | "INITIATED"
    | "PENDING_RISK_SCREENING"
    | "QUEUED"
    | "SENT"
    | "CONFIRMED"
    | "COMPLETE"
    | "FAILED"
    | "CANCELLED";

export async function getDeveloperTransaction(
    txId: string,
): Promise<{ state: CircleTxState; txHash: string | null }> {
    const res = await circleGet<{
        data: { transaction: { state: CircleTxState; txHash?: string } };
    }>(`/transactions/${txId}`);
    const tx = res.data.transaction;
    return { state: tx.state, txHash: tx.txHash ?? null };
}

/**
 * Polls a developer transaction to a terminal state and returns the on-chain
 * hash. Throws if the tx FAILED/CANCELLED or did not confirm in time.
 */
export async function waitForDeveloperTransaction(
    txId: string,
    { pollMs = 2000, maxWaitMs = 120_000 }: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<string> {
    const terminal = new Set<CircleTxState>([
        "CONFIRMED",
        "COMPLETE",
        "FAILED",
        "CANCELLED",
    ]);
    let elapsed = 0;
    while (elapsed < maxWaitMs) {
        const { state, txHash } = await getDeveloperTransaction(txId);
        if (terminal.has(state)) {
            if (state === "FAILED" || state === "CANCELLED") {
                throw new Error(`Circle tx ${txId} ended in state ${state}`);
            }
            return txHash ?? txId;
        }
        await new Promise((r) => setTimeout(r, pollMs));
        elapsed += pollMs;
    }
    throw new Error(`Circle tx ${txId} not confirmed after ${maxWaitMs}ms`);
}
