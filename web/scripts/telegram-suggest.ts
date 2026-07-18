/**
 * Suggest new Polymarket markets to the admin over Telegram.
 *
 * Scans top-volume active Gamma markets, drops any already listed on Arc (by
 * question) or already suggested (state file), then DMs the admin the top N as
 * "List on YOLO" cards with inline buttons. Pressing a button runs the webhook
 * listing flow (lib/list-market). Run periodically as a keeper:
 *
 *   npm run markets:tg:suggest -- --count 5 --min-volume-24h 500
 *   npm run markets:tg:suggest -- --dry-run
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { createPublicClient, fallback, http, type Address } from "viem";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, factoryAbi, marketAbi } from "../lib/contracts";
import { fetchTopGammaMarkets, buildListing } from "../lib/list-market";
import { sendMessage, escapeHtml, type InlineButton } from "../lib/telegram";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });
loadEnv({ path: path.resolve(__dirname, "..", ".env.local"), override: false });

const STATE_FILE = path.resolve(__dirname, "telegram-suggested.json");
const MARKET_READ_BATCH = 40;

function arg(name: string, fallbackVal: string): string {
    const ix = process.argv.indexOf(`--${name}`);
    return ix >= 0 ? (process.argv[ix + 1] ?? fallbackVal) : fallbackVal;
}
function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpcUrls(): string[] {
    const multi = process.env.ARC_TESTNET_RPC_URLS?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const one = process.env.ARC_TESTNET_RPC_URL?.trim();
    return [...new Set([...multi, ...(one ? [one] : []), ...arcTestnet.rpcUrls.default.http])];
}

async function readExistingQuestions(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<Set<string>> {
    const addrs = (await publicClient.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    const questions = new Set<string>();
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH);
        const rows = await publicClient.multicall({
            allowFailure: true,
            contracts: batch.map((address) => ({ address, abi: marketAbi, functionName: "question" as const })),
        });
        for (const row of rows) {
            if (row.status === "success" && typeof row.result === "string") {
                questions.add(row.result.trim().toLowerCase());
            }
        }
        if (i + MARKET_READ_BATCH < addrs.length) await delay(60);
    }
    return questions;
}

function loadSuggested(): Set<string> {
    try {
        return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as string[]);
    } catch {
        return new Set();
    }
}
function saveSuggested(ids: Set<string>) {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...ids], null, 0));
}

async function main() {
    const count = Number(arg("count", "5"));
    const minVol = Number(arg("min-volume-24h", "500"));
    const scanLimit = Number(arg("scan-limit", "300"));
    const dryRun = flag("dry-run");

    const adminIds = (process.env.TELEGRAM_ADMIN_CHAT_ID ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (adminIds.length === 0) throw new Error("TELEGRAM_ADMIN_CHAT_ID is required");
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required");

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: fallback(rpcUrls().map((url) => http(url))),
    });

    const [markets, existing] = await Promise.all([
        fetchTopGammaMarkets(scanLimit),
        readExistingQuestions(publicClient),
    ]);
    const suggested = loadSuggested();
    const nowSec = Math.floor(Date.now() / 1000);

    const picks: { id: string; title: string; category: string; endDate: string | null; vol: number }[] = [];
    for (const m of markets) {
        if (picks.length >= count) break;
        if (!m.id || suggested.has(m.id)) continue;
        if ((m.volume24hr ?? 0) < minVol) continue;
        const listing = buildListing(m, { nowSec });
        if ("error" in listing) continue;
        if (existing.has(listing.title.trim().toLowerCase())) continue;
        picks.push({
            id: m.id,
            title: listing.title,
            category: listing.category,
            endDate: listing.endDate,
            vol: listing.volume24h,
        });
    }

    console.log(`[tg-suggest] candidates scanned=${markets.length} existing=${existing.size} picks=${picks.length} dryRun=${dryRun}`);
    for (const p of picks) console.log(`  [${p.category}] $${Math.round(p.vol)} ${p.title}`);
    if (dryRun || picks.length === 0) return;

    for (const p of picks) {
        const ends = p.endDate ? new Date(p.endDate).toISOString().slice(0, 10) : "—";
        const text = [
            `🆕 <b>${escapeHtml(p.title)}</b>`,
            `Category: ${escapeHtml(p.category)} · Ends: ${ends} · 24h vol: $${Math.round(p.vol).toLocaleString()}`,
            "",
            "List this market on YOLO?",
        ].join("\n");
        const keyboard: InlineButton[][] = [
            [{ text: "📋 List on YOLO", callback_data: `L:${p.id}` }],
            [{ text: "✕ Dismiss", callback_data: "X" }],
        ];
        for (const chat of adminIds) {
            await sendMessage(chat, text, keyboard).catch((e) => console.warn(`[tg-suggest] send failed`, e));
        }
        suggested.add(p.id);
    }
    saveSuggested(suggested);
    console.log(`[tg-suggest] sent ${picks.length} suggestion(s)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
