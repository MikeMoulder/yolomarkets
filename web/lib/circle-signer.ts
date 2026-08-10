/**
 * A Circle-backed EIP-712 signer for Circle Nanopayments.
 *
 * Nanopayments settle as an EIP-3009 `TransferWithAuthorization` signature, and
 * the payment SDK normally wants a raw private key. That is fine for a platform
 * wallet we control, but it is exactly wrong for *user* agent wallets: those are
 * held in Circle's MPC and no private key exists to hand over.
 *
 * The SDK's `BatchEvmSigner` is only `{ address, signTypedData }`, so we can
 * satisfy it by delegating the signature to Circle. The result: a user's agent
 * wallet pays for services from its own balance, and we never hold its key.
 *
 * TWO REQUIREMENTS THAT ARE EASY TO GET WRONG
 *
 * 1. The wallet must be `accountType: "EOA"`. Circle SCA (smart-contract)
 *    wallets cannot produce an EIP-3009 signature, so nanopayments are
 *    impossible from them. Account type is fixed at creation — it cannot be
 *    changed later.
 *
 * 2. Circle validates the typed-data document strictly and requires the
 *    `EIP712Domain` type to be declared in `types`. viem-style callers omit it
 *    (viem derives it), so we reconstruct it from whichever domain fields are
 *    present, in the canonical EIP-712 order. Without this Circle answers
 *    400 `"there is extra data provided in the message"`, which does not
 *    obviously point at the missing type.
 */
import crypto from "node:crypto";

const CIRCLE_BASE = "https://api.circle.com/v1/w3s";

type TypedDataParams = {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
};

export type CircleSigner = {
    address: `0x${string}`;
    signTypedData: (params: TypedDataParams) => Promise<`0x${string}`>;
};

function apiKey(): string {
    const k = process.env.CIRCLE_API_KEY;
    if (!k) throw new Error("CIRCLE_API_KEY is not set");
    return k;
}

let cachedPublicKey: string | null = null;

async function projectPublicKey(): Promise<string> {
    if (cachedPublicKey) return cachedPublicKey;
    const r = await fetch(`${CIRCLE_BASE}/config/entity/publicKey`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Circle publicKey fetch failed (${r.status})`);
    const j = (await r.json()) as { data: { publicKey: string } };
    cachedPublicKey = j.data.publicKey;
    return cachedPublicKey;
}

/** RSA-OAEP-SHA256 encrypt the 32-byte entity secret; Circle wants base64. */
async function entitySecretCiphertext(): Promise<string> {
    const hex = process.env.CIRCLE_ENTITY_SECRET ?? "";
    if (hex.length !== 64) {
        throw new Error("CIRCLE_ENTITY_SECRET must be 64 hex chars — see CIRCLE_SETUP.md");
    }
    const encrypted = crypto.publicEncrypt(
        {
            key: await projectPublicKey(),
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        Buffer.from(hex, "hex"),
    );
    return encrypted.toString("base64");
}

/** Canonical EIP-712 domain field order — Circle rejects other orderings. */
const DOMAIN_FIELDS: Array<[string, string]> = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
];

/**
 * The payment SDK passes bigints for `value`, `validAfter`, `validBefore` and
 * `chainId`. `JSON.stringify` throws on those, and Circle expects decimal
 * strings anyway, so convert on the way out.
 */
function stringifyTypedData(doc: unknown): string {
    return JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function domainType(domain: Record<string, unknown>) {
    return DOMAIN_FIELDS.filter(([n]) => domain[n] !== undefined).map(([name, type]) => ({
        name,
        type,
    }));
}

/**
 * Build a signer that satisfies the payment SDK but keeps the key in Circle.
 *
 * @param walletId Circle wallet id (UUID), NOT the on-chain address
 * @param address  the wallet's on-chain address
 */
export function createCircleSigner(walletId: string, address: `0x${string}`): CircleSigner {
    return {
        address,
        async signTypedData(params: TypedDataParams): Promise<`0x${string}`> {
            const typed = {
                types: {
                    // Re-add what viem-style callers omit; see note (2) above.
                    EIP712Domain: domainType(params.domain),
                    ...params.types,
                },
                primaryType: params.primaryType,
                domain: params.domain,
                message: params.message,
            };

            const r = await fetch(`${CIRCLE_BASE}/developer/sign/typedData`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey()}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    walletId,
                    data: stringifyTypedData(typed),
                    entitySecretCiphertext: await entitySecretCiphertext(),
                }),
                signal: AbortSignal.timeout(45_000),
            });

            const body = (await r.json()) as {
                data?: { signature?: string };
                message?: string;
            };
            if (!r.ok || !body.data?.signature) {
                throw new Error(
                    `Circle typed-data signing failed (${r.status}): ${body.message ?? "no signature returned"}`,
                );
            }
            return body.data.signature as `0x${string}`;
        },
    };
}
