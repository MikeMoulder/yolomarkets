/**
 * Sweep all native funds from standalone EOAs into one recipient.
 *
 * Defaults to dry-run. Pass --live to broadcast.
 *
 * Run:
 *   npm run wallets:standalone:sweep
 *   npm run wallets:standalone:sweep -- --live
 */
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    formatEther,
    http,
    isAddress,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env"), quiet: true });

type WalletEntry = {
    id: string;
    address: Address;
    privateKey: `0x${string}`;
};

type WalletConfig = {
    version: 1;
    chainId: number;
    target: "standalone-sweep";
    wallets: WalletEntry[];
};

const DEFAULT_RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_CHAIN_ID = 5042002;
const DEFAULT_RECIPIENT = "0xdfB1E9b15e93824dAD19C0E8Bf06a1b28DcEb901";
const DEFAULT_WALLETS_FILE = path.resolve(
    __dirname,
    "..",
    "..",
    "config",
    "standalone-sweep.wallets.json",
);
const DEFAULT_GAS_LIMIT = 21_000n;

function argValue(name: string): string | undefined {
    const prefix = `${name}=`;
    const exact = process.argv.indexOf(name);
    if (exact >= 0) return process.argv[exact + 1];
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function shortError(err: unknown): string {
    if (err instanceof Error) return err.message.slice(0, 500);
    return String(err).slice(0, 500);
}

async function loadJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T;
}

function parseWallets(config: WalletConfig, expectedChainId: number): Array<{ entry: WalletEntry; account: Account }> {
    if (config.version !== 1 || config.target !== "standalone-sweep") {
        throw new Error("Unsupported wallet config. Expected target=standalone-sweep version=1.");
    }
    if (config.chainId !== expectedChainId) {
        throw new Error(`Wallet config chainId=${config.chainId}; expected ${expectedChainId}`);
    }

    return config.wallets.map((entry) => {
        const account = privateKeyToAccount(entry.privateKey);
        if (account.address.toLowerCase() !== entry.address.toLowerCase()) {
            throw new Error(`Wallet ${entry.id} address does not match private key`);
        }
        return { entry, account };
    });
}

async function main() {
    const live = process.argv.includes("--live");
    const walletsPath = path.resolve(argValue("--wallets") ?? process.env.STANDALONE_WALLETS_FILE ?? DEFAULT_WALLETS_FILE);
    const recipientRaw = argValue("--to") ?? process.env.SWEEP_RECIPIENT ?? DEFAULT_RECIPIENT;
    const rpcUrl = argValue("--rpc-url") ?? process.env.ARC_TESTNET_RPC_URL ?? DEFAULT_RPC_URL;
    const chainId = Number(argValue("--chain-id") ?? process.env.ARC_TESTNET_CHAIN_ID ?? DEFAULT_CHAIN_ID);
    const gasLimit = BigInt(argValue("--gas-limit") ?? process.env.SWEEP_GAS_LIMIT ?? DEFAULT_GAS_LIMIT);

    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error("--chain-id must be a positive integer");
    }
    if (!isAddress(recipientRaw)) {
        throw new Error(`Invalid recipient address: ${recipientRaw}`);
    }

    const recipient = recipientRaw as Address;
    const chain = defineChain({
        id: chainId,
        name: `Chain ${chainId}`,
        nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const config = await loadJson<WalletConfig>(walletsPath);
    const wallets = parseWallets(config, chainId);
    const gasPrice = await publicClient.getGasPrice();
    const gasCost = gasLimit * gasPrice;

    console.log(`[sweep] wallets=${wallets.length} file=${walletsPath}`);
    console.log(`[sweep] to=${recipient} chainId=${chainId} mode=${live ? "LIVE" : "DRY_RUN"}`);
    console.log(`[sweep] gasLimit=${gasLimit} gasPrice=${gasPrice} gasCost=${formatEther(gasCost)}`);

    let totalPlanned = 0n;
    let totalSent = 0n;
    let skipped = 0;
    let failed = 0;

    for (const { entry, account } of wallets) {
        const balance = await publicClient.getBalance({ address: account.address });
        if (balance <= gasCost) {
            skipped += 1;
            console.log(
                `[sweep] skip ${entry.id} ${account.address} balance=${formatEther(balance)} <= gas=${formatEther(gasCost)}`,
            );
            continue;
        }

        const value = balance - gasCost;
        totalPlanned += value;
        if (!live) {
            console.log(`[sweep] dry-run ${entry.id} ${account.address} -> ${recipient} value=${formatEther(value)}`);
            continue;
        }

        try {
            const walletClient = createWalletClient({
                account,
                chain,
                transport: http(rpcUrl),
            });
            const tx = await walletClient.sendTransaction({
                account,
                chain,
                to: recipient,
                value,
                gas: gasLimit,
                gasPrice,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            totalSent += value;
            console.log(`[sweep] sent ${entry.id} value=${formatEther(value)} tx=${tx}`);
        } catch (err) {
            failed += 1;
            console.warn(`[sweep] failed ${entry.id} ${account.address}: ${shortError(err)}`);
        }
    }

    console.log(
        `[sweep] done planned=${formatEther(totalPlanned)} sent=${formatEther(totalSent)} skipped=${skipped} failed=${failed}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
