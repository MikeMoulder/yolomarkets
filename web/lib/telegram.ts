/**
 * Thin Telegram Bot API helpers shared by the webhook (button callbacks) and
 * the suggester script (outbound DMs). No SDK — just typed fetch calls.
 */

const API_BASE = "https://api.telegram.org";

export type InlineButton = {
    text: string;
    callback_data: string;
};

export type TelegramCallbackQuery = {
    id: string;
    from?: { id?: number };
    data?: string;
    message?: {
        message_id?: number;
        chat?: { id?: number | string };
    };
};

export type TelegramUpdate = {
    message?: {
        text?: string;
        chat?: { id?: number | string; type?: string };
    };
    callback_query?: TelegramCallbackQuery;
};

function botToken(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    return token;
}

async function tg<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) {
        throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result as T;
}

export function sendMessage(
    chatId: number | string,
    text: string,
    keyboard?: InlineButton[][],
) {
    return tg("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
}

export function editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    keyboard?: InlineButton[][],
) {
    return tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] },
    });
}

export function answerCallbackQuery(callbackQueryId: string, text?: string) {
    return tg("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
    });
}

/** Admin allow-list from TELEGRAM_ADMIN_CHAT_ID (comma-separated ids). When
 *  unset, no chat is treated as admin — callbacks are refused rather than
 *  fail open. */
export function isAdminChat(id: number | string | undefined | null): boolean {
    if (id === undefined || id === null) return false;
    const allow = (process.env.TELEGRAM_ADMIN_CHAT_ID ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    return allow.includes(String(id));
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
