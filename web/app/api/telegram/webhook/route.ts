import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUpdate = {
    message?: {
        text?: string;
        chat?: {
            id?: number | string;
            type?: string;
        };
    };
};

export async function POST(req: NextRequest) {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (expectedSecret) {
        const receivedSecret = req.headers
            .get("x-telegram-bot-api-secret-token")
            ?.trim();
        if (receivedSecret !== expectedSecret) {
            return NextResponse.json({ ok: false }, { status: 401 });
        }
    }

    let update: TelegramUpdate;
    try {
        update = (await req.json()) as TelegramUpdate;
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const text = update.message?.text?.trim() ?? "";
    const chatId = update.message?.chat?.id;
    if (!chatId || !text.startsWith("/start")) {
        return NextResponse.json({ ok: true });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        return NextResponse.json(
            { ok: false, error: "telegram bot token not configured" },
            { status: 500 },
        );
    }

    const id = String(chatId);
    const chatType = update.message?.chat?.type ?? "chat";
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            chat_id: id,
            text: [
                "Use this chat id for YOLO Markets alerts:",
                `<code>${escapeHtml(id)}</code>`,
                "",
                chatType === "private"
                    ? "Paste it in Agent settings to enable Telegram alerts."
                    : "This is the group chat id. Paste it in Agent settings to send alerts here.",
            ].join("\n"),
            parse_mode: "HTML",
            disable_web_page_preview: true,
        }),
    });

    if (!response.ok) {
        return NextResponse.json(
            { ok: false, error: "telegram send failed" },
            { status: 502 },
        );
    }

    return NextResponse.json({ ok: true });
}

export async function GET() {
    return NextResponse.json({ ok: true });
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
