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
- [ ] Catalog indexing in Postgres (event-driven) — kills the RPC scan entirely; free Arc RPCs rate-limit hard (≤250 sub-calls/multicall, spacing needed).
- [ ] Portfolio perf: per-market `getLogs` over both factories is heavy; index positions in the DB instead.
- [ ] Fast-history section will look thin until v2 accumulates resolved rounds (v1 history intentionally left behind).

## Cleanup
- [ ] Remove `/api/circle/social` routes if social login isn't coming back.
- [ ] `agent/setup` market picker still reads the merged catalog — sanity-check it handles `legacy` markets sensibly.
