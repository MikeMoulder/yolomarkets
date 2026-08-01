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

/** One rendition of a compressed photo. Telegram sends an ascending ladder of
 *  sizes; the last entry is the largest. */
export type TelegramPhotoSize = {
    file_id: string;
    file_size?: number;
    width?: number;
    height?: number;
};

export type TelegramMessage = {
    message_id?: number;
    text?: string;
    /** Text that accompanies a photo/document — where a `/create` command lives
     *  when the admin sends the image and the command in one go. */
    caption?: string;
    photo?: TelegramPhotoSize[];
    /** Uncompressed image sent as a file ("send without compression"). */
    document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
    from?: { id?: number };
    chat?: { id?: number | string; type?: string };
};

export type TelegramUpdate = {
    message?: TelegramMessage;
    /** Telegram sends edits as their own update kind; the command center
     *  treats an edited command the same as a new one. */
    edited_message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
};

/** A bot command registered with `setMyCommands` — drives the "/" menu in the
 *  Telegram client, which is what makes the command center discoverable. */
export type BotCommand = { command: string; description: string };

export function setMyCommands(commands: BotCommand[], scope?: Record<string, unknown>) {
    return tg("setMyCommands", {
        commands,
        ...(scope ? { scope } : {}),
    });
}

export function setWebhook(url: string, secretToken?: string) {
    return tg("setWebhook", {
        url,
        allowed_updates: ["message", "edited_message", "callback_query"],
        ...(secretToken ? { secret_token: secretToken } : {}),
    });
}

export function getWebhookInfo() {
    return tg<{ url?: string; pending_update_count?: number; last_error_message?: string }>(
        "getWebhookInfo",
        {},
    );
}

export function deleteWebhook(dropPendingUpdates = false) {
    return tg("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
}

/** Long-poll for updates. Telegram refuses this while a webhook is registered
 *  (409 Conflict), so a poller must own the bot exclusively — see
 *  scripts/telegram-bot.ts. */
export function getUpdates(offset: number, timeoutSeconds: number) {
    return tg<(TelegramUpdate & { update_id: number })[]>("getUpdates", {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "edited_message", "callback_query"],
    });
}

export function getMe() {
    return tg<{ id: number; username?: string }>("getMe", {});
}

// ── Files ───────────────────────────────────────────────────────────────────

export type TelegramFile = { file_id: string; file_size?: number; file_path?: string };

export function getFile(fileId: string) {
    return tg<TelegramFile>("getFile", { file_id: fileId });
}

/**
 * Download a file's bytes. The download URL embeds the bot token, so it must
 * never be handed to a browser — fetch server-side and re-serve the bytes
 * ourselves (see lib/market-images + /api/markets/<addr>/image).
 */
export async function downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const res = await fetch(`${API_BASE}/file/bot${botToken()}/${filePath}`);
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error(`file is ${Math.round(declared / 1024)} KB, limit is ${Math.round(maxBytes / 1024)} KB`);

    const buf = Buffer.from(await res.arrayBuffer());
    // Content-Length is advisory — enforce on the real payload too.
    if (buf.length > maxBytes) {
        throw new Error(`file is ${Math.round(buf.length / 1024)} KB, limit is ${Math.round(maxBytes / 1024)} KB`);
    }
    return buf;
}

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
