# Later work (parking lot)

_Updated 2026-07-18 after the v2 factory migration + custodial Circle wallet pivot._

## Ops / hygiene
- [ ] **web/.env.local `DEPLOYER_PRIVATE_KEY` is not the factory admin** (`0xcf03…` vs admin `0xdfB1…` in root `.env`) — server-side market creation from the Next app (Telegram webhook → `lib/list-market`) reverts `NotAdmin` until fixed.
- [ ] **Sweep the v1 graveyard**: `npx tsx scripts/fast-market-keeper.ts --legacy-factory` cancels the ~13.8k expired-unresolved v1 fast rounds and reclaims their seed liquidity to the deployer. Long-running; run it overnight sometime.
- [x] ~~Top up the **resolver EOA** (`0xF95C…61aF`) when its 1 USDC gas runs low (~125 resolutions).~~ Automated 2026-07-20: `fast-market-keeper.ts` auto-refills the resolver from the deployer each loop when it dips below `RESOLVER_MIN_GAS_USDC` (default 0.05) up to `RESOLVER_TOPUP_USDC` (default 0.5). Deployer still needs its own USDC balance kept up.
- [ ] Circle support ticket for the **155118 PIN-challenge regression** (evidence in agent memory / session notes) — unblocks a future self-custody wallet option and the stranded 19.9 USDC in `0xb5d3…`.

## Product
- [ ] **Catalog UI rework** (the actual redesign — the v2 data layer is ready).
- [ ] **Own-auth email flow** (Resend API): fully branded OTP emails + Arcana-style inline code slots; replaces Circle's iframe login. ~2-3h, designed but not built. Styled email templates already exist in `web/emails/`.
- [x] ~~Catalog indexing in Postgres (event-driven) — kills the RPC scan entirely.~~ **Built 2026-07-21** (`scripts/catalog-indexer.ts` → `market_index` + `catalog_meta` tables; `lib/catalog-index.ts` mappers; `lib/markets.ts` reads v2 from the DB, RPC fallback until `catalog_meta.v2_backfilled=1` or if DB unreachable; v1 addrs now cached once since that factory is frozen). Verified end-to-end against local Postgres (1012 rows backfilled in ~25s, field values correct). **LIVE on Supabase since 2026-07-21** — migrated the whole app DB off Neon (it had blown its free compute-time quota; the constant indexer/agent polling burns Neon's metered compute). Now on Supabase free tier (EU-west, session pooler `:5432`, `DATABASE_URL` in root `.env` + `web/.env.local`). Schema created with `drizzle-kit push --force` (fresh start — agent profiles/wallets began empty, as intended). pm2 app `yolo-catalog-indexer` running; verified the web catalog reads from Supabase (0 RPC-fallback hits, `v2_backfilled=1`, ~1020 markets). Mind host memory — the box OOM-killed the dev server during this work (7.8 GB, runs hot).
- [ ] Portfolio perf: per-market `getLogs` over both factories is heavy; index positions in the DB instead.
- [ ] Fast-history section will look thin until v2 accumulates resolved rounds (v1 history intentionally left behind).

## Cleanup
- [ ] Remove `/api/circle/social` routes if social login isn't coming back.
- [ ] `agent/setup` market picker still reads the merged catalog — sanity-check it handles `legacy` markets sensibly.
