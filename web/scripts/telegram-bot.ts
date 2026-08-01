/**
 * Telegram command center — VPS long-poller.
 *
 * The alternative transport to the Vercel webhook, and the better host for
 * `/create`:
 *   · it is long-lived, so a market deploy can wait for its receipt (a Vercel
 *     function may be frozen the moment it responds);
 *   · it loads the repo-root `.env`, whose DEPLOYER_PRIVATE_KEY is the actual
 *     factory admin — the same key the keepers already use here;
 *   · no public URL, no webhook secret, no TLS endpoint to keep alive.
 *
 * Only one transport may own a bot: Telegram answers `getUpdates` with 409
 * Conflict while a webhook is registered, so this script deletes the webhook on
 * boot unless `--keep-webhook` is passed.
 *
 *   npm run telegram:bot                 # poll forever (pm2: yolo-telegram-bot)
 *   npm run telegram:bot -- --drop-pending   # ignore the backlog on boot
 *   npm run telegram:bot -- --once       # drain once and exit (smoke test)
 */
// MUST stay the first import: it loads .env before `lib/db` is evaluated, and
// lib/db captures DATABASE_URL at module scope. See scripts/load-env.ts.
import "./load-env";
import {
    deleteWebhook,
    getMe,
    getUpdates,
    getWebhookInfo,
    setMyCommands,
} from "../lib/telegram";
import { BOT_COMMANDS, handleUpdate } from "../lib/telegram-router";
import { probeDraftStore } from "../lib/telegram-drafts";

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
function arg(name: string, fallbackVal: string): string {
    const ix = process.argv.indexOf(`--${name}`);
    return ix >= 0 ? (process.argv[ix + 1] ?? fallbackVal) : fallbackVal;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const pollSeconds = Number(arg("timeout", process.env.TELEGRAM_POLL_SECONDS ?? "30"));
    const once = flag("once");

    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required");
    if (!(process.env.TELEGRAM_ADMIN_CHAT_ID ?? "").trim()) {
        // Without an allow-list every admin command refuses — fail loudly at
        // boot instead of leaving a bot that silently says "Not authorized".
        throw new Error("TELEGRAM_ADMIN_CHAT_ID is required (comma-separated chat/user ids)");
    }
    if (!process.env.DATABASE_URL?.trim()) {
        // The /create wizard keeps its drafts in Postgres. Crash now rather than
        // let pm2 report a healthy bot that answers every command with an error.
        throw new Error("DATABASE_URL is required — the /create wizard stores drafts in Postgres");
    }

    // Prove the draft store is actually reachable before serving commands.
    await probeDraftStore();
    console.log("[tg-bot] draft store ok");

    const me = await getMe();
    console.log(`[tg-bot] polling as @${me.username ?? me.id}`);

    if (!flag("keep-webhook")) {
        const info = await getWebhookInfo().catch(() => null);
        if (info?.url) {
            console.log(`[tg-bot] removing webhook ${info.url} — getUpdates needs exclusive ownership`);
            await deleteWebhook(flag("drop-pending"));
        }
    }

    await setMyCommands(BOT_COMMANDS).catch((e) => console.warn("[tg-bot] setMyCommands failed", e));

    // Telegram replays anything unacknowledged; `--drop-pending` skips the
    // backlog so a restart doesn't re-run stale button presses.
    let offset = 0;
    if (flag("drop-pending")) {
        const stale = await getUpdates(0, 0).catch(() => []);
        if (stale.length > 0) {
            offset = stale[stale.length - 1].update_id + 1;
            console.log(`[tg-bot] dropped ${stale.length} pending update(s)`);
        }
    }

    let failures = 0;
    for (;;) {
        try {
            const updates = await getUpdates(offset, pollSeconds);
            failures = 0;
            for (const update of updates) {
                offset = update.update_id + 1;
                // Serial and awaited: the poller is long-lived, so a deploy can
                // take as long as it needs. `offset` only advances past an
                // update once it has been handled.
                try {
                    await handleUpdate(update);
                } catch (e) {
                    console.error(`[tg-bot] update ${update.update_id} failed`, e);
                }
            }
            if (once) {
                console.log(`[tg-bot] --once: drained ${updates.length} update(s)`);
                return;
            }
        } catch (e) {
            failures += 1;
            const wait = Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5));
            console.error(`[tg-bot] poll failed (${failures}), retrying in ${wait / 1000}s`, e);
            if (once) return;
            await delay(wait);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
