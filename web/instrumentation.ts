// Runs once when a Next.js server instance boots. We use it to pre-warm the
// on-chain market cache (a full factory read takes ~40-60s) in the background,
// so the cache is populating before the first request rather than starting on
// it. Fire-and-forget: we do NOT await, so server readiness isn't delayed.
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { listMarkets } = await import("@/lib/markets");
    // Kick the read; swallow errors so a cold RPC never crashes startup.
    void listMarkets().catch(() => {});
}
