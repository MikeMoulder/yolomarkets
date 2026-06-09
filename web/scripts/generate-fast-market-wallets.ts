/**
 * Generate locally-held EOA wallets for the fast market swarm.
 *
 * Run:
 *   npm run markets:fast:wallets
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";

type WalletEntry = {
    id: string;
    address: string;
    privateKey: `0x${string}`;
    target: "fast-markets";
};

type WalletConfig = {
    version: 1;
    createdAt: string;
    chainId: number;
    target: "fast-markets";
    fundingHintUsdc: string;
    wallets: WalletEntry[];
};

const DEFAULT_COUNT = 20;
const DEFAULT_OUT = path.resolve(
    __dirname,
    "..",
    "..",
    "config",
    "fast-market-swarm.wallets.json",
);

function argValue(name: string): string | undefined {
    const prefix = `${name}=`;
    const exact = process.argv.indexOf(name);
    if (exact >= 0) return process.argv[exact + 1];
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function exists(file: string): Promise<boolean> {
    try {
        await stat(file);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const countRaw = argValue("--count");
    const outRaw = argValue("--out") ?? process.env.FAST_SWARM_WALLETS_CONFIG;
    const force = process.argv.includes("--force");

    const count = countRaw ? Number(countRaw) : DEFAULT_COUNT;
    if (!Number.isInteger(count) || count <= 0 || count > 200) {
        throw new Error("--count must be an integer between 1 and 200");
    }

    const outPath = path.resolve(outRaw ?? DEFAULT_OUT);
    if (!force && (await exists(outPath))) {
        throw new Error(`${outPath} already exists; pass --force to overwrite`);
    }

    const wallets: WalletEntry[] = Array.from({ length: count }, (_, i) => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);
        return {
            id: `fast-${String(i + 1).padStart(2, "0")}`,
            address: account.address,
            privateKey,
            target: "fast-markets",
        };
    });

    const config: WalletConfig = {
        version: 1,
        createdAt: new Date().toISOString(),
        chainId: arcTestnet.id,
        target: "fast-markets",
        fundingHintUsdc: "40",
        wallets,
    };

    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    console.log(`[wallets] wrote ${wallets.length} wallets to ${outPath}`);
    for (const wallet of wallets) {
        console.log(`${wallet.id} ${wallet.address}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
