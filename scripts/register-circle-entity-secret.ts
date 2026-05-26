/**
 * One-shot: generate a 32-byte entity secret, register it with Circle,
 * save the recovery file, and print the secret as 64 hex chars so you
 * can paste it into .env as CIRCLE_ENTITY_SECRET.
 *
 * Run once. After this, the secret never changes (unless you explicitly
 * rotate it via Console, which invalidates everything keyed off the old
 * one — wallets keep working but new state-changing calls have to use
 * the new ciphertext).
 *
 * Why this script and not the SDK's helper: this repo has not added
 * @circle-fin/user-controlled-wallets as a dep yet — we use raw fetch in
 * web/lib/circle.ts. Adding a 200KB SDK just for a one-time bootstrap
 * step is wasteful; the wire format here is short.
 *
 * Usage (from repo root):
 *   tsx scripts/register-circle-entity-secret.ts
 *   # → prints the hex secret; paste into .env as CIRCLE_ENTITY_SECRET
 *   # → also writes recovery_<timestamp>.dat alongside this script —
 *   #   stash that file somewhere safe; it's the ONLY way to recover.
 *
 * Requires CIRCLE_API_KEY in .env.
 */
import { randomBytes, publicEncrypt, constants } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inline .env loader — dotenv lives only in web/node_modules and we want
// this script runnable from the repo root with a bare `npx tsx`. The
// format is small: KEY=VALUE per line, # comments, optional quoted values.
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
        // Strip a single trailing inline comment if the value is unquoted.
        if (!/^["']/.test(val)) {
            const hash = val.indexOf(" #");
            if (hash > 0) val = val.slice(0, hash).trim();
        }
        // Strip matching surrounding quotes.
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        // Don't overwrite values already set in the real environment —
        // matches dotenv's default behavior.
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

const BASE = "https://api.circle.com/v1/w3s";

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

async function registerEntitySecret(opts: {
    pem: string;
    secret: Buffer;
}): Promise<{ recoveryFile: string }> {
    // RSA-OAEP-SHA256 over the raw 32 bytes, base64-encoded.
    const ciphertext = publicEncrypt(
        {
            key: opts.pem,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        opts.secret,
    ).toString("base64");

    const res = await fetch(`${BASE}/config/entity/entitySecret`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ entitySecretCiphertext: ciphertext }),
    });
    if (!res.ok) {
        throw new Error(
            `Register failed: ${res.status} ${await res.text()}`,
        );
    }
    const json = (await res.json()) as {
        data?: { recoveryFile?: string };
    };
    if (!json.data?.recoveryFile)
        throw new Error("Response missing data.recoveryFile");
    return { recoveryFile: json.data.recoveryFile };
}

async function main() {
    console.log("Generating 32-byte entity secret…");
    const secret = randomBytes(32);
    const hex = secret.toString("hex");

    console.log("Fetching Circle project public key…");
    const pem = await fetchProjectPublicKey();

    console.log("Registering encrypted secret with Circle…");
    const { recoveryFile } = await registerEntitySecret({ pem, secret });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryPath = resolve(__dirname, `recovery_${stamp}.dat`);
    writeFileSync(recoveryPath, recoveryFile);

    console.log("");
    console.log("✓ Entity secret registered.");
    console.log("");
    console.log("Add this to .env as CIRCLE_ENTITY_SECRET:");
    console.log("");
    console.log(`  ${hex}`);
    console.log("");
    console.log(`Recovery file written to: ${recoveryPath}`);
    console.log(
        "Stash that file somewhere safe — it's the only path back if",
    );
    console.log("you lose the secret. Do NOT commit it to git.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
