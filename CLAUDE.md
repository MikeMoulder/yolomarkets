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

3. **`forge install` requires a `.git`.** Even with `--no-git` flags it tried
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
