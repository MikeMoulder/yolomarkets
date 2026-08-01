# YOLO Markets — Agent guidance

A prediction-market platform on Arc testnet with an autonomous trading agent.
Full vision in [idea.md](idea.md). This file is the load-bearing context for
any AI agent (Claude Code, Cursor, …) working in this repo.

## Hard facts (don't re-derive)

| Thing | Value |
| --- | --- |
| Chain | Arc Testnet, chain ID `5042002` (`0x4CEF52`) |
| RPC (public) | `https://rpc.testnet.arc.network` |
| RPC (canteen) | `arc-canteen rpc-url` (token-gated, used by tooling) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` — **6 decimals** |
| USDC native gas | same underlying, **18 decimals**, used to pay gas |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6 decimals) — unused for MVP |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` — **gated**, see below |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Plan deltas from idea.md (read before quoting idea.md to the user)

1. **USDC is the native gas token on Arc.** Idea.md frames USDC only as the
   settlement asset; on Arc it is also gas. Same underlying value but the
   native balance is **18 decimals** while the ERC-20 interface is **6 decimals** —
   never mix them. The contracts in this repo use the ERC-20 interface
   (`IERC20` at `USDC_ADDRESS`) for `transferFrom` / `approve` and assume
   6-decimal amounts everywhere user-facing.

2. **Circle Paymaster does NOT support Arc.** Idea.md (§5.4, §8, §11) assumes
   Paymaster for gasless UX; that integration only exists on Arbitrum / Base /
   Avalanche / Ethereum / Optimism / Polygon / Unichain. On Arc the equivalent
   primitive is **Circle Gas Station** paired with a Circle SCA wallet (Dev-
   or User-Controlled). Gas Station sponsors gas fees on the developer's
   Circle Console account.

3. **USYC is institution-only.** $100k minimum, KYB allowlist via Circle Support
   (24–48h), wallet entitlements. **Not viable for the hackathon.** Demo
   shows a mocked yield panel on the portfolio page with a clearly labelled
   "Pending institutional allowlist — see roadmap" note. Do not block any
   MVP feature on USYC.

4. **Onboarding wallet.** Idea.md says "Circle Embedded Wallet". The closest
   Circle product on Arc is **User-Controlled Wallets** (email/OTP/social)
   or **Modular Wallets** (passkey). Decision pending Day 3.

## Repo layout

```
.
├── idea.md                # original 14-day plan (treat as source of intent, not spec)
├── CLAUDE.md              # this file
├── README.md
├── .env.example
├── .gitignore
├── contracts/             # Foundry + Solidity ^0.8.20
│   ├── src/
│   │   ├── HelloArc.sol           # Day 1 smoke test
│   │   ├── PredictionMarket.sol   # Day 2 — LMSR AMM
│   │   └── MarketFactory.sol      # Day 3
│   ├── test/
│   ├── script/
│   └── lib/               # PRBMath, OpenZeppelin, forge-std (git submodules)
├── web/                   # Next.js 15 App Router (Day 4+)
├── agent/                 # Python FastAPI + Claude SDK (Day 6+)
├── api/                   # Node Express gateway (Day 6+)
└── scripts/               # one-off ops scripts (faucet, market seeding)
```

## Running things

### Foundry
```bash
# Tests
cd contracts && forge test -vv

# Deploy a contract to Arc
forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast

# Read state
cast call <addr> "<sig>" --rpc-url $ARC_TESTNET_RPC_URL
```

### Arc canteen CLI
```bash
arc-canteen rpc eth_chainId                            # → 0x4cef52
arc-canteen rpc eth_getBalance '["0xabc...","latest"]'  # native USDC balance (wei18)
arc-canteen status                                     # hackathon dashboard
```

## Non-obvious rules

- **Never pass `--private-key $DEPLOYER_PRIVATE_KEY` as a CLI flag in shared
  shells.** Foundry recommends encrypted keystores. For solo hackathon work an
  env-loaded PK in `.env` is acceptable; never commit it.
- **18 vs 6 decimals:** gas balances and `eth_getBalance` return 18-dec wei;
  the USDC ERC-20 `balanceOf` returns 6-dec. UI always shows 6-dec.
- **Arc CCTP domain is `26`** (not 6 like Base) — relevant only if we add CCTP.
- **Paymaster references in idea.md should be re-read as "Gas Station".**

## Arc-specific gotchas (learned while deploying)

1. **Foundry `forge script` can't simulate USDC transfers locally on Arc.**
   The USDC ERC-20 implementation at `0x3910B7cbb3341f1F4bF4cEB66e4A2C8f204FE2b8`
   (proxied by `0x3600...`) calls precompile `0x18...01::isBlocklisted(address)`
   during every `transferFrom`. Foundry's local EVM doesn't know that precompile
   and stack-underflows — even with `--skip-simulation`, because the script's
   own `run()` body still executes in the local EVM.
   - **Workaround:** use `cast send` + `forge create` instead of `forge script`
     for anything that moves USDC. Stash deploy commands in `scripts/deploy.ps1`.
   - Or, in scripts, `vm.etch(0x18...01, hex"60206000f3")` to mock the
     precompile as returning `false` (not blocklisted). Ugly but works.

2. **Polymarket Gamma is behind Cloudflare's TLS fingerprinting.** Python's
   default `ssl` stack gets rejected with `SSLV3_ALERT_ILLEGAL_PARAMETER` on
   the TLS handshake (`Invoke-WebRequest` and `curl.exe` succeed; httpx and
   requests fail). Use `curl_cffi` with `impersonate="chrome"` for all
   Polymarket calls. We may need it for some news APIs too.

3. **The default Arc RPC is CORS-hostile — never let the browser touch it.**
   `https://rpc.testnet.arc.network` (which is what `arcTestnet.rpcUrls.default`
   holds, and therefore what a bare viem/wagmi `http()` resolves to) answers
   preflights with **no `Access-Control-Allow-Origin` header**. Any browser
   JSON-RPC call from a deployed origin dies with
   `blocked by CORS policy` → `net::ERR_FAILED`, which surfaces as *silent*
   breakage: `useReadContract` data stays `undefined` (balances/allowances read
   as 0), `useWaitForTransactionReceipt` never settles, and the admin panel
   looks dead. The other three Arc endpoints —
   `rpc.quicknode.testnet.arc.network`, `rpc.blockdaemon.testnet.arc.network`,
   `arc-testnet.drpc.org` — all send CORS headers and all return identical
   results. `web/lib/wagmi.ts` therefore pins an explicit browser fallback list
   (override with `NEXT_PUBLIC_ARC_TESTNET_RPC_URLS`); server-side code is
   unaffected and keeps using `ARC_TESTNET_RPC_URLS` + the chain default.

4. **`forge install` requires a `.git`.** Even with `--no-git` flags it tried
   to clone forge-std as a submodule. Solution: run `git init` at repo root
   (local-only, no remote) so submodules work. We did this on 2026-05-21
   despite the user's preference to skip git — it was a hard requirement,
   documented in [README.md](README.md).

## Deployed addresses (Arc testnet)

| Contract | Address | Notes |
| --- | --- | --- |
| HelloArc | `0xa88Cdb14FCfFC09083ed3027AACBA0D75a603c33` | Day 1 smoke test |
| PredictionMarket (standalone) | `0xC19F30208Ad6a6328E90D5B95F110E87CE34a779` | "BTC > 100k next NYSE close" — 5 USDC, 7-day, admin = deployer EOA |
| **MarketFactory v2 (CANONICAL since 2026-07-18)** | `0x7A31ED6d05D5B2C15f09dFca2bb69Df81f844ACd` | Audit H-1/H-2 hardened: `admin`(deployer `0xdfB1…`)≠`resolver`(`0xF95C…61aF`), two-step admin transfer, markets have `claimRefund()` for cancellations. `web/lib/contracts.ts ADDRESSES.factory`. All creation + resolution happens here. |
| MarketFactory v1 (legacy, read-only) | `0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA` | ~13.8k markets, OLD bytecode (no cancellation refund; admin-key resolution). `ADDRESSES.factoryLegacy`. Catalog shows only its unexpired markets (~73 at migration); expired fast rounds deliberately left behind. Portfolio scans it so old positions/claims stay reachable. Keepers resolve its remaining markets with the deployer key until they age out. |
| Resolver EOA (v2 factory) | `0xF95C16F303265eaFD1151311eE64E92fDa4e61aF` | Dedicated settlement key; `resolveMarket` only, NO fund authority. PK in root `.env` `RESOLVER_PRIVATE_KEY`. Gas is now **auto-topped-up** by `fast-market-keeper.ts` from the deployer each loop (`RESOLVER_MIN_GAS_USDC` floor 0.05 → `RESOLVER_TOPUP_USDC` 0.5); no manual top-up needed as long as the deployer holds USDC. |
| PredictionMarket (factory#0) | `0x13e97fFA9068452001Df8Df7EbEd043B35763237` | "ETH > 4000 next NYSE close" — 5 USDC, 7-day, admin = factory |
| ~~AgentAccountFactory (all phases)~~ | `0x04538699e0dAe81258FD6Ff1408f763379827a8d` (+ `0x3eB6…`, `0x92B8…`) | **REMOVED 2026-06-17** — legacy AgentAccount/session-key system fully replaced by Circle Developer-Controlled Wallets. Contracts deleted from repo; deployed instances abandoned on-chain (funds in old user AgentAccounts withdrawable only by their owner EOAs). |
| Deployer / admin EOA | `0xdfB1E9b15e93824dAD19C0E8Bf06a1b28DcEb901` | see `.env` |
| ~~Agent session key (demo)~~ | `0x0811d76Ea78884974244342918256FC20480AFb3` | **unused since 2026-06-17** — execution moved to Circle MPC. `AGENT_SESSION_PRIVATE_KEY` is no longer read by the runner. |

## Memory of past plan revisions

- 2026-05-21: Cut Paymaster path (unsupported on Arc). USYC demoted to mock-only.
  Settled on User-Controlled-or-Modular Wallets + Gas Station for the gasless UX
  story. Pending: Day 3 wallet-product choice between User-Controlled vs Modular.
- 2026-05-21: Hit Arc `isBlocklisted` precompile quirk during first `forge script`
  deploy. Pivoted to `forge create` + `cast send` for any USDC-touching deploy.
  Documented above so future Claude doesn't waste 15 minutes on it.
- 2026-05-24: Phase 2 of the autonomous-agent plan shipped. Per-user
  `AgentAccount` smart accounts deployed via `AgentAccountFactory` (CREATE2).
  Owner-only execute/withdraw, session-key storage slot reserved for Phase 3.
  Skipped Circle Modular Wallets SDK for now — 60-line account contract gives
  us the substance (user-owned on-chain account holding USDC) without SDK
  setup overhead. Reconsider in Phase 3 if Circle's session-key tooling buys
  us enough vs. rolling our own.
- 2026-05-24: Phase 3 of the autonomous-agent plan shipped. Rewrote
  `AgentAccount` with rich `SessionPermission` struct (expiry / totalCap /
  perCallCap / allowedTarget / allowedSelector) and cap-metered `execute()`.
  For `buy(uint8,uint256,uint256)` calls the contract decodes the 3rd arg
  (`maxCost`) as the worst-case USDC spend and meters it against the caps.
  Other selectors meter as 0 — sessions should always pin `allowedSelector`
  for safety. Factory address changed; previous Phase 2 factory is dead.
  Stayed with in-house validation (vs. ZeroDev/Biconomy) because the surface
  is small enough that pulling a third-party SDK didn't pay for itself.
- 2026-05-25: Tier 1a of the production-readiness plan shipped. Postgres
  (Drizzle + postgres-js on the Next side, psycopg v3 with a small pool on
  the Python side) replaces the JSON file storage at agent/profiles.json
  + agent/decisions.jsonl. Schema lives in web/lib/db/schema.ts and includes
  a Tier-1b-ready `agent_session_keys` table (encrypted PK + last_run_at)
  so the per-user-key migration in Tier 1b can land without another schema
  change. docker-compose.yml runs Postgres locally (`docker compose up -d db`),
  `npm run db:migrate` applies migrations, `npm run db:import-json` does a
  one-shot import of existing profiles + decisions and is safe to re-run.
  Python decision logging falls back to JSONL if the DB is unreachable —
  paranoid but cheap, removes a single-point-of-failure for the demo runner.
  Public API of `agent-profiles.ts`, `agent-decisions.ts`, and `profiles.py`
  is unchanged so no call site updates needed.
- 2026-05-24: Phase 4 of the autonomous-agent plan shipped. Two pieces:
  (1) Contract: AgentAccount now takes USDC in its constructor and auto-
  approves the target for exact `maxCost` before forwarding `buy()` calls.
  Avoids needing `approve` in the session selector whitelist (which would
  have been a wide attack surface). Factory redeployed.
  (2) Python: `agent/profiles.py` reads the JSON store; `agent/loop.py`
  grew per-user mode (default) that loads each runnable profile and
  executes via `AgentAccount.execute(market, 0, buyCalldata)` signed by
  `AGENT_SESSION_PRIVATE_KEY`. `--watch` is a simple in-memory scheduler
  (no Redis/BullMQ — overkill for hackathon scale). Legacy dev-EOA path
  preserved behind `--legacy`. Decisions are tagged with `user_addr` +
  `agent_addr` and the `/agent?u=<addr>` route filters the feed to one
  user. Operational note: the session key EOA needs gas USDC funded on
  Arc before going live — fund manually from the deployer EOA.
- 2026-06-17: **Full migration to Circle Developer-Controlled Wallets; legacy
  AgentAccount/session-key system removed entirely.** Why: the two execution
  models had been colliding — legacy profiles had no `circle_wallet_id`, so the
  x402 reasoning-fee gate blocked every trade (agent traded for nobody). Verified
  the Circle path end-to-end first (3 wallets created, funded from the deployer,
  traded live on Arc). Changes: (1) deleted `AgentAccount.sol` +
  `AgentAccountFactory.sol` + test; (2) `agent/loop.py` — removed `--legacy`
  dev-EOA mode, `execute_buy*`, `AGENT_ACCOUNT_ABI`, `RISK_PROFILES`, and all
  session-key plumbing; execution is Circle-only (`circle_wallets`); (3)
  `profiles.py` — `is_runnable` now requires `circle_wallet_id`; dropped the 4
  `session_*` fields; (4) DB — dropped the `session_*` columns + `agent_session_keys`
  table and wiped all 4 (legacy) profiles for a clean slate (migration
  `0005_drop_legacy_session.sql`, applied directly since this DB isn't managed by
  drizzle `migrate()` — no `__drizzle_migrations` table); (5) web — removed session
  fields from `agent-profiles.ts` / profile route / setup wizard, deleted
  `agent-account-card` + `agent-session-card`, stripped AgentAccount ABIs from
  `lib/contracts.ts`, removed `import-json.ts`. Also fixed a latent bug: the Circle
  approve/buy/fee calls used non-UUID `idempotencyKey`s which Circle rejects with
  400 — now `uuid5`-derived. `AGENT_SESSION_PRIVATE_KEY` is now unused. Gas Station
  not required: Circle SCA wallets pay gas from their own USDC balance on Arc.
- 2026-06-19: **LLM provider priority flipped — OpenRouter is now primary, Gemini
  is the fallback.** Why: the Google Console account got suspended (billing dispute)
  and the app lost direct Gemini access. Fix keeps the *same models* by routing them
  through OpenRouter as `google/gemini-*` slugs (same Gemini models, billed by
  OpenRouter, no Google account). Changes: (1) `.env` / `.env.example` —
  `BRAIN_PROVIDER=openrouter` (drives `policy.py:_use_gemini_models()` → tier models
  are now `google/gemini-3.1-flash-lite` (economy) and `google/gemini-3-flash-preview`
  (standard/premium)); `OPENROUTER_INSIGHT_MODEL=google/gemini-3.1-flash-lite`; new
  `BRAIN_FALLBACK=1`, `BRAIN_TEMPERATURE=0.15`, `OPENROUTER_REASONING_EFFORT=low`.
  (2) `agent/brain.py` — `estimate()` is now a dispatcher: OpenRouter primary via the
  extracted `_estimate_openrouter()`, falling back to `_estimate_gemini()` only when
  OpenRouter returns None (gated by `_gemini_fallback_available()`, independent of
  `BRAIN_PROVIDER` so a forced-OpenRouter agent can still fall back). `DEFAULT_MODEL`
  prefers `OPENROUTER_PRO_MODEL`; the OpenRouter call now sends `temperature` +
  `reasoning.effort` (mirrors `GEMINI_TEMPERATURE` / `GEMINI_THINKING_LEVEL`).
  (3) `web/lib/llm.ts` — insight dispatcher reversed (OpenRouter first, Gemini
  fallback); blank `AI_INSIGHT_PROVIDER` now means OR-primary. Verified with a live
  `brain.estimate()` call: `google/gemini-3-flash-preview` returned a valid estimate
  through OpenRouter. Caveat: the Gemini fallback itself fails while the Google
  account is suspended (returns None → market skipped); it's wired for when Google is
  restored. OpenRouter billing is separate from Google.
- 2026-07-18: **v2 factory made canonical; catalog migrated (unexpired markets only).**
  `ADDRESSES.factory` → v2 `0x7A31…ACd`, v1 kept as `ADDRESSES.factoryLegacy`.
  Catalog (`lib/markets.ts`) reads v2 in full + only unexpired v1 markets: the
  13.8k-market v1 corpus is probed ONCE per process (gentle 100-addr batches,
  backoff; deadlines are immutable so expiry is decided locally afterwards) via
  a background scan — requests never block on it. Summary multicalls shrunk to
  25 markets/batch (free Arc RPCs reject 750-call batches: "request limit
  reached"); SWR refresh failures serve stale cache instead of rejecting
  unhandled. `MarketSummary.legacy` tags the source; bet-ticket routes
  cancelled-market claims to `claimRefund()` on v2 (v1 keeps `claim()`), admin
  withdraw buttons route to the owning factory, portfolio scans both factories.
  Keepers: polymarket-resolution-keeper is dual-factory (v2 → RESOLVER key,
  v1 → deployer); fast-market-keeper resolves v2 with the resolver key and has
  a `--legacy-factory` mode (resolve/sweep v1 only, no creation). Resolver EOA
  funded. E2E verified on-chain: v2 create → Circle-wallet buy → resolver-key
  resolve → claim. GOTCHAS: (1) web/.env.local `DEPLOYER_PRIVATE_KEY` is
  `0xcf03…` which is NOT the factory admin (`0xdfB1…`, root .env) — server-side
  creation from the Next app (telegram webhook → list-market) will revert
  NotAdmin until that key is fixed; scripts load root .env and are fine.
  (2) ~13.8k expired-unresolved v1 fast rounds still hold seed liquidity —
  recoverable via `fast-market-keeper --legacy-factory` residual sweeps.
- 2026-07-21: **Agent v2 — the autonomous scanner became a genuine agent (M1–M3),
  plus a v1-factory correctness fix and expired-market filtering.** Design spec was
  agreed up front (one agent, two triggers — the scheduler and the chat user —
  sharing one brain, memory, tool belt, and risk gate). Shipped:
  · **v1-factory fix (was actively trading the wrong factory):** `discover_markets`
    (loop.py) read the v1 legacy factory ONLY, so the live agent traded legacy
    markets and saw ZERO v2 markets. Now reads v2-canonical (`0x7A31…`) in full +
    unexpired v1 (one-time cached liveness scan, mirrors web catalog). Env:
    `AGENT_FACTORY_ADDRESS`, `AGENT_FACTORY_LEGACY_ADDRESS`, `AGENT_INCLUDE_LEGACY`,
    `AGENT_LEGACY_SCAN_TTL_S`.
  · **New modules.** `agent/agent_core.py` — `run_agent_turn`, the single OpenRouter
    tool-use primitive both the autonomous planner/reflect turns and chat use (a
    generalization of brain.py's loop); `plan_pass`/`reflect_pass`. `agent/tools.py`
    — the shared tool belt: read tools, `check_trade` (policy-as-tool: the
    deterministic risk gate exposed as a tool the model can query but never widen),
    memory writes, chat read tools, and `propose_trade`. `agent/chat.py` — streaming
    chat turn (assistant persona).
  · **Memory & narrative.** Migration `0009_agent_memory.sql` adds `agent_theses`
    (the agent's live view per market/bucket, carried across runs), `agent_journal`
    (append-only first-person account), `agent_preferences`. Mirrored in
    web/lib/db/schema.ts; accessors in agent/db.py. Applied directly (idempotent
    `CREATE … IF NOT EXISTS`, like the market_index migration). `agent_decisions`
    stays — the risk gate reads it.
  · **M1 (planner).** Autonomous pass is now perceive → PLAN → score → act →
    REFLECT: a planner turn reviews theses + portfolio + a pre-filtered shortlist,
    updates memory, and narrows the (paid) scoring to markets worth a deep look;
    reflect writes a journal entry. Wired into `run_for_user`, **opt-in via
    `AGENT_PLANNER=1`, fail-safe** (planner error → falls back to the deterministic
    shortlist, so it can never stop the agent from trading).
  · **M2 (chat read).** runner.py grew a `POST /chat` SSE endpoint on the existing
    threaded `http.server` (deliberately NOT FastAPI — avoids restructuring the live
    watch-loop process and fits the sync OpenAI streaming SDK). Streams
    status/tool/delta/done events. Chat read tools incl. `read_portfolio` (on-chain
    scan across the user's connected wallet + Circle agent wallet). Web:
    `app/api/agent/chat/route.ts` (SSE proxy, attaches `AGENT_CHAT_SHARED_SECRET`),
    `components/agent-chat.tsx` (streaming panel on `/agent`). Auth is lightweight —
    the browser sends its connected address; no signature to *ask questions*.
  · **M3 (chat write).** `propose_trade` prices an order against the live LMSR curve
    and emits it as a `proposal` SSE event — it **signs nothing**. Chat trades
    execute on the user's **connected wallet** (approve+buy via wagmi in the confirm
    card, same path as bet-ticket; user approves each tx). Recorded to the journal
    via `POST /chat/record` + `app/api/agent/chat/record/route.ts`.
  · **Expired-market filtering.** Chat's `search_market_index` + `propose_trade`
    checked `resolved` but not `deadline`, so ~7 expired-unresolved v2 markets were
    being surfaced and priced. Fixed: `propose_trade` rejects expired (+
    `AGENT_CHAT_MIN_TTE_SECONDS` buffer, default 120s, so a trade can't race expiry
    mid-confirm); search excludes expired by default (`include_expired` opt-in);
    defensive `tte_hours <= 0` skip in `run_for_user`. Autonomous was already safe
    (`load_market_states` drops expired). Those stuck markets still need the resolver
    keeper — see the `expired-unresolved-markets` memory.
  · **OPERATIONAL:** the running pm2 `yolo-agent` (runner.py) must be **restarted**
    to activate ANY of this — it predates all of M1–M3. Needs OpenRouter credits
    (brain + chat 402 without). Env to set: `AGENT_PLANNER=1`, `AGENT_SERVICE_URL`
    (web→agent, default `127.0.0.1:8080`), `AGENT_CHAT_SHARED_SECRET` (both sides).
  · **Verified headless:** planner/reflect against real markets, chat SSE end-to-end
    including the browser proxy (after clearing a stale Turbopack `.next` cache that
    was 404-ing all API routes), `propose_trade` pricing, journal recording. Not
    headless-testable: the literal wallet-signature click (needs a browser + wallet).
  · **M4 (polish) — complete.** (1) thesis TTL/expiry sweep + `due_for_revisit` in
    the reflect step (`AGENT_THESIS_TTL_DAYS` default 14). (2) legacy single-shot
    `llm_estimate` fallback removed — brain.py is the sole estimator; `_pick_estimate`
    returns (None,None) when no provider/brain. (3) **concurrency:** per-market
    scoring runs in a thread pool before the serial loop (`AGENT_SCORE_CONCURRENCY`
    default 4, `AGENT_MAX_SCORED_PER_RUN` default 6). ONLY the read-only brain calls
    parallelize — every risk-gate mutation, x402 fee, credit debit, and Circle
    execution stays in the single serial loop, so budget accounting and the agent
    wallet's tx ordering are never raced. Candidates replicate the loop's pre-brain
    filters + are capped by the remaining daily brain budget; the serial loop
    consumes the cache and falls back to inline scoring for anything past the cap.
    `AGENT_SCORE_CONCURRENCY=1` disables it (identical to the old inline path).
    Verified ~1.9x faster on a 5-market pass with identical decisions.
- 2026-08-01: **Telegram admin command center + `/create`; bot transport moved from
  the Vercel webhook to a pm2 long-poller.** The admin can now author a market
  from chat — no dashboard, no shell.
  · **Transport switch (the load-bearing change).** Telegram allows exactly ONE
    transport per bot: `getUpdates` returns 409 while a webhook is registered.
    `scripts/telegram-bot.ts` (pm2 `yolo-telegram-bot`, `npm run telegram:bot`)
    now long-polls and **deleted the webhook** at
    `https://yolomarkets.fun/api/telegram/webhook` on boot. Re-registering that
    webhook would silently kill the poller — don't, unless you also stop pm2.
    Why the VPS: (1) it is long-lived, so `createMarket` can wait for its receipt
    (a Vercel function may be frozen the moment it responds — the old detached
    `void listAndReport(...)` was already exposed to this); (2) it loads root
    `.env` first, whose `DEPLOYER_PRIVATE_KEY` **is** the factory admin `0xdfB1…`,
    which sidesteps the long-standing `NotAdmin` TODO (web/.env.local holds
    `0xcf03…`, not the admin); (3) no public URL / TLS / webhook secret.
  · **Shared router.** All behaviour lives in `lib/telegram-router.ts`
    (`handleUpdate`); the webhook route is now a ~40-line adapter over it, so
    flipping back to Vercel is a config change, not a rewrite. The Polymarket
    "List on YOLO" buttons (`L:`/`S:`/`X`, from `telegram-suggest`) moved into the
    same router untouched and keep working over the poller.
  · **`/create`.** Two entry points, one state machine: a bare `/create` runs a
    4-step wizard (question → deadline → seed → review), and
    `/create <q> | <deadline> | <seed> [| category [| criteria]]` jumps straight
    to review. The wizard **edits one card message in place** instead of spamming
    the chat. Deadlines parse `7d`/`36h`/`2w`, `2026-12-31` (→ 23:59:59Z),
    `2026-12-31 18:00` (UTC) and full ISO with an offset; category auto-classifies
    via the (now exported) `classifyCategoryFromText`; criteria defaults to a
    template that spells out **manual settlement** — nothing auto-resolves these,
    the polymarket keeper only settles markets carrying MIRROR metadata.
  · **State + double-deploy guard.** Migration `0010_telegram_market_drafts.sql`
    (+ `telegramMarketDrafts` in schema.ts, applied directly like 0008/0009) holds
    in-flight drafts, because each Telegram update is its own request. The confirm
    button deploys only if it can atomically move the row `confirm` → `deploying`
    (`claimDraftForDeploy`), so a double-tap or a Telegram retry is a no-op; a
    failed deploy returns the row to `confirm` so Retry is a real retry. One open
    draft per chat — `startDraft` cancels the rest.
  · **Preflight.** `preflightCreate()` in `lib/list-market.ts` reads
    `factory.admin()` + deployer USDC balance and is rendered into the review card
    and `/status`; when the signer isn't the admin (or is broke) the Create button
    is **replaced by "Re-check"** rather than burning gas on a `NotAdmin` revert.
  · **Other commands:** `/status` (deployer, balance, admin check), `/cancel`,
    `/help`, `/start` (unchanged, still open to non-admins for chat-id discovery).
    Registered via `setMyCommands` so they appear in Telegram's "/" menu.
    Everything except `/start` is gated on `TELEGRAM_ADMIN_CHAT_ID`.
  · **Refactor:** `deployListing` is now a thin wrapper over `deployMarket`, the
    shared deploy path for both mirrored and hand-written markets.
  · **Verified:** typecheck clean; 45 parser assertions (deadline formats +
    rejections, seeds, questions, categories, one-liner incl. pipes inside
    criteria); draft lifecycle + double-claim guard against the live Supabase DB;
    preflight on-chain (deployer == factory admin, $433 USDC); router smoke test
    driving synthetic updates through `/help`, `/status`, non-admin refusal,
    `/create` one-liner → review card, a category button, and `/cancel`. NOT
    tested: an actual on-chain `/create` deploy — that spends real seed USDC and
    is the admin's call to make from chat.
- 2026-08-01: **Cover images for admin-authored markets** (extends the Telegram
  command center above). Send a photo while drafting and it becomes that
  market's card + hero art.
  · **Why it needed new storage.** `createMarket` has no image field, and the
    catalog otherwise *derives* art: `lib/native-image-overlay` fuzzy-matches a
    market's question back to Polymarket event imagery, plus hardcoded token
    logos for fast markets. A hand-written market matches nothing — and
    `app/page.tsx` **hides artless markets from the catalog entirely**
    (2026-07-18 request), so before this a `/create` market was invisible on the
    homepage. Admin art is now part of that filter's artwork test.
  · **Storage.** Migration `0011_market_images.sql`: `market_images`
    (address → mime + bytea + byte_size) and `image_data`/`image_mime`/`image_size`
    on `telegram_market_drafts` — the draft holds the bytes until the deploy tx
    mints an address to key them by. Bytes live in Postgres, NOT object storage:
    Telegram photos are ~3–200 KB and it keeps the feature free of new cloud
    credentials (there is no Supabase storage key in root `.env`). `bytea` needed
    a drizzle `customType` (exported as `bytea` from schema.ts); postgres-js maps
    it to Buffer natively. Cap `MAX_IMAGE_BYTES` = 5 MB, mime allow-list
    jpeg/png/webp/gif.
  · **Serving.** `app/api/markets/<address>/image` streams the bytes with an
    ETag + 304 support. `adminImageUrl()` appends `?v=<updated_at epoch>`; a
    versioned URL is cached `immutable`, a bare one revalidates — so replacing an
    image busts caches without changing the address-derived URL.
  · **Precedence** (identical on cards and the detail hero): admin image →
    fast-market token logo → Polymarket overlay. `imageFor()` in home-sections.ts
    is now exported and takes an optional `ImageVersionMap`; `app/page.tsx` loads
    it via `getAdminImageVersionsSafe()` in the same `Promise.allSettled` as the
    overlay (never throws — the catalog still renders if the DB is down).
  · **Telegram UX.** A photo is accepted at ANY open draft step (unambiguous —
    no need to navigate first) and the wizard resumes where it was; a photo whose
    **caption** is `/create …` does both in one message; the review card shows
    `Image: ✓ attached (N KB)` plus a 🖼 button (→ image card, with Remove).
    Compressed photos take the largest rendition; uncompressed `document`
    uploads work if their mime is `image/*`. Telegram re-encodes photos to JPEG,
    so `mimeFromPath` reads the type off the returned `file_path`.
    NOTE: the file download URL embeds the bot token — bytes are always fetched
    server-side and re-served by us, never linked to a browser.
  · **Verified:** typecheck + lint clean; 30 storage assertions (bytea
    round-trip byte-identical incl. NUL bytes, upsert bumps updated_at, mime and
    size rejection, case-insensitive lookup, version map, card precedence, draft
    columns); a real photo uploaded through the Bot API then pulled back via
    getFile/downloadFile and attached through `handleUpdate` (incl. the remove
    button and the post-deploy `putMarketImage`); the serving route handler
    called directly for 200/304/400/404, cache headers and byte fidelity.
- 2026-08-01: **GOTCHA — standalone scripts must import `scripts/load-env.ts` FIRST.**
  Found when the freshly-started `yolo-telegram-bot` answered every `/create`
  with "DATABASE_URL is not set". Two things compound:
  (1) `lib/db/index.ts` captures `process.env.DATABASE_URL` at **module scope**,
  and its root-`.env` fallback is gated on `NODE_ENV !== "production"` — which
  pm2 sets, so there is no safety net in production;
  (2) tsx/esbuild **hoists `require` calls above the statements between them**,
  so a `loadEnv()` written at the top of a script's body — even physically above
  the `../lib/*` imports — still runs *after* those modules have been evaluated.
  Import ORDER is preserved, so the fix is a side-effect module:
  `import "./load-env";` as the first import (see `scripts/load-env.ts`, which
  loads root `.env` then `web/.env.local` without override).
  Why the older keepers never hit this: `catalog-indexer.ts` and friends build
  their own `postgres(url)` client *inside* `main()`, reading the env at call
  time; only scripts that import `lib/db` (directly or transitively — here via
  `telegram-router` → `telegram-create` → `telegram-drafts`) are exposed.
  `telegram-bot.ts` now also **probes the draft store at boot**
  (`probeDraftStore()`) and requires `DATABASE_URL`, so a misconfigured process
  dies immediately instead of running "online" while failing every command.

- 2026-08-01: **Admin page load fixed — two independent bugs, one CORS, one N+1.**
  · **CORS (browser RPC entirely dead).** `web/lib/wagmi.ts` used a bare
    `http()`, which resolves to `arcTestnet.rpcUrls.default` =
    `rpc.testnet.arc.network` — the ONE Arc endpoint that sends no
    `Access-Control-Allow-Origin`. Every browser JSON-RPC call from
    yolomarkets.fun was blocked, so balances/allowances read as 0 and
    `useWaitForTransactionReceipt` never settled (approve + createMarket hung
    forever). Now pins a CORS-safe fallback list — quicknode, blockdaemon, dRPC
    — overridable via `NEXT_PUBLIC_ARC_TESTNET_RPC_URLS`; defaults ship in code
    so no env change is needed. See gotcha #3. Also fixed
    `app/admin/login/login-client.tsx` awaiting `connect` (the sync mutate fn)
    instead of `connectAsync`, which swallowed every wallet-connection error.
  · **N+1 residual scan (~70s per load).** `app/admin/page.tsx` called
    `getMarketRevenue` per market over the whole v2 catalog — 5151 markets ×
    one `eth_call` each, fired concurrently, on a `force-dynamic` page with no
    cache — then discarded the 98% whose `treasuryWithdrawable` is 0. Replaced
    with `listTreasuryResiduals()` in `lib/markets.ts`: pass 1 probes only
    `treasuryWithdrawable` in 400-market Multicall3 aggregates, pass 2 reads the
    other three fields for the ~120 survivors, both with bounded concurrency,
    behind the same SWR cache shape as `listMarkets`. **Measured 2.2s cold /
    0ms warm vs ~70s.** Pass 2 re-applies the `> 0` filter because a keeper can
    sweep a residual between the two passes (row count genuinely drifts 118-121
    run to run — that's the fast-market keeper working, not a bug).
  · **GOTCHA — viem re-splits multicalls at `batchSize` BYTES (default 1024,
    ~6 calls).** A 400-contract multicall silently became ~70 requests until we
    passed `batchSize: 0`. With splitting off each chunk is one serial
    round-trip, so bounded concurrency (4) is what recovers the wall time; the
    naive serial version measured 5.9s. Chunk stays at 400 because free Arc RPCs
    reject 750-call batches ("request limit reached").
- 2026-08-01: **Shareable ticket images (market + position), Polymarket-style.**
  · **Two cards, one renderer.** `lib/share-card.tsx` (next/og → Satori → resvg)
    draws a market ticket and a bet ticket at 1200×630; `lib/share-data.ts`
    loads them. Surfaces: `app/markets/[address]/opengraph-image.tsx` (the
    file convention — Next injects `og:image`, so ANY pasted market link
    unfurls with no share button involved) and
    `app/api/markets/[address]/share` (stable URL for the in-app button;
    `?user=0x…[&side=yes|no]` switches it to that wallet's position card).
  · **`components/share-button.tsx`** — popover with a live preview of the
    actual generated card plus copy-link / copy-image / save-image / post-on-X /
    native share sheet (`navigator.share` with the PNG as a File where
    supported). Copy-image is feature-detected (`ClipboardItem` +
    `navigator.clipboard.write`, both absent on non-secure origins) and hidden
    when unavailable. It hands `ClipboardItem` the fetch **promise** rather than
    an awaited blob — Safari treats an intervening `await` as losing user
    activation and rejects the write. The `"image/png"` key must equal the
    blob's own type or Chrome throws; the share route sets that content-type.
    Wired into the market detail meta row and both portfolio row types
    (`compact` variant; it `preventDefault`s because the rows are `<Link>`s).
  · **Metadata fixes that the feature depended on.** Root `metadataBase` was
    `https://yolo.markets` — the wrong origin — which resolves every relative
    `og:image` to a domain that isn't the site and silently breaks unfurls.
    Now follows `NEXT_PUBLIC_SITE_URL` (fallback `yolomarkets.fun`). Added
    `generateMetadata` to the market page so a link unfurls with the question
    as its title instead of the generic site card.
  · **SATORI GOTCHAS (all verified empirically, don't re-litigate):**
    (1) a `div` defaults to `display: flex`, so a *text* node must be
    `display: block` or every word becomes a flex item — and a block node may
    have only ONE child, so interpolate (`{`${n} shares`}`) rather than mixing
    an expression with a literal; (2) no CSS grid, no `wordSpacing` (ignored);
    (3) `@vercel/og` bundles **Geist-Regular** as its default font — the same
    family the app uses — so no font is shipped and no `fontFamily` is declared;
    there is no bold cut, so hierarchy comes from size/colour/tracking, not
    weight; (4) Satori shapes some space pairs slightly wide (notably after
    "r"). That is a shaping artifact, confirmed identical with an explicitly
    registered Geist ttf, at every letterSpacing, and with block vs flex text.
  · **Design.** The ticket is an inset card floating on a backdrop (`MAT` = 54px
    of matting, card `borderRadius` 28 + drop shadow), NOT a full-bleed banner —
    the accent bloom and diagonal sheen live on the backdrop so the card surface
    stays clean. **Card interior is 630 − 2·MAT = 522px and the content must fit
    inside it with slack**: overflow makes flexbox shrink the `flex: 1` row while
    fixed-size artwork does not, so the art visibly collides with the header.
    That is why artwork is 150px (market) / 120px (bet), margins are ~20px, and
    `Art` carries `flexShrink: 0`. Re-check the arithmetic before enlarging
    anything. Accent is blue
    for open markets, gold for resolved, and the side colour (or won/lost
    colour) on bet cards — tinting the backdrop bloom too, so a WON card reads
    green from across the timeline. Artwork precedence matches the site (admin cover →
    fast-market logo → Polymarket overlay), with a deterministic per-address
    hue + category monogram when a market has none. The admin cover is inlined
    as a **data URI** rather than pointing at `/api/markets/<addr>/image` —
    otherwise the renderer fetches its own deployment, which is slow and breaks
    on preview URLs.
  · **No fabricated P&L.** There is no on-chain cost basis (the portfolio only
    reads `sharesYes`/`sharesNo`), so the bet card shows side, shares, current
    price, value, payout and the `1/price` multiple — never an invented entry
    price or return. Settled cards drop the redundant "value" column and a
    losing side reads `$0.00` payout.
  · **Verified:** typecheck + lint clean (only 3 pre-existing warnings, none in
    new files); all six card variants rendered and **visually inspected**, then
    iterated (fixed the prob bar welded to the artwork, the `yolomarkets .`
    wordmark gap, `$143`→`$142.50` rounding, mixed-case addresses, and dead
    vertical space); route handlers called directly for the market card, the
    `?user=` card, the OG route, and every bad-input path (invalid address,
    invalid wallet, unknown market all return a branded fallback card, never a
    500). **NOT verified:** a bet card rendered from a real non-zero on-chain
    position — every wallet checked (20 swarm wallets across 120 markets, plus
    60 market/wallet pairs from `agent_decisions`) currently holds zero shares,
    so the settled/open bet branches were exercised with synthetic data and a
    proven-working chain read path.
- 2026-08-01: **OUTAGE + FIX — an un-timeboxed Polymarket fetch hung the whole
  site.** Symptom: `/` and `/markets/[address]` returned HTTP 200 with TTFB
  ~0.3s and then **never finished streaming** (>180s, every time). No error, no
  500 — just a shell that never filled. Looked like "Vercel keeps breaking".
  · **It was not Vercel, the DB, or the RPC.** Isolated by testing deployed
    routes that differ by one dependency: `/agent` (neither) 0.28s,
    `/markets/p/<slug>` (one Gamma call, no catalog) 0.47s, `/markets/fast`
    (catalog + chain, **no overlay**) 0.40s — vs `/`, `/?cat=…` and
    `/markets/<addr>` (all three call the overlay) hanging. Postgres answered in
    40ms, all four Arc RPCs in ~90ms, and the whole homepage data path runs in
    ~1.7s on the VPS. The single differentiator was `getNativeImageOverlay()` /
    `lookupNativeImage()`.
  · **Mechanism.** `getNativeMatchOverlay` → `fetchWrappablePolymarketMarkets`
    pages Gamma `/markets` 100 at a time (`scanLimit` clamps to 1000 → **10
    sequential requests, ~7.8 MB**). Every one was a bare `fetch()` with no
    `signal`, so when Gamma stalls mid-burst — near-certainly WAF rate-limiting
    of a datacenter-IP burst; a *single* Gamma call from Vercel is fine — the
    request waits forever. `Promise.allSettled` in app/page.tsx then waits
    forever too (it does not time out), while Next has already streamed the
    shell. Hence 200 + infinite hang instead of an error.
  · **Fix 1 — every Gamma call is now bounded.** `gammaFetch()` in
    lib/polymarket.ts wraps fetch with `AbortSignal.timeout(POLYMARKET_TIMEOUT_MS,
    default 4000)` and returns `null` instead of throwing; all five call sites go
    through it. The paging loop also honours `POLYMARKET_SCAN_BUDGET_MS`
    (default 9000) so ten pages can't serially spend ten timeouts, and **keeps
    partial results** — pages arrive in volume order, so the markets actually on
    screen are already indexed.
  · **Fix 2 — the artwork gate degrades OPEN.** app/page.tsx hides markets with
    no artwork; with the overlay down NOTHING matches, so that filter would have
    turned a hanging homepage into an empty one. `getNativeImageOverlayResult()`
    now returns `{ lookup, available }` (`available` = the scan returned any
    events) and the filter is skipped entirely when it's false.
  · **Verified:** against a server that accepts the connection and never
    answers — the exact failure mode — the overlay returns in **2.0s** with
    `available=false` and the catalog keeps every market (previously: forever).
    Partial stall (2 good pages then dead) → 2.1s, `available=true`, partial
    index retained. Healthy path unchanged: overlay builds in 1.4s, homepage
    data 1.1s, 5239 markets. `fetchPolymarketEventBySlug` re-verified on 5/5
    real binary slugs (an *event* slug with only group children correctly
    returns null — that is pre-existing behaviour, not a regression).
  · **LESSON: never `fetch` a third party during SSR without a deadline.** The
    failure mode is not an error, it's an invisible hang that looks like a
    hosting problem.
- 2026-08-01 (cont.): **The Gamma timeout alone did NOT fix the outage — the
  real defence is a deadline on every SSR dependency.** After deploying the
  timeout fix, `/` and `/markets/[address]` still streamed HTTP 200 and hung
  forever, while `/agent` (0.26s) stayed fine.
  · **The overlay fix did work.** Proven from production: the share route on a
    market with no admin art and no fast-market logo — so `resolveArt` *must*
    reach `lookupNativeImage` — returns **200 in 2.2s**. Gamma is no longer the
    stall. (First attempt at this test was invalid: the market picked was a fast
    round, so `getFastMarketImage` short-circuited before the overlay.)
  · **Why the earlier isolation was wrong.** `/markets/fast` looked like proof
    that `listMarkets()` was healthy on Vercel — it is not: it answers
    `x-nextjs-prerender: 1`, `x-vercel-cache: STALE`, so it serves a cached
    render and never executes the read. `/portfolio` is prerendered too. On a
    prerendered route, timings say nothing about request-time behaviour —
    **always check `x-vercel-cache` before treating a fast route as a control.**
  · **The structural bug.** `listMarkets()` keeps an in-process SWR cache
    (`marketsCache`); on a long-lived VPS it is warm after one request, but on
    serverless a cold instance takes the "Cold: this one request has to wait for
    the read" branch. If `readV2CatalogFromDb()` then *hangs* rather than throws
    (its try/catch only catches rejections), the render waits forever — and a
    starved Supabase pooler hangs rather than erroring, because postgres-js had
    no `connect_timeout`.
  · **Fixes.** (1) `lib/with-deadline.ts` — `withDeadline(p, ms, label,
    fallback)`, applied to every awaited dependency on `/` (listMarkets,
    overlay, adminImages, movers) and `/markets/[address]` (getMarket,
    getMarketRevenue, adminImages, overlay, and the `generateMetadata` read,
    which blocks the shell). `Promise.allSettled` was replaced with
    `Promise.all` over deadlined promises — allSettled never settles for a
    *pending* promise, which is exactly the failure mode. (2) `lib/db/index.ts`
    now sets `connect_timeout` (default 10s) and `statement_timeout` (15s) so a
    starved pool errors instead of blocking. (3) `app/api/diag` times every
    dependency **in production** and reports the slowest plus `pgPort` — built
    because the only reason this took so long to pin was having no way to
    measure Vercel from outside.
  · **STILL RECOMMENDED:** move `DATABASE_URL` to the Supabase **transaction
    pooler (:6543)**; it is currently on the session pooler (:5432), which caps
    around 15 clients and *blocks* when exhausted — the wrong mode for a
    serverless fan-out. Verified both ports work from the VPS (240ms vs 182ms);
    `prepare: false` is already set, which transaction mode requires.
  · **Verified:** deadline helper unit-tested against a never-resolving promise
    (returns the fallback, clears its timer), a rejecting promise, and the happy
    path (no added latency); `/api/diag` exercised end-to-end — postgres 279ms,
    RPC 189ms, listMarkets 424ms (5302 markets), adminImages 49ms, overlay
    1023ms, total 1964ms. Typecheck + lint clean.
- 2026-08-01: **Admin panel — manual market resolution** (`app/admin/resolution-panel.tsx`,
  section 04). Lists every non-fast market **awaiting settlement** (past deadline,
  unresolved) with YES / NO / CANCEL actions, plus a collapsed **settled history**.
  Live today: 48 awaiting, 5201 fast markets excluded.
  · **Signing.** Client-side wagmi like the withdraw buttons — deliberately NO
    server key, so the web tier keeps holding zero private keys. The wrinkle:
    v2 `resolveMarket` is `onlyResolver`, and the resolver (`0xF95C…61aF`) is a
    DIFFERENT address from the admin you log in with (`0xdfB1…901`, audit
    H-1/H-2 role separation). Legacy v1 has no resolver role — its admin settles.
    The panel reads `resolver()`/`admin()` on-chain, compares them to the
    connected account per row, and blocks the confirm with "connect 0xF95C…"
    rather than letting you burn gas on a `NotResolver` revert. `resolver()` was
    missing from `factoryAbi` and is now added.
  · **Guards.** Settlement is irreversible, so every action is two-step
    (pick outcome → confirm). Only past-deadline markets are listed because
    `PredictionMarket.resolve` reverts `BeforeDeadline` otherwise — verified 0
    of the 48 listed rows would revert.
  · **Fast markets are excluded via `matchesFastMarket`, NOT `isFastMarket`** —
    the latter returns false for *resolved* markets, which would have leaked
    settled fast rounds into the history list. `fast-market-keeper` settles those
    on a timer and hand-settling one would race it.
  · **Note:** the 48-market backlog is the known `expired-unresolved-markets`
    problem (the polymarket resolution keeper timing out), now hand-clearable.
- 2026-08-02: **Portfolio 429 storm fixed — the per-wallet share scan moved server-side.**
  Symptom: `/portfolio` took forever and the browser console filled with
  `POST rpc.quicknode.testnet.arc.network 429 (Too Many Requests)` from
  `portfolio-client.tsx`.
  · **Cause: the 2026-07-21 client-side scan didn't survive catalog growth.**
    The server passed every non-legacy market to the browser, which walked them
    in 40-market batches — fine at ~1k markets, fatal at **5326**: 134 sequential
    multicalls, each with a 100ms delay, is well over the query's own
    `refetchInterval: 30_000`. So each scan was still running when the next one
    started, they piled up, and the public RPC rate-limited everything. The
    "REMAINING: it still scans all ~1k v2 markets per load" note in the previous
    portfolio entry was exactly this bomb going off.
  · **Fix.** `listUserPositions(user)` in `lib/markets.ts` reuses the pattern
    that took the admin page from ~70s to 2.2s: `mapChunks` + Multicall3
    aggregates with **`batchSize: 0`** (viem otherwise re-splits at 1024 BYTES,
    ~6 calls) + concurrency 4, behind a per-wallet SWR cache
    (`POSITIONS_CACHE_TTL_MS` 20s) shared across tabs. Chunk is
    `RESIDUAL_SCAN_CHUNK / 2` = 200 markets, because 2 calls per market keeps
    each aggregate at the same ~400 calls the free Arc RPCs accept.
    Served by `app/api/portfolio/positions?user=0x…`; the client just fetches
    JSON and parses the shares back to bigint.
  · **Measured:** 5326 markets scanned in **3.5s cold / 0ms warm**, one wallet,
    no 429s — vs 134 browser round-trips before. Route verified for 200 / 400
    (bad address) / 400 (missing param).
  · The client keeps its 30s poll, but a poll is now one cached HTTP call rather
    than a fresh 134-request scan, so overlap is harmless.
