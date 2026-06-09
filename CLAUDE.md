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
| **MarketFactory** | `0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA` | 2026-06-05 redeploy — canonical factory with Cancelled outcome support; admin = deployer EOA |
| PredictionMarket (factory#0) | `0x13e97fFA9068452001Df8Df7EbEd043B35763237` | "ETH > 4000 next NYSE close" — 5 USDC, 7-day, admin = factory |
| AgentAccountFactory (Phase 2, abandoned) | `0x3eB6598c86725B44989a519EE8E5eFd1849aDC14` | superseded by v2 |
| AgentAccountFactory (Phase 3, abandoned) | `0x92B89Dd8E408f227e9407581350582D19fa0F8f1` | superseded by v3 (USDC binding + auto-approve) |
| **AgentAccountFactory** | `0x04538699e0dAe81258FD6Ff1408f763379827a8d` | Phase 4 — v3 with USDC immutable + auto-approve before `buy()`; constructor takes USDC addr |
| Deployer / admin EOA | `0xdfB1E9b15e93824dAD19C0E8Bf06a1b28DcEb901` | see `.env` |
| Agent session key (demo) | `0x0811d76Ea78884974244342918256FC20480AFb3` | server-side signer for the runner; PK in `.env` as `AGENT_SESSION_PRIVATE_KEY` — needs a sprinkle of USDC for gas before going live |

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
