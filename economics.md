# YOLO Markets — Agentic Economics Plan

## Core principle

Platform earns proportionally to agent activity.
Costs are transparent and sub-cent per trade — users are never priced out of small positions.

---

## Wallet Infrastructure — Circle Developer-Controlled Wallets

**Replacing:** Custom `AgentAccount.sol` + raw `AGENT_SESSION_PRIVATE_KEY` EOA signing.

**Target:** Each user's agent gets a **Circle Developer-Controlled Wallet** on Arc.

```
User enables agent mode
  → POST /v1/w3s/developer/wallets          (Circle creates MPC wallet on Arc)
  → wallet address stored in agent_profiles.agent_address
  → Circle wallet ID stored in agent_profiles.circle_wallet_id

Runner at trade time
  → POST /v1/w3s/developer/transactions/contractExecution
  → Circle signs + broadcasts via MPC (no private key in server memory)
  → Gas Station sponsors fees from developer Console account
```

**Why Developer-Controlled over User-Controlled for the agent wallet:**
- Agent executes autonomously — user is offline, can't approve PIN challenges
- Developer-Controlled wallets can be triggered server-side without user interaction
- User-Controlled wallets (existing onboarding flow) are still used for the user's *own* manual trades
- Two wallets per user: User-Controlled (manual) + Developer-Controlled (agent)

**`AgentAccount.sol` status:** retired for new users. Legacy users keep it; `--legacy` flag in runner preserved.

---

## Agent Configuration Surface

### Strategy Presets

| Preset | Description | Kelly | Edge threshold |
|--------|-------------|-------|---------------|
| `moonshot` | High-risk, large mispriced events | 1.0× | 3% |
| `quant` | Systematic low-variance | 0.25× | 5% |
| `contrarian` | Bets against Polymarket consensus when divergence > 10% | 0.5× | 10% |
| `news_trader` | Markets with recent news hits, fast cadence | 0.5× | 7% |
| `copycat` | Mirrors Polymarket positions | 0.25× | 2% |
| `custom` | Full manual control | any | any |

### Full Config Schema

```
STRATEGY
  preset:              moonshot | quant | contrarian | news_trader | copycat | custom
  brain_model:         economy | standard | premium   (Gemini Free / Pro slots)
  reasoning_depth:     fast | balanced | deep
  kelly_mult:          0.1 – 1.0
  edge_threshold:      0.01 – 0.20
  min_confidence:      0.50 – 0.95
  cadence_minutes:     15 | 30 | 60 | 120 | 240

SIGNALS (multi-select)
  polymarket           crowd prior from Polymarket Gamma
  web_search           live news via Perplexity Sonar
  social               Reddit / X sentiment (future)
  on_chain             whale movement signals (future)

MARKET FILTERS
  categories:          [crypto, politics, sports, science, economy, ...]
  min_liquidity_usdc:  e.g. 50
  min_tte_hours:       e.g. 4   (skip markets closing too soon)
  max_tte_hours:       e.g. 720 (skip very long-dated markets)
  odds_range:          [0.05, 0.95] (skip near-certain outcomes)
  watchlist:           specific market addresses (overrides categories)
  markets_mode:        all | categories | watchlist

POSITION MANAGEMENT
  stop_loss_pct:       e.g. 30 → exit if position down 30%
  take_profit_pct:     e.g. 200 → exit if position up 200%
  max_open_positions:  integer cap across all markets
  rebalance_drift:     if position weight drifts >X% → rebalance (future)

BUDGET CONTROLS
  budget_total:        lifetime USDC cap in agent wallet
  budget_per_market:   max USDC in any single market
  budget_per_day:      daily spend limit
  drawdown_pause_pct:  pause agent if portfolio down X% in rolling 7 days
```

---

## Economic Structure

### Layer 1 — Protocol Fee per Trade (0.3%)

- Runner deducts `0.3%` of `trade_amount` from agent wallet → platform treasury **before** calling `buy()`
- Minimum floor: $0.01 (so $1 trades work — minimum fee is $0.003, floored to $0.01)
- Visible to user in their decision feed as `platform_fee_usdc`
- Implemented as a Circle Developer wallet transfer: `treasury_addr ← fee`, then `market.buy()`

### Layer 2 — AI Credits System

Credits are consumed per brain run. Pre-purchased with USDC.

| Brain Tier | Credits/run | Default model | USDC/credit |
|------------|-------------|---------------|-------------|
| Economy | 1 | `GEMINI_FREE_MODEL` | $0.001 |
| Standard | 2 | `GEMINI_PRO_MODEL` | $0.001 |
| Premium | 4 | `GEMINI_PRO_MODEL` | $0.001 |

- Credits stored in `agent_credits` Postgres table (never on-chain)
- Agent with 0 credits → skips fresh AI scans until refill/top-up
- **Free tier:** 60 credits/month (auto-refilled on 1st of month) — enough for a small live starter agent
- Top-up: `POST /api/credits/buy` → Circle wallet transfer to treasury → DB credited atomically

### Layer 3 — Subscription Tiers

| Tier | Price/month | Credits | Live trading | Cadence floor | Caps | Brain |
|------|------------|---------|-------------|---------------|------|-------|
| Free | $0 | 60/mo | Yes | 4h | $1/trade, 3 trades/day, 12 scans/day | Economy Gemini |
| Pro | $5 USDC/mo | 1,000/mo | Yes | 1h | $5/trade, 12 trades/day, 120 scans/day | Standard Gemini |
| Plus | $20 USDC/mo | 5,000/mo | Yes | 15m | $25/trade, 50 trades/day, 500 scans/day | Plus Gemini slot |

Upgrade value is autonomy, not permission: Free can place real trades, while Plus gets faster scanning, richer evidence tools, larger risk budgets, and fewer conservative buffers.

- Subscriptions auto-renew: runner checks `subscription_expires_at`; if expired + auto-renew is enabled, debits agent wallet → treasury, extends by 30 days
- If auto-renew fails (insufficient balance) → downgrade to Free tier, notify user via `/agent` feed

### Layer 4 — Performance Share (5% of net profits, on withdrawal)

- When user withdraws from agent wallet: `profit = withdraw_amount − cost_basis`
- Platform takes `5%` of positive profit via withdrawal API
- Enforced off-chain: withdrawal routes through `POST /api/agent/withdraw`, which calculates and deducts the share before initiating the Circle transfer
- Cost basis tracked in `agent_credits.cost_basis_usdc` (updated on every deposit)

### Gas Economics

```
Circle Gas Station → sponsors all Arc transaction gas
                   → developer Console account pays; ~$0.005 per tx at Arc prices

Per-trade user-facing cost breakdown (example: $10 trade, Standard tier):
  Protocol fee:   $0.03   (0.3%)
  AI credit:      $0.005  (5 credits × $0.001)
  Gas:            $0.00   (Gas Station sponsored)
  ─────────────────────────────────
  Total overhead: $0.035 on a $10 trade = 0.35%
```

### Treasury Flow

```
Agent Wallet (user USDC, Developer-Controlled Circle Wallet)
    │
    ├── 0.3% protocol fee ─────────────────────► TREASURY_ADDRESS
    ├── AI credit deduction ───────────────────► Postgres agent_credits (off-chain)
    ├── Monthly subscription ──────────────────► TREASURY_ADDRESS (auto-debit)
    ├── 5% profit share on withdraw ───────────► TREASURY_ADDRESS
    │
    └── net amount → PredictionMarket.buy()
```

---

## Implementation Phases

### Phase A — Circle Developer-Controlled Wallets (current)
- `agent/circle_wallets.py`: thin Python client for Circle Developer Wallets API
- `agent_profiles` schema: add `circle_wallet_id` column
- `agent/loop.py`: new `execute_buy_via_circle()` path; replaces `execute_buy_via_agent()`
- New env vars: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `TREASURY_ADDRESS`

### Phase B — Expanded Config + UI Wizard
- DB migrations: add `preset`, `brain_model`, `reasoning_depth`, `stop_loss_pct`, `take_profit_pct`, `max_open_positions`, `min_tte_hours`, `max_tte_hours`, `odds_range_min/max`, `drawdown_pause_pct`
- `web/app/agent/wizard`: multi-step config wizard with preset cards
- `agent/profiles.py`: map new columns into `AgentProfile` dataclass

### Phase C — Economic Layer
- DB migrations: `agent_credits` table, `agent_subscriptions` table
- `agent/credits.py`: credit deduction, balance check, monthly free refill
- `agent/loop.py`: fee deduction before `buy()`, credit check gate, paper-trade fallback
- `web/app/api/credits/buy`: top-up endpoint
- `web/app/api/agent/withdraw`: withdrawal with profit-share deduction

### Phase D — Enhanced Brain + Position Management
- Stop-loss / take-profit monitoring loop
- Portfolio heat guard (max open positions, daily budget)
- Multi-signal fan-out in `brain.py`
