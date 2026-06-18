/**
 * One-shot: create a Circle Developer-Controlled Wallet Set and print its ID
 * so you can paste it into .env as CIRCLE_WALLET_SET_ID.
 *
 * Every `/developer/wallets` creation request must reference a wallet set
 * (Circle returns "'walletSetId' field may not be empty" otherwise). This
 * is the missing bootstrap step between registering the entity secret and
 * provisioning per-user agent wallets.
 *
 * Run once per environment (sandbox / production). The wallet set is a
 * durable container; you reuse the same CIRCLE_WALLET_SET_ID for every
 * wallet you create afterwards.
 *
 * Why raw fetch and not the SDK: mirrors scripts/register-circle-entity-secret.ts
 * — this repo deliberately avoids the @circle-fin SDK for one-time bootstrap
 * steps. The wire format is short and the encryption is identical.
 *
 * Usage (from repo root):
 *   npx tsx scripts/create-circle-wallet-set.ts ["wallet set name"]
 *   # → prints the wallet set ID; paste into .env as CIRCLE_WALLET_SET_ID
 *
 * Requires CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env (run
 * register-circle-entity-secret.ts first if the secret isn't set).
 */
import { randomBytes, publicEncrypt, constants } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inline .env loader — keeps this script runnable from the repo root with a
// bare `npx tsx`, no dependency on dotenv (which lives only in web/).
function loadEnvFile(path: string): void {
    let text: string;
    try {
        text = readFileSync(path, "utf-8");
    } catch {
        return; // missing .env is fine — caller checks for required vars
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (!/^["']/.test(val)) {
            const hash = val.indexOf(" #");
            if (hash > 0) val = val.slice(0, hash).trim();
        }
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

loadEnvFile(resolve(__dirname, "..", ".env"));

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
    console.error(
        "CIRCLE_API_KEY missing in .env. Generate one at console.circle.com → API and client keys.",
    );
    process.exit(1);
}

const entitySecretHex = process.env.CIRCLE_ENTITY_SECRET;
if (!entitySecretHex || entitySecretHex.length !== 64) {
    console.error(
        "CIRCLE_ENTITY_SECRET must be 64 hex chars in .env. Run scripts/register-circle-entity-secret.ts first.",
    );
    process.exit(1);
}

const BASE = "https://api.circle.com/v1/w3s";
const name = process.argv[2] || "yolo-agent-wallets";

async function fetchProjectPublicKey(): Promise<string> {
    const res = await fetch(`${BASE}/config/entity/publicKey`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
        throw new Error(
            `Circle publicKey fetch failed: ${res.status} ${await res.text()}`,
        );
    }
    const json = (await res.json()) as { data?: { publicKey?: string } };
    if (!json.data?.publicKey)
        throw new Error("Response missing data.publicKey");
    return json.data.publicKey;
}

// Each state-changing call needs a FRESH ciphertext — OAEP padding is
// randomised, so we re-encrypt the same secret per request. Mirrors
// _encrypt_entity_secret() in agent/circle_wallets.py.
function encryptEntitySecret(pem: string): string {
    const secret = Buffer.from(entitySecretHex as string, "hex");
    return publicEncrypt(
        {
            key: pem,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        secret,
    ).toString("base64");
}

async function createWalletSet(ciphertext: string): Promise<{
    id: string;
    name?: string;
    custodyType?: string;
}> {
    const res = await fetch(`${BASE}/developer/walletSets`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            idempotencyKey: randomBytes(16).toString("hex"),
            entitySecretCiphertext: ciphertext,
            name,
        }),
    });
    if (!res.ok) {
        throw new Error(
            `Create wallet set failed: ${res.status} ${await res.text()}`,
        );
    }
    const json = (await res.json()) as {
        data?: { walletSet?: { id?: string; name?: string; custodyType?: string } };
    };
    const ws = json.data?.walletSet;
    if (!ws?.id) throw new Error("Response missing data.walletSet.id");
    return { id: ws.id, name: ws.name, custodyType: ws.custodyType };
}

async function main() {
    console.log("Fetching Circle project public key…");
    const pem = await fetchProjectPublicKey();

    console.log(`Creating wallet set "${name}"…`);
    const ws = await createWalletSet(encryptEntitySecret(pem));

    console.log("");
    console.log("✓ Wallet set created.");
    console.log(`  custodyType: ${ws.custodyType ?? "DEVELOPER"}`);
    console.log("");
    console.log("Add this to .env as CIRCLE_WALLET_SET_ID:");
    console.log("");
    console.log(`  ${ws.id}`);
    console.log("");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
