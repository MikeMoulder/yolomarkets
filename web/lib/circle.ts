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

// ── High-level flow ────────────────────────────────────────────────────────
// Standard User-Controlled Wallets onboarding sequence:
//   1. createUser(userId)              — register the user
//   2. createUserToken(userId)         — get a userToken + encryptionKey to
//                                        hand to the Web SDK
//   3. initializeUserWithPin(userToken) — kick off PIN setup, get challengeId
//   4. (client) Web SDK runs the PIN UX, completes the challenge
//   5. listWallets(userToken)          — poll for the provisioned wallet
//                                        address (post-PIN this returns the
//                                        SCA wallet on Arc)

export type CircleUserToken = {
    userToken: string;
    encryptionKey: string;
};

export type CircleEmailOtpToken = {
    deviceToken: string;
    deviceEncryptionKey: string;
    otpToken: string;
};

export async function createCircleUser(): Promise<string> {
    // Circle assigns no userId itself; we generate one and own it.
    const userId = randomUUID();
    await circlePost("/users", { userId });
    return userId;
}

export async function createUserToken(
    userId: string,
): Promise<CircleUserToken> {
    const res = await circlePost<{
        data: { userToken: string; encryptionKey: string };
    }>("/users/token", { userId });
    return res.data;
}

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

export async function initializeUserPin(opts: {
    userToken: string;
    idempotencyKey?: string;
}): Promise<{ challengeId: string }> {
    const idem = opts.idempotencyKey ?? randomUUID();
    const res = await circlePost<{ data: { challengeId: string } }>(
        "/user/initialize",
        {
            idempotencyKey: idem,
            blockchains: [CIRCLE_BLOCKCHAIN],
            accountType: "SCA",
            entitySecretCiphertext: await encryptEntitySecret(),
        },
        { "X-User-Token": opts.userToken },
    );
    return { challengeId: res.data.challengeId };
}

export async function createUserWalletChallenge(opts: {
    userToken: string;
    idempotencyKey?: string;
}): Promise<{ challengeId: string }> {
    const res = await circlePost<{ data: { challengeId: string } }>(
        "/user/wallets",
        {
            idempotencyKey: opts.idempotencyKey ?? randomUUID(),
            blockchains: [CIRCLE_BLOCKCHAIN],
            accountType: "SCA",
        },
        { "X-User-Token": opts.userToken },
    );
    return { challengeId: res.data.challengeId };
}

export async function createSignMessageChallenge(opts: {
    userToken: string;
    message: string;
    walletId?: string | null;
    walletAddress?: string | null;
}): Promise<{ challengeId: string }> {
    const walletRef = opts.walletId
        ? { walletId: opts.walletId }
        : {
              walletAddress: opts.walletAddress,
              blockchain: CIRCLE_BLOCKCHAIN,
          };
    const res = await circlePost<{ data: { challengeId: string } }>(
        "/user/sign/message",
        {
            message: opts.message,
            encodedByHex: false,
            memo: "Sign in to YOLO Markets",
            ...walletRef,
        },
        { "X-User-Token": opts.userToken },
    );
    return { challengeId: res.data.challengeId };
}

export type CircleWallet = {
    id: string;
    address: string;
    blockchain: string;
    accountType: string;
    state: string;
};

export async function listUserWallets(
    userToken: string,
): Promise<CircleWallet[]> {
    const res = await circleGet<{ data: { wallets: CircleWallet[] } }>(
        "/wallets",
        { "X-User-Token": userToken },
    );
    return res.data.wallets;
}

// ── One-shot helper that the /api/circle/init route uses ──────────────────
// Wraps steps 1–3 into a single server call so the client makes one fetch
// and gets everything it needs to drive the Web SDK PIN UX.

export type InitOnboardingResult = {
    circleUserId: string;
    userToken: string;
    encryptionKey: string;
    challengeId: string;
};

export async function initOnboarding(
    existingCircleUserId?: string,
): Promise<InitOnboardingResult> {
    const circleUserId = existingCircleUserId ?? (await createCircleUser());
    const { userToken, encryptionKey } = await createUserToken(circleUserId);
    const { challengeId } = await initializeUserPin({ userToken });
    return { circleUserId, userToken, encryptionKey, challengeId };
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

// ── Gas Station: sponsored transactions ───────────────────────────────────
// Circle Gas Station sponsors USDC gas fees on Arc so a freshly-signed-up
// user can place a bet without first acquiring native gas USDC. The
// sponsorship is enforced server-side by Circle when a policy ID is
// attached to the contract-execution challenge.
//
// Wire format: POST /v1/w3s/user/transactions/contractExecution
//   { idempotencyKey, contractAddress, abiFunctionSignature, abiParameters,
//     feeLevel: "MEDIUM", walletId, ... , feePayerPolicyId }
//
// The client invokes this via /api/circle/sponsor-tx; the Web SDK then
// confirms the resulting challenge with the user's PIN, and Gas Station
// pays the fee.

export type SponsorContractCallParams = {
    userToken: string;
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string; // e.g. "buy(uint8,uint256,uint256)"
    abiParameters: unknown[];     // values, in solidity order
    idempotencyKey?: string;
};

export async function sponsorContractCall(
    p: SponsorContractCallParams,
): Promise<{ challengeId: string }> {
    const policyId = process.env.CIRCLE_GAS_STATION_POLICY;
    if (!policyId) {
        throw new Error(
            "CIRCLE_GAS_STATION_POLICY not set — enable Gas Station in " +
            "Console and add the policy ID to .env (see CIRCLE_SETUP.md §5)",
        );
    }
    const body: Record<string, unknown> = {
        idempotencyKey: p.idempotencyKey ?? randomUUID(),
        walletId: p.walletId,
        contractAddress: p.contractAddress,
        abiFunctionSignature: p.abiFunctionSignature,
        abiParameters: p.abiParameters,
        feeLevel: "MEDIUM",
        // The presence of feePayerPolicyId is what makes Circle route gas
        // payment through Gas Station instead of debiting the user wallet.
        feePayerPolicyId: policyId,
        entitySecretCiphertext: await encryptEntitySecret(),
    };
    const res = await circlePost<{ data: { challengeId: string } }>(
        "/user/transactions/contractExecution",
        body,
        { "X-User-Token": p.userToken },
    );
    return { challengeId: res.data.challengeId };
}
