/**
 * Wrap top-volume Polymarket binary markets into native YOLO markets on Arc.
 *
 * Run:
 *   npm run markets:poly:wrap -- --dry-run
 *   npm run markets:poly:wrap -- --limit 10 --seed-usdc 1
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    parseUnits,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi } from "../lib/contracts";
import {
    buildPolymarketMirrorCriteria,
    type PolymarketMirrorMeta,
} from "../lib/polymarket-mirror";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

const GAMMA_BASE =
    process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const MARKET_READ_BATCH_SIZE = 40;
const MARKET_READ_BATCH_DELAY_MS = 150;

type RawTag = { label?: string };
type RawMarket = {
    id: string;
    conditionId?: string;
    question?: string;
    slug?: string;
    outcomePrices?: string;
    outcomes?: string;
    clobTokenIds?: string;
    volume?: string | number;
    volumeNum?: number;
    volume24hr?: number;
    groupItemTitle?: string;
    closed?: boolean;
    endDate?: string;
    umaEndDate?: string;
    resolutionSource?: string;
    description?: string;
};
type RawEvent = {
    id: string;
    title?: string;
    slug?: string;
    description?: string;
    category?: string;
    tags?: RawTag[];
    endDate?: string;
    markets?: RawMarket[];
};

type Candidate = {
    title: string;
    category: string;
    criteria: string;
    deadline: bigint;
    volume24h: number;
    slug: string;
};

const TOP_CATEGORIES: { label: string; matches: string[] }[] = [
    { label: "Politics", matches: ["Politics", "Trump", "Elections", "Election", "US", "Biden", "Congress", "Senate"] },
    { label: "Crypto", matches: ["Crypto", "Bitcoin", "Ethereum", "BTC", "ETH", "Solana", "Memes"] },
    { label: "Sports", matches: ["Sports", "Soccer", "Football", "NBA", "NFL", "FIFA", "Baseball", "Hockey", "Tennis", "Boxing", "UFC", "MLB"] },
    { label: "Geopolitics", matches: ["Geopolitics", "Iran", "China", "Russia", "Ukraine", "War", "Middle East", "Israel"] },
    { label: "Tech", matches: ["Tech", "AI", "OpenAI", "ChatGPT", "SpaceX", "Apple"] },
    { label: "Macro", matches: ["Macro", "Economy", "Fed", "Inflation", "Recession", "Markets", "Stocks", "Interest Rates"] },
    { label: "Culture", matches: ["Pop Culture", "Movies", "Music", "Awards", "Celebrity", "Entertainment"] },
    { label: "Science", matches: ["Science", "Space", "Climate", "Health", "Medicine"] },
];

function arg(name: string, fallback: string): string {
    const ix = process.argv.indexOf(`--${name}`);
    return ix >= 0 ? (process.argv[ix + 1] ?? fallback) : fallback;
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

function getRpcUrl(): string {
    return process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]!;
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be 32-byte hex");
    }
    return key as `0x${string}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((x) => String(x));
    } catch {
        return [];
    }
}

function classifyCategory(tags: RawTag[] | undefined): string {
    if (!tags || tags.length === 0) return "Other";
    const labels = tags.map((t) => t.label).filter(Boolean) as string[];
    for (const cat of TOP_CATEGORIES) {
        if (labels.some((l) => cat.matches.includes(l))) return cat.label;
    }
    return labels.find((l) => !["Hide From New", "All"].includes(l)) ?? "Other";
}

function normalizeTitle(parentTitle: string, childLabel: string, isGroup: boolean): string {
    if (!isGroup) return parentTitle;

    const childNormalized = childLabel.toLowerCase();
    const parentNormalized = parentTitle.toLowerCase();
    if (childNormalized === parentNormalized) return parentTitle;
    if (childNormalized.includes(parentNormalized)) return childLabel;
    if (parentNormalized.includes(childNormalized)) return parentTitle;
    return `${parentTitle}: ${childLabel}`;
}

function deadlineFromMarket(
    m: RawMarket,
    e: RawEvent,
    nowSec: number,
    fallbackDurationDays: number,
    allowFallback: boolean,
): bigint | null {
    const rawDate = m.umaEndDate ?? m.endDate ?? e.endDate;
    if (rawDate) {
        const ts = Math.floor(new Date(rawDate).getTime() / 1000);
        if (Number.isFinite(ts) && ts > nowSec + 120) return BigInt(ts);
    }
    if (!allowFallback) return null;
    return BigInt(nowSec + fallbackDurationDays * 86_400);
}

function pickTokenIds(m: RawMarket): { yesTokenId: string | null; noTokenId: string | null } {
    const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const yesIndex = outcomes.findIndex((x) => x === "yes");
    const noIndex = outcomes.findIndex((x) => x === "no");

    return {
        yesTokenId: yesIndex >= 0 ? (tokenIds[yesIndex] ?? null) : (tokenIds[0] ?? null),
        noTokenId: noIndex >= 0 ? (tokenIds[noIndex] ?? null) : (tokenIds[1] ?? null),
    };
}

function candidatesFromEvents(
    events: RawEvent[],
    existingQuestions: Set<string>,
    nowSec: number,
    fallbackDurationDays: number,
    allowFallbackDeadlines: boolean,
): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const parentSeen = new Set<string>();

    for (const e of events) {
        const openMarkets = (e.markets ?? []).filter((m) => !m.closed && m.slug);
        if (openMarkets.length === 0) continue;

        const isGroup = openMarkets.length > 1;
        const marketsToWrap = isGroup
            ? [...openMarkets].sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0)).slice(0, 1)
            : openMarkets;

        const parentTitle = e.title?.trim() ?? "Untitled";
        const category = classifyCategory(e.tags);
        for (const m of marketsToWrap) {
            const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
            if (outcomes.length >= 2 && !outcomes.includes("yes")) continue;
            if (outcomes.length >= 2 && !outcomes.includes("no")) continue;

            const childLabel = m.groupItemTitle?.trim() || m.question?.trim();
            if (!childLabel || !m.slug) continue;

            const title = normalizeTitle(parentTitle, childLabel, isGroup).slice(0, 500);
            if (hasStaleImplicitDate(title, nowSec)) continue;

            const key = title.toLowerCase();
            if (seen.has(key) || parentSeen.has(e.id) || existingQuestions.has(key)) continue;

            const deadline = deadlineFromMarket(
                m,
                e,
                nowSec,
                fallbackDurationDays,
                allowFallbackDeadlines,
            );
            if (deadline === null) continue;
            seen.add(key);
            parentSeen.add(e.id);

            const tokens = pickTokenIds(m);
            const meta: PolymarketMirrorMeta = {
                version: 1,
                polymarketSlug: m.slug,
                eventSlug: e.slug ?? null,
                conditionId: m.conditionId ?? null,
                yesTokenId: tokens.yesTokenId,
                noTokenId: tokens.noTokenId,
                resolutionSource: m.resolutionSource ?? null,
                endDate: m.endDate ?? e.endDate ?? null,
                umaEndDate: m.umaEndDate ?? null,
            };

            const description = m.description ?? e.description ?? null;
            out.push({
                title,
                category,
                criteria: buildPolymarketMirrorCriteria(meta, description),
                deadline,
                volume24h: m.volume24hr ?? 0,
                slug: m.slug,
            });
        }
    }

    out.sort((a, b) => b.volume24h - a.volume24h);
    return out;
}

function hasStaleImplicitDate(title: string, nowSec: number): boolean {
    const months: Record<string, number> = {
        january: 0,
        jan: 0,
        february: 1,
        feb: 1,
        march: 2,
        mar: 2,
        april: 3,
        apr: 3,
        may: 4,
        june: 5,
        jun: 5,
        july: 6,
        jul: 6,
        august: 7,
        aug: 7,
        september: 8,
        sep: 8,
        october: 9,
        oct: 9,
        november: 10,
        nov: 10,
        december: 11,
        dec: 11,
    };
    const lower = title.toLowerCase();
    if (/\b20\d{2}\b/.test(lower)) return false;

    const match = lower.match(
        /\b(?:by|before|on|through)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/,
    );
    if (!match) return false;

    const now = new Date(nowSec * 1000);
    const month = months[match[1]];
    const day = Number(match[2]);
    if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
        return false;
    }

    const impliedDeadline = Date.UTC(now.getUTCFullYear(), month, day, 23, 59, 59);
    return impliedDeadline < now.getTime();
}

async function fetchGammaEvents(): Promise<RawEvent[]> {
    const params = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "300",
        order: "volume24hr",
        ascending: "false",
    });
    const res = await fetch(`${GAMMA_BASE}/events?${params}`, {
        headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Gamma fetch failed: ${res.status}`);
    return (await res.json()) as RawEvent[];
}

async function readExistingQuestions(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<Set<string>> {
    const addrs = (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];

    const questions: string[] = [];
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH_SIZE) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH_SIZE);
        const rows = await publicClient.multicall({
            allowFailure: true,
            contracts: batch.map((address) => ({
                address,
                abi: marketAbi,
                functionName: "question",
            })),
        });
        for (const row of rows) {
            if (row.status === "success" && typeof row.result === "string") {
                questions.push(row.result);
            }
        }
        if (i + MARKET_READ_BATCH_SIZE < addrs.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return new Set(questions.map((q) => q.trim().toLowerCase()));
}

async function ensureApproval(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: Account,
    minRequired: bigint,
) {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, ADDRESSES.factory],
    })) as bigint;
    if (allowance >= minRequired) return;

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.factory, (1n << 256n) - 1n],
        account,
        chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[poly-wrap] approved factory tx=${tx}`);
}

async function main() {
    const limit = Number(arg("limit", process.env.POLYMARKET_WRAP_LIMIT ?? "10"));
    const seedUsdc = parseUnits(arg("seed-usdc", process.env.POLYMARKET_WRAP_SEED_USDC ?? "1"), 6);
    const fallbackDurationDays = Number(arg("fallback-duration-days", "30"));
    const allowFallbackDeadlines = flag("allow-fallback-deadlines");
    const dryRun = flag("dry-run");
    const account = privateKeyToAccount(parsePrivateKey(env("DEPLOYER_PRIVATE_KEY")));
    const rpcUrl = getRpcUrl();
    const nowSec = Math.floor(Date.now() / 1000);

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: http(rpcUrl),
    });

    console.log(`[poly-wrap] account=${account.address}`);
    console.log(`[poly-wrap] limit=${limit} seed=${formatUnits(seedUsdc, 6)} dryRun=${dryRun}`);

    const [events, existing] = await Promise.all([
        fetchGammaEvents(),
        readExistingQuestions(publicClient),
    ]);
    const plan = candidatesFromEvents(
        events,
        existing,
        nowSec,
        fallbackDurationDays,
        allowFallbackDeadlines,
    ).slice(0, limit);

    console.log(`[poly-wrap] plan=${plan.length}`);
    for (const [i, item] of plan.entries()) {
        console.log(
            `[${String(i + 1).padStart(2, "0")}] ${item.category.padEnd(12)} ${item.slug} deadline=${item.deadline} ${item.title}`,
        );
    }
    if (dryRun || plan.length === 0) return;

    const balance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
    })) as bigint;
    const needed = seedUsdc * BigInt(plan.length);
    if (balance < needed) {
        throw new Error(
            `Insufficient USDC: need ${formatUnits(needed, 6)}, have ${formatUnits(balance, 6)}`,
        );
    }

    await ensureApproval(publicClient, walletClient, account, seedUsdc * BigInt(plan.length));

    for (const [i, item] of plan.entries()) {
        const tx = await walletClient.writeContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "createMarket",
            args: [item.title, item.category, item.criteria, item.deadline, seedUsdc],
            account,
            chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log(`[poly-wrap] created ${i + 1}/${plan.length} tx=${tx} ${item.slug}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
