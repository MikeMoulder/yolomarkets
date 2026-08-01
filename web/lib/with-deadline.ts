/**
 * Deadlines for server-render data fetches.
 *
 * Hard-won rule: anything awaited during SSR needs a deadline, even a "fast"
 * local dependency. A hung await does not surface as an error — Next has
 * already streamed the shell, so the browser sits on an HTTP 200 whose body
 * never ends. That is far worse than a degraded page, and it looks exactly like
 * a hosting problem, which is how it stayed misdiagnosed for so long.
 *
 * `withDeadline` cannot cancel the underlying work (a pending DB or RPC call
 * keeps running until its own client gives up) — it unblocks the *render*,
 * which is the part the user is waiting on.
 */

/** Resolve `p`, or fall back to `fallback` after `ms`. Never rejects. */
export async function withDeadline<T>(
    p: Promise<T>,
    ms: number,
    label: string,
    fallback: T,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    try {
        return await Promise.race([
            p.catch((err) => {
                console.warn(`[deadline] ${label} rejected after ${Date.now() - started}ms`, err);
                return fallback;
            }),
            new Promise<T>((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`[deadline] ${label} exceeded ${ms}ms — rendering without it`);
                    resolve(fallback);
                }, ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Default budget for a single SSR dependency. Generous enough for a cold
 *  serverless instance doing a real read, short enough that a stall is a blip
 *  rather than an outage. */
export const SSR_DEADLINE_MS = Number(process.env.SSR_DEADLINE_MS ?? 8000);

/**
 * Budget for a dependency the page cannot render meaningfully without — the
 * market list, a single market. Deliberately longer than SSR_DEADLINE_MS:
 * falling back to "no markets" turns a slow read into what looks like an empty,
 * broken product, which is worse than waiting. Decoration (artwork, movers)
 * uses the shorter budget and simply disappears.
 */
export const SSR_CRITICAL_DEADLINE_MS = Number(process.env.SSR_CRITICAL_DEADLINE_MS ?? 20_000);
