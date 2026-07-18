import { NextResponse, type NextRequest } from "next/server";
import { formatUnits } from "viem";
import {
    answerCallbackQuery,
    editMessageText,
    escapeHtml,
    isAdminChat,
    sendMessage,
    type InlineButton,
    type TelegramUpdate,
} from "@/lib/telegram";
import {
    buildListing,
    deployListing,
    fetchGammaMarketById,
    type Listing,
} from "@/lib/list-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPLORER = "https://testnet.arcscan.app";

export async function POST(req: NextRequest) {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (expectedSecret) {
        const received = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
        if (received !== expectedSecret) {
            return NextResponse.json({ ok: false }, { status: 401 });
        }
    }

    let update: TelegramUpdate;
    try {
        update = (await req.json()) as TelegramUpdate;
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    if (update.callback_query) {
        return handleCallback(update.callback_query);
    }
    if (update.message) {
        return handleMessage(update.message);
    }
    return NextResponse.json({ ok: true });
}

export async function GET() {
    return NextResponse.json({ ok: true });
}

// ── /start — return chat id (unchanged behaviour) ────────────────────────────

async function handleMessage(message: NonNullable<TelegramUpdate["message"]>) {
    const text = message.text?.trim() ?? "";
    const chatId = message.chat?.id;
    if (!chatId || !text.startsWith("/start")) {
        return NextResponse.json({ ok: true });
    }
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return NextResponse.json({ ok: false, error: "telegram bot token not configured" }, { status: 500 });
    }

    const id = String(chatId);
    const chatType = message.chat?.type ?? "chat";
    try {
        await sendMessage(
            id,
            [
                "Use this chat id for YOLO Markets alerts:",
                `<code>${escapeHtml(id)}</code>`,
                "",
                chatType === "private"
                    ? "Paste it in Agent settings (or TELEGRAM_ADMIN_CHAT_ID for listing) to enable alerts."
                    : "This is the group chat id. Paste it in Agent settings to send alerts here.",
            ].join("\n"),
        );
    } catch {
        return NextResponse.json({ ok: false, error: "telegram send failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
}

// ── Button callbacks — the admin listing flow ────────────────────────────────

async function handleCallback(cb: NonNullable<TelegramUpdate["callback_query"]>) {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data ?? "";

    // Admin gate: only allow-listed chat/user ids may drive listing.
    if (!isAdminChat(cb.from?.id) && !isAdminChat(chatId)) {
        await answerCallbackQuery(cb.id, "Not authorized.").catch(() => {});
        return NextResponse.json({ ok: true });
    }
    if (chatId === undefined || messageId === undefined) {
        await answerCallbackQuery(cb.id).catch(() => {});
        return NextResponse.json({ ok: true });
    }

    // X → dismiss
    if (data === "X") {
        await answerCallbackQuery(cb.id, "Dismissed").catch(() => {});
        await editMessageText(chatId, messageId, "✕ <i>Dismissed.</i>").catch(() => {});
        return NextResponse.json({ ok: true });
    }

    // L:<id> → show liquidity presets
    if (data.startsWith("L:")) {
        const marketId = data.slice(2);
        await answerCallbackQuery(cb.id).catch(() => {});
        const m = await fetchGammaMarketById(marketId).catch(() => null);
        const listing = m ? buildListing(m) : null;
        if (!listing || "error" in listing) {
            const reason = listing && "error" in listing ? listing.error : "market not found";
            await editMessageText(chatId, messageId, `⚠️ Can't list this market: ${escapeHtml(reason)}`).catch(() => {});
            return NextResponse.json({ ok: true });
        }
        await editMessageText(
            chatId,
            messageId,
            `${listingSummary(listing)}\n\n<b>Choose initial liquidity (USDC):</b>`,
            liquidityKeyboard(marketId),
        ).catch(() => {});
        return NextResponse.json({ ok: true });
    }

    // S:<id>:<amount> → deploy
    if (data.startsWith("S:")) {
        const [, marketId, amtRaw] = data.split(":");
        const amount = Number(amtRaw);
        if (!marketId || !Number.isFinite(amount) || amount <= 0) {
            await answerCallbackQuery(cb.id, "Bad amount").catch(() => {});
            return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cb.id, `Listing with $${amount}…`).catch(() => {});
        await editMessageText(chatId, messageId, `⏳ <i>Listing with $${amount} liquidity…</i>`).catch(() => {});
        // Detached: return 200 fast so Telegram never retries (which would
        // double-deploy). The long-lived server finishes the deploy and edits
        // the message with the result.
        void listAndReport(marketId, amount, chatId, messageId);
        return NextResponse.json({ ok: true });
    }

    await answerCallbackQuery(cb.id).catch(() => {});
    return NextResponse.json({ ok: true });
}

async function listAndReport(
    marketId: string,
    amount: number,
    chatId: number | string,
    messageId: number,
) {
    try {
        const m = await fetchGammaMarketById(marketId);
        if (!m) throw new Error("market not found");
        const listing = buildListing(m);
        if ("error" in listing) throw new Error(listing.error);

        const { address, txHash } = await deployListing(listing, amount);
        const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://yolo.markets").replace(/\/$/, "");
        await editMessageText(
            chatId,
            messageId,
            [
                `✅ <b>Listed on YOLO</b>`,
                escapeHtml(listing.title),
                `Category: ${escapeHtml(listing.category)} · Seed: $${amount}`,
                "",
                `<a href="${site}/markets/${address}">View market</a> · <a href="${EXPLORER}/tx/${txHash}">Tx</a>`,
            ].join("\n"),
        );
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        await editMessageText(
            chatId,
            messageId,
            `❌ <b>Listing failed:</b> ${escapeHtml(reason)}`,
            [[{ text: "↺ Retry", callback_data: `L:${marketId}` }, { text: "✕ Dismiss", callback_data: "X" }]],
        ).catch(() => {});
    }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function listingSummary(listing: Listing): string {
    const ends = listing.endDate ? new Date(listing.endDate).toISOString().slice(0, 10) : "—";
    const vol = listing.volume24h > 0 ? `$${formatUnits(BigInt(Math.round(listing.volume24h)), 0)}` : "—";
    return [
        `🆕 <b>${escapeHtml(listing.title)}</b>`,
        `Category: ${escapeHtml(listing.category)} · Ends: ${ends} · 24h vol: ${vol}`,
    ].join("\n");
}

function liquidityKeyboard(marketId: string): InlineButton[][] {
    const options = (process.env.LISTING_SEED_OPTIONS ?? "1,5,10,25")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    const row = options.map((amt) => ({ text: `$${amt}`, callback_data: `S:${marketId}:${amt}` }));
    return [row, [{ text: "✕ Cancel", callback_data: "X" }]];
}
