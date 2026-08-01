import {
    createPublicClient,
    createWalletClient,
    fallback,
    http,
    parseUnits,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi } from "@/lib/contracts";
import {
    buildPolymarketMirrorCriteria,
    type PolymarketMirrorMeta,
} from "@/lib/polymarket-mirror";

/**
 * Shared single-market listing: turn one Polymarket (Gamma) market into a
 * native YOLO market on Arc. This is the interactive counterpart to the batch
 * `scripts/polymarket-wrap.ts` — the Telegram "List on YOLO" button and any
 * future admin action call `fetchGammaMarketBySlug` → `buildListing` →
 * `deployListing`. Markets carry the same POLYMARKET_MIRROR criteria, so the
 * existing resolution keeper auto-resolves them with no extra wiring.
 */

const GAMMA_BASE =
    process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";

export type GammaMarket = {
    id: string;
    conditionId?: string;
    question?: string;
    slug?: string;
    outcomes?: string;
    clobTokenIds?: string;
    volume24hr?: number;
    groupItemTitle?: string;
    closed?: boolean;
    active?: boolean;
    endDate?: string;
    umaEndDate?: string;
    resolutionSource?: string;
    description?: string;
    image?: string;
    icon?: string;
    events?: { id?: string; slug?: string; title?: string; endDate?: string }[];
};

export type Listing = {
    slug: string;
    title: string;
    category: string;
    criteria: string;
    deadline: bigint;
    volume24h: number;
    image: string | null;
    /** ISO end date for display. */
    endDate: string | null;
};

export type DeployResult = { address: Address; txHash: `0x${string}` };

// ── Fetch ───────────────────────────────────────────────────────────────────

/** Fetch a single Gamma market by its slug. Returns null when not found. */
export async function fetchGammaMarketBySlug(slug: string): Promise<GammaMarket | null> {
    const res = await fetch(
        `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as GammaMarket[];
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

/** Fetch top active markets by 24h volume — the candidate pool the suggester
 *  ranks and dedupes for admin listing. */
export async function fetchTopGammaMarkets(scanLimit: number): Promise<GammaMarket[]> {
    const out: GammaMarket[] = [];
    for (let offset = 0; out.length < scanLimit; offset += 100) {
        const params = new URLSearchParams({
            active: "true",
            closed: "false",
            limit: "100",
            offset: String(offset),
            order: "volume24hr",
            ascending: "false",
        });
        const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
        });
        if (!res.ok) throw new Error(`Gamma markets fetch failed: ${res.status}`);
        const page = (await res.json()) as GammaMarket[];
        if (page.length === 0) break;
        out.push(...page);
        if (page.length < 100) break;
    }
    return out.slice(0, scanLimit);
}

/** Fetch a single Gamma market by its numeric id. Preferred for the Telegram
 *  flow: the id is short enough to ride inside a 64-byte callback_data, whereas
 *  slugs frequently exceed it. */
export async function fetchGammaMarketById(id: string): Promise<GammaMarket | null> {
    const res = await fetch(`${GAMMA_BASE}/markets/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
    });
    if (!res.ok) return null;
    const m = (await res.json()) as GammaMarket;
    return m && m.id ? m : null;
}

// ── Build ───────────────────────────────────────────────────────────────────

export type BuildListingOptions = {
    nowSec?: number;
    /** When the market has no usable end date, list for this many days. */
    fallbackDurationDays?: number;
    /** Whether to synthesise a deadline when the source has none (default true
     *  for interactive listing — the admin explicitly chose this market). */
    allowFallbackDeadline?: boolean;
};

/** Convert a Gamma market into a deployable listing, or return a reason string
 *  when it can't be listed (closed, non-binary, no deadline). Mirrors the batch
 *  script's candidate logic for a single market. */
export function buildListing(
    m: GammaMarket,
    opts: BuildListingOptions = {},
): Listing | { error: string } {
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const fallbackDurationDays = opts.fallbackDurationDays ?? 30;
    const allowFallbackDeadline = opts.allowFallbackDeadline ?? true;

    if (!m.slug) return { error: "market has no slug" };
    if (m.closed || m.active === false) return { error: "market is closed" };

    const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
    if (outcomes.length >= 2 && (!outcomes.includes("yes") || !outcomes.includes("no"))) {
        return { error: "not a binary yes/no market" };
    }

    const title = (m.question?.trim() || m.groupItemTitle?.trim() || "Untitled").slice(0, 500);
    const parent = m.events?.[0];
    const deadline = resolveDeadline(m, parent?.endDate, nowSec, fallbackDurationDays, allowFallbackDeadline);
    if (deadline === null) return { error: "no valid future deadline" };

    const tokens = pickTokenIds(m);
    const meta: PolymarketMirrorMeta = {
        version: 1,
        polymarketSlug: m.slug,
        eventSlug: parent?.slug ?? null,
        conditionId: m.conditionId ?? null,
        yesTokenId: tokens.yesTokenId,
        noTokenId: tokens.noTokenId,
        resolutionSource: m.resolutionSource ?? null,
        endDate: m.endDate ?? parent?.endDate ?? null,
        umaEndDate: m.umaEndDate ?? null,
    };

    return {
        slug: m.slug,
        title,
        category: classifyCategoryFromText(`${title} ${parent?.title ?? ""}`),
        criteria: buildPolymarketMirrorCriteria(meta, m.description ?? null),
        deadline,
        volume24h: m.volume24hr ?? 0,
        image: m.image || m.icon || null,
        endDate: m.endDate ?? parent?.endDate ?? null,
    };
}

// ── Deploy ──────────────────────────────────────────────────────────────────

/** The four immutable fields `createMarket` writes into a new market. A
 *  Polymarket mirror and a hand-written Telegram market differ only in how
 *  these are sourced. */
export type MarketDeployInput = {
    title: string;
    category: string;
    criteria: string;
    deadline: bigint;
};

/** Deploy a prepared listing to the factory: approve (once, max) then
 *  `createMarket` seeded with `seedUsdc` whole USDC. Returns the new market
 *  address and tx hash. Uses DEPLOYER_PRIVATE_KEY. */
export function deployListing(listing: Listing, seedUsdcWhole: number): Promise<DeployResult> {
    return deployMarket(listing, seedUsdcWhole);
}

/** Deploy any market — the shared path behind both the Polymarket listing
 *  button and the admin `/create` command. */
export async function deployMarket(
    input: MarketDeployInput,
    seedUsdcWhole: number,
): Promise<DeployResult> {
    const seed = parseUnits(String(seedUsdcWhole), 6);
    if (seed <= 0n) throw new Error("seed amount must be positive");

    const { account, publicClient, walletClient } = getDeployClients();

    const balance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
    })) as bigint;
    if (balance < seed) {
        throw new Error(
            `deployer USDC balance too low: need ${seedUsdcWhole}, have ${Number(balance) / 1e6}`,
        );
    }

    await ensureApproval(publicClient, walletClient, account, seed);

    // Simulate to capture the returned market address (createMarket returns it),
    // then broadcast the identical call.
    const { request, result } = await publicClient.simulateContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "createMarket",
        args: [input.title, input.category, input.criteria, input.deadline, seed],
        account,
    });
    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { address: result as Address, txHash };
}

export type CreatePreflight = {
    deployer: Address;
    factory: Address;
    factoryAdmin: Address | null;
    /** False when DEPLOYER_PRIVATE_KEY isn't the factory admin — `createMarket`
     *  would revert `NotAdmin`. This has bitten us before (web/.env.local held a
     *  different key than the root .env), so surface it before spending gas. */
    isAdmin: boolean;
    balanceUsdc: number;
    /** Null when no seed amount was supplied yet. */
    hasFunds: boolean | null;
    /** Set when the deployer key itself is missing or malformed. */
    keyError: string | null;
};

/** Read-only check of everything that makes `createMarket` fail for reasons
 *  unrelated to the market itself: bad key, wrong signer, empty wallet. */
export async function preflightCreate(seedUsdcWhole?: number): Promise<CreatePreflight> {
    const base: CreatePreflight = {
        deployer: "0x0000000000000000000000000000000000000000",
        factory: ADDRESSES.factory,
        factoryAdmin: null,
        isAdmin: false,
        balanceUsdc: 0,
        hasFunds: null,
        keyError: null,
    };

    let clients: ReturnType<typeof getDeployClients>;
    try {
        clients = getDeployClients();
    } catch (e) {
        return { ...base, keyError: e instanceof Error ? e.message : "deployer key unavailable" };
    }

    const { account, publicClient } = clients;
    const [admin, balance] = await Promise.all([
        publicClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "admin",
        }) as Promise<Address>,
        publicClient.readContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account.address],
        }) as Promise<bigint>,
    ]);

    const balanceUsdc = Number(balance) / 1e6;
    return {
        ...base,
        deployer: account.address,
        factoryAdmin: admin,
        isAdmin: admin.toLowerCase() === account.address.toLowerCase(),
        balanceUsdc,
        hasFunds: seedUsdcWhole === undefined ? null : balanceUsdc >= seedUsdcWhole,
    };
}

/** Read-only validation of a deploy: checks deployer balance/allowance and, if
 *  already approved, simulates `createMarket` to confirm the args are accepted
 *  and predict the new address. Never broadcasts. */
export async function dryRunListing(
    listing: Listing,
    seedUsdcWhole: number,
): Promise<{ balanceUsdc: number; willApprove: boolean; predictedAddress: Address | null }> {
    const seed = parseUnits(String(seedUsdcWhole), 6);
    const { account, publicClient } = getDeployClients();
    const [balance, allowance] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>,
        publicClient.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, ADDRESSES.factory] }) as Promise<bigint>,
    ]);
    const willApprove = allowance < seed;
    let predictedAddress: Address | null = null;
    if (!willApprove) {
        const { result } = await publicClient.simulateContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "createMarket",
            args: [listing.title, listing.category, listing.criteria, listing.deadline, seed],
            account,
        });
        predictedAddress = result as Address;
    }
    return { balanceUsdc: Number(balance) / 1e6, willApprove, predictedAddress };
}

// ── Internals ────────────────────────────────────────────────────────────────

let cachedClients: ReturnType<typeof buildDeployClients> | null = null;

function getDeployClients() {
    if (!cachedClients) cachedClients = buildDeployClients();
    return cachedClients;
}

function buildDeployClients() {
    const raw = process.env.DEPLOYER_PRIVATE_KEY;
    if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY is not configured");
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be 32-byte hex");
    }
    const account = privateKeyToAccount(key);
    const transport = fallback(rpcUrls().map((url) => http(url)));
    return {
        account,
        publicClient: createPublicClient({ chain: arcTestnet, transport }),
        walletClient: createWalletClient({ account, chain: arcTestnet, transport }),
    };
}

function rpcUrls(): string[] {
    const multi =
        process.env.ARC_TESTNET_RPC_URLS?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const one = process.env.ARC_TESTNET_RPC_URL?.trim();
    return [...new Set([...multi, ...(one ? [one] : []), ...arcTestnet.rpcUrls.default.http])];
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
}

function resolveDeadline(
    m: GammaMarket,
    parentEnd: string | undefined,
    nowSec: number,
    fallbackDurationDays: number,
    allowFallback: boolean,
): bigint | null {
    const rawDate = m.umaEndDate ?? m.endDate ?? parentEnd;
    if (rawDate) {
        const ts = Math.floor(new Date(rawDate).getTime() / 1000);
        if (Number.isFinite(ts) && ts > nowSec + 120) return BigInt(ts);
    }
    if (!allowFallback) return null;
    return BigInt(nowSec + fallbackDurationDays * 86_400);
}

function pickTokenIds(m: GammaMarket): { yesTokenId: string | null; noTokenId: string | null } {
    const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const yesIndex = outcomes.findIndex((x) => x === "yes");
    const noIndex = outcomes.findIndex((x) => x === "no");
    return {
        yesTokenId: yesIndex >= 0 ? (tokenIds[yesIndex] ?? null) : (tokenIds[0] ?? null),
        noTokenId: noIndex >= 0 ? (tokenIds[noIndex] ?? null) : (tokenIds[1] ?? null),
    };
}

function parseJsonArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
        return [];
    }
}

export function classifyCategoryFromText(text: string): string {
    const lower = text.toLowerCase();
    const checks: [string, RegExp][] = [
        ["Crypto", /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|stablecoin|xrp|doge)\b/],
        ["Sports", /\b(fifa|world cup|nba|nfl|mlb|nhl|ufc|tennis|wta|atp|soccer|football|baseball|basketball)\b/],
        ["Geopolitics", /\b(iran|israel|china|taiwan|russia|ukraine|war|gaza|hormuz|nuclear deal|invasion)\b/],
        ["Politics", /\b(trump|biden|election|senate|congress|president|presidential|supreme court|white house)\b/],
        ["Tech", /\b(openai|chatgpt|gpt|ai|spacex|tesla|apple|nvidia|ipo)\b/],
        ["Macro", /\b(fed|inflation|cpi|rates?|recession|gdp|treasury|unemployment|market cap)\b/],
        ["Culture", /\b(movie|music|album|celebrity|award|oscars?|grammys?|box office)\b/],
        ["Science", /\b(space|climate|weather|temperature|medicine|health|earthquake)\b/],
    ];
    return checks.find(([, re]) => re.test(lower))?.[0] ?? "Other";
}
