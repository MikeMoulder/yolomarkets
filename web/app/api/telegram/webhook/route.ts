/**
 * Telegram webhook transport — a thin adapter over `lib/telegram-router`.
 *
 * All behaviour lives in the router so the VPS long-poller
 * (`scripts/telegram-bot.ts`) runs exactly the same command center. Pick ONE
 * transport: Telegram rejects `getUpdates` while a webhook is registered.
 *
 * Caveat that pushed `/create` toward the poller: this route runs on Vercel,
 * where the function can be frozen as soon as it responds. Work is detached
 * here (so Telegram gets its 200 and never retries into a double-deploy), which
 * is fine for short calls but can cut off a market deploy waiting on a receipt.
 * The long-lived poller has no such limit.
 */
import { NextResponse, type NextRequest } from "next/server";
import { handleUpdate } from "@/lib/telegram-router";
import type { TelegramUpdate } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return NextResponse.json({ ok: false, error: "telegram bot token not configured" }, { status: 500 });
    }

    // Detached: answer Telegram immediately so it never retries the update —
    // a retry would replay the button press and could deploy twice.
    void handleUpdate(update).catch((e) => {
        console.error("[telegram] update failed", e);
    });
    return NextResponse.json({ ok: true });
}

export async function GET() {
    return NextResponse.json({ ok: true });
}
