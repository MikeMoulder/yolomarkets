# YOLO Markets — Traction

A factual snapshot of what is actually running, taken **2026-08-09** from the
production database and Arc testnet. Every number here is reproducible with the
query or command beside it. Where a number is unflattering it is stated
anyway — a scoreboard that only reports wins is not a scoreboard.

---

## Platform

| Metric | Actual | Source |
| --- | --- | --- |
| Markets created (v2 factory) | **7,885** | `select count(*) from market_index` |
| Markets resolved | **7,768** | `select count(*) from market_index where resolved` |
| Markets open | 117 | the remainder |
| Legacy v1 markets (read-only) | ~13,848 | `factoryLegacy.marketCount()` |
| Chain | Arc testnet (5042002) | USDC is both settlement asset and gas |

Category mix of the indexed catalogue:

| Category | Markets |
| --- | --- |
| Fast (short-horizon crypto) | 7,765 |
| Other | 25 |
| Geopolitics | 20 |
| Politics | 19 |
| Crypto | 16 |
| Sports | 16 |
| Macro | 11 |
| Tech | 6 |

The catalogue is dominated by automated short-horizon "fast" markets; the
editorial and mirrored markets are the long tail. That is the honest shape of
it.

## Agent

| Metric | Actual | Source |
| --- | --- | --- |
| Decisions recorded | **3,903** | `select count(*) from agent_decisions` |
| Trades executed | **12** | `... where action <> 'pass'` |
| Executed live (not paper) | **12** | `... where paper = false` |
| Gross USDC traded | **$3.76** | `select sum(cost_usdc) ...` |
| Distinct users the agent trades for | 3 | `count(distinct user_addr)` |
| Persistent market theses | 39 | `select count(*) from agent_theses` |
| Journal entries | 350 | `select count(*) from agent_journal` |

**Read this honestly:** 12 trades out of 3,903 decisions is a ~99.7% pass rate.
Some of that is the risk gate working as designed — the most common recorded
refusal is `confidence below threshold`, which is the correct answer for a
short-horizon market with no real signal. Some of it is not: for stretches of
this period the AI provider was unavailable (credit exhausted on the primary,
daily free-tier quota on the fallback), and an agent that cannot form an
estimate cannot trade. Both causes are visible in `pass_reason`.

## Machine-to-machine payments (Circle Nanopayments on Arc)

| Metric | Actual |
| --- | --- |
| Gateway balance funded | $10.00 deposited |
| Spent buying services | **$0.0587** (≈587 paid calls @ $0.0001) |
| Remaining budget | $9.94 ≈ 99,400 calls |
| What was bought | Premium Arc RPC from QuickNode |
| Insight API sales | Verified end-to-end with real settlement |

The seller side (`/api/x402/insight`) has been proven with real settlement —
money left a Gateway balance and arrived at the treasury — but the buyer in
those tests was **our own payer wallet**. There is no third-party revenue yet;
the plumbing is real, the market for it is not.

## Circle product usage

| Product | Status | Evidence |
| --- | --- | --- |
| USDC on Arc | ✅ Core | Settlement, seed liquidity, protocol fees, and gas |
| Circle Developer-Controlled Wallets | ✅ Core | Agent execution — [agent/circle_wallets.py](agent/circle_wallets.py) |
| Circle User-Controlled Wallets | ✅ Onboarding | Email/OTP — [web/components/wallet-modal.tsx](web/components/wallet-modal.tsx) |
| Circle Nanopayments (x402 + Gateway) | ✅ Both directions | [web/scripts/nanopay-service.ts](web/scripts/nanopay-service.ts), [web/app/api/x402/insight](web/app/api/x402/insight/route.ts) |
| Circle Gateway | ✅ Via Nanopayments | Arc testnet, domain 26 |
| Circle Paymaster | ❌ Not applicable | Arc gas is already USDC — see INNOVATION.md |
| CCTP / App Kits / StableFX | ❌ Not used | Out of scope for a single-chain product |
| USYC | ❌ Mock only | Institutional KYB-gated; labelled as such in the UI |

## Live infrastructure

Seven background services run continuously under pm2:

| Service | Role |
| --- | --- |
| `yolo-agent` | The trading agent (569 passes, 1 failure) |
| `yolo-nanopay` | Signs and meters machine-to-machine payments |
| `yolo-catalog-indexer` | Keeps the market catalogue in Postgres |
| `yolo-fast-markets` | Creates and settles short-horizon markets |
| `yolo-fast-swarm` | Provides activity on fast markets |
| `yolo-polymarket-resolver` | Settles mirrored markets |
| `yolo-telegram-bot` | Admin command centre — authors markets from chat |

## Reproducing this file

```sh
# Platform + agent numbers
psql $DATABASE_URL -c "select count(*) from market_index"
psql $DATABASE_URL -c "select count(*), count(*) filter (where action <> 'pass'),
                              coalesce(sum(cost_usdc),0) from agent_decisions"

# Nanopayment balance
curl -s 127.0.0.1:8090/balance
```
