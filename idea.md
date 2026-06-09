# YOLO Markets

**A fully-fledged prediction market platform built natively on Arc, with an embedded AI agent that trades markets autonomously on behalf of users.**

Hackathon: Agora Agents Hackathon — RFB 02 (Prediction Market Trader Intelligence)
Builder: Solo, full-time, 14 days
Settlement: USDC on Arc testnet

---

## 1. Vision

Polymarket proved that people want to put money where their mouth is on real-world events. But Polymarket is built on Polygon — high enough gas to deter casual participation, no native AI layer, no yield on idle capital.

YOLO Markets is the same core product — browse events, take a position, get paid when you're right — rebuilt from scratch on Arc. Sub-second finality and ~$0.01 per transaction make it viable to trade $1 positions, run a continuous AI agent loop, and earn yield on idle USDC between bets.

The platform has two modes:

1. **Manual mode** — users browse markets, read the AI's probability estimate, and place their own bets.
2. **Agent mode** — users deposit USDC, set a risk profile, and the AI agent trades on their behalf autonomously around the clock.

The markets themselves are powered by a custom LMSR (Logarithmic Market Scoring Rule) AMM deployed directly on Arc testnet. No third-party venue. No bridges. Everything settles on Arc.

---

## 2. Why this wins

| Dimension | What we have |
|---|---|
| Platform | Full prediction market — not just an agent wrapper on someone else's venue |
| Differentiation | First LMSR prediction market on Arc; agent is a native feature, not a bolt-on |
| Traction surface | Human users + agent users both generate volume; public market pages are SEO-indexable |
| Circle depth | USDC on Arc + Embedded Wallets + Paymaster + USYC yield. 4+ primitives used meaningfully |
| Agentic story | Agent is a first-class product feature, not a demo — judges can watch it trade live |
| Solo-builder fit | Platform UX is full-stack product work; contracts are straightforward LMSR + factory |

---

## 3. Product overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOLO Markets                             │
│                                                                 │
│  ┌───────────────────┐        ┌───────────────────────────────┐ │
│  │   MANUAL MODE     │        │        AGENT MODE             │ │
│  │                   │        │                               │ │
│  │  Browse markets   │        │  Deposit USDC                 │ │
│  │  Read AI estimate │        │  Set risk profile             │ │
│  │  Place own bet    │        │  Agent monitors all markets   │ │
│  │  Track portfolio  │        │  Agent bets when +EV found    │ │
│  │                   │        │  User watches activity feed   │ │
│  └───────────────────┘        └───────────────────────────────┘ │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │               ARC TESTNET INFRASTRUCTURE                    ││
│  │  MarketFactory.sol  ·  PredictionMarket.sol (LMSR)         ││
│  │  USDC settlement  ·  Circle Embedded Wallet  ·  Paymaster  ││
│  │  USYC yield on idle bankroll                               ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. User personas

**The Informed Bettor**
Follows macro events, politics, crypto closely. Already uses Polymarket. Switches to YOLO Markets for the AI probability overlay and zero gas friction. Uses manual mode primarily, occasionally turns on agent for categories they don't follow closely.

**The Passive Yield Seeker**
Wants crypto-native exposure to prediction markets but doesn't have time to research. Deposits USDC, enables agent mode, checks back weekly. USYC yield on idle balance is a strong hook.

**The Curious Newcomer**
Heard about prediction markets on social media. Circle embedded wallet means email signup, no MetaMask. Paymaster means no gas top-ups. First bet is $2 on something they have an opinion on. This user exists because of our onboarding — they won't go to Polymarket.

**Anti-persona:** institutional capital. Not the right vehicle at testnet scale. Roadmap item only.

---

## 5. Core features (MVP)

### 5.1 Market browser (homepage)

- Grid of active markets — question, category tag, current YES price (as % probability), volume, time to close
- Filter by category: Crypto · Macro · Politics · Sports · Tech
- Sort by: Volume · Closing Soon · Newest
- "AI Edge" badge on markets where the agent's estimate diverges from market price by ≥10pts — this is a visible signal that pulls users into individual markets
- Global stats header: Total volume · Active markets · Active traders

### 5.2 Individual market page

- **Question** — prominently displayed
- **Price chart** — YES price over time since market creation (pulled from on-chain event logs)
- **Current prices** — YES: 34¢ · NO: 66¢ (always sum to 100¢ in LMSR)
- **AI estimate panel** — "AI estimates YES probability at 51%. Edge: +17pts." Reasoning excerpt with expandable full analysis and source links
- **Bet interface** — toggle YES / NO, input USDC amount, live preview of shares received and price impact before confirmation
- **Market details** — resolution criteria, deadline, total liquidity, open interest
- **Recent activity feed** — last 20 trades (anonymised address, side, size, timestamp)
- **Share button** — generates a Twitter/X card with the AI's take + current price

### 5.3 Portfolio page (authenticated)

- **Bankroll summary** — USDC available · USYC yield earned · open position value · total PnL
- **Open positions** — market, side (YES/NO), shares held, entry price, current price, unrealised PnL, close button
- **Closed positions** — resolved markets, outcome, realised PnL
- **Agent toggle** — enable / disable agent mode from this page
- **Transaction history** — every `buy()`, `sell()`, and `resolve()` payout with tx hash links

### 5.4 Agent mode (the differentiator)

When a user enables agent mode:

- Agent gains permission to call `buy()` and `sell()` on their behalf (scoped to their deposited balance, never exceeding it)
- User sets **risk profile**: Conservative (¼ Kelly, ≥10pt edge threshold) · Moderate (½ Kelly, ≥7pt) · Aggressive (full Kelly, ≥5pt)
- User sets **category filters** (optional) — e.g. "only Crypto and Macro"
- User sets **max position size** — hard cap per market as % of bankroll

Agent activity is surfaced in real time via:
- **Activity feed** — timestamped log of every decision: *"Bought 142 YES shares on [market] @ 28¢. Estimate: 44%. Reasoning: [excerpt]"*
- **Passes** (skipped markets) are also logged — transparency builds trust
- **Performance card** — agent's PnL, win rate, Brier score, vs. just-holding-USDC

### 5.5 Public feed (traction lever)

- `/live` — all agent bets across all users, public, with reasoning. Shareable. Drives signups.
- `/markets/[slug]` — individual market pages are SEO-indexed. One viral market = hundreds of organic visitors.
- `/leaderboard` — top users by 30-day return (opt-in). Social proof.

### 5.6 Admin panel (internal)

- Create market: question, category, resolution criteria, deadline, initial liquidity
- Resolve market: select outcome → triggers `resolve()` on-chain → payouts distributed
- Market health dashboard: liquidity, volume, price stability

---

## 6. Smart contracts

Deployed on **Arc testnet**. Arc is EVM-compatible. Toolchain: Foundry.

### 6.1 MarketFactory.sol

```solidity
function createMarket(
    string calldata question,
    string calldata category,
    uint256 deadline,
    uint256 initialLiquidity  // USDC (6 decimals)
) external onlyAdmin returns (address market);
```

- Pulls `initialLiquidity` USDC from treasury wallet
- Deploys a new `PredictionMarket` instance, seeded with that USDC
- Registers the market in an internal registry
- Emits `MarketCreated(address market, string question, uint256 deadline)`
- The frontend and agent subscribe to this event to discover new markets

### 6.2 PredictionMarket.sol (LMSR AMM)

**State:**
```solidity
uint256 public b;             // liquidity parameter
uint256 public qYes;          // cumulative YES shares outstanding
uint256 public qNo;           // cumulative NO shares outstanding
IERC20  public usdc;
bool    public resolved;
uint8   public outcome;       // 1 = YES, 2 = NO
```

**Core functions:**
```solidity
// Buy `shares` of `outcome` (1=YES, 2=NO), paying USDC
function buy(uint8 outcome, uint256 shares) external returns (uint256 cost);

// Sell `shares` of `outcome`, receiving USDC
function sell(uint8 outcome, uint256 shares) external returns (uint256 received);

// Resolve market — only callable by admin after deadline
function resolve(uint8 _outcome) external onlyAdmin;

// Claim winnings after resolution
function claim() external;

// View: current price of YES (scaled 1e18 = 100%)
function priceYes() external view returns (uint256);
```

**LMSR mechanics:**

```
Cost function:  C(qYes, qNo) = b · ln( exp(qYes/b) + exp(qNo/b) )

Price of YES:   p = exp(qYes/b) / ( exp(qYes/b) + exp(qNo/b) )

Cost to buy Δ YES shares:
  cost = C(qYes + Δ, qNo) - C(qYes, qNo)

Initial state: qYes = qNo = 0  →  priceYes = 50¢

Maximum AMM loss (worst case): b · ln(2)
→ set b such that max loss ≤ initial liquidity seed
→ b = initialLiquidity / ln(2)  ≈  initialLiquidity × 1.4427
```

**Practical parameters for hackathon:**
- `initialLiquidity = 100 USDC` per market → `b ≈ 144`
- This bounds the treasury's maximum loss to 100 USDC per market regardless of trading volume
- Price impact per $10 bet at 50¢: ~3.5¢ movement — visible but not extreme

**Note on fixed-point math:** LMSR requires `exp()` and `ln()`. Use PRBMath (v4, MIT licensed) or ABDKMath64x64 for fixed-point arithmetic in Solidity. Do not implement from scratch.

**Adapt from, don't write from scratch:**
- Gnosis conditional tokens + LMSR market maker (open source, MIT)
- Augur v1 LMSR (MIT)

### 6.3 Day 0 checks (before writing a line of product code)

- [ ] Arc testnet RPC URL and chain ID confirmed
- [ ] Testnet USDC contract address confirmed
- [ ] Testnet USDC obtained from Arc faucet
- [ ] Foundry `forge create` deploys a hello-world contract successfully
- [ ] PRBMath or ABDKMath64x64 installed as a Foundry dependency
- [ ] `cast call` can read state from a deployed contract

---

## 7. Agent architecture

### 7.1 The signal layer

The agent uses **Polymarket's Gamma API** as its primary signal source — not for execution, but for crowd probability data. Polymarket has the deepest liquidity in prediction markets, making its prices the best available proxy for true market consensus.

For each YOLO Markets market, the agent:
1. Finds the closest matching Polymarket contract (fuzzy title match)
2. Reads Polymarket's current YES price as the "wisdom of crowds" prior
3. Supplements with news, social data, and domain-specific feeds
4. Feeds everything to the LLM for a calibrated estimate

If no Polymarket match exists (novel market), the agent relies solely on news + LLM.

### 7.2 The agent loop

```
every N minutes (N = 5 for markets closing <24h, 30 for others):

  ── DISCOVERY ──
  fetch all active YOLO Markets from MarketFactory event log
  for each market not yet in watchlist: add it, fetch initial context

  ── EVALUATION (per market) ──
  for each market in watchlist:
    1. pull current LMSR price from PredictionMarket.priceYes()
    2. fetch Polymarket crowd price (if matching contract exists)
    3. ingest: recent news headlines, social sentiment, domain data
    4. estimate: LLM → { probability, confidence, reasoning, sources, watch_for }
    5. compute edge: |estimate.probability - lsrPrice|
    6. if edge < risk_profile.threshold OR confidence < MIN_CONFIDENCE: log pass, skip
    7. kelly_fraction = (edge * confidence) / (1 - estimate.probability)
    8. apply risk_profile.kelly_multiplier (0.25 / 0.5 / 1.0)
    9. check portfolio constraints (max per market, max correlated exposure)
    10. execute: call PredictionMarket.buy(outcome, shares) via Circle wallet
    11. log: full decision record to DB → surfaces in user activity feed

  ── POSITION MANAGEMENT (per open position) ──
  for each open position:
    12. re-run estimate with fresh context
    13. if estimate has flipped OR edge has closed to <3pts: sell
    14. if new information in watch_for list has materialised: re-evaluate urgently

  ── RESOLUTION MONITORING ──
  for each market past deadline:
    15. fetch real-world outcome (news API / admin confirmation)
    16. call PredictionMarket.resolve(outcome) via admin wallet
    17. log resolution + notify affected users
```

Two clocks: fast (5 min) for markets expiring within 24h, slow (30 min) for everything else. On Arc (~$0.01/tx), this is economical. Pre-Arc, this loop would cost $5–50/day in gas alone.

### 7.3 LLM prompt structure

```
SYSTEM:
  You are a calibrated probability estimator for prediction markets.
  Output structured JSON only. Never anchor to the market price.
  Reason from first principles. When uncertain, say so in confidence score.

USER:
  MARKET: "{question}"
  RESOLUTION CRITERIA: {criteria}
  RESOLVES: {deadline}

  CROWD SIGNALS:
    Polymarket price (if available): {polymarket_yes_price}%
    Current YOLO Markets price: {lmsr_yes_price}%

  CONTEXT:
    Recent news (last 48h): {news_items}
    Social sentiment: {sentiment_summary}
    Relevant historical base rates: {base_rates}
    Prior similar events: {similar_resolved_markets}

  OUTPUT FORMAT (strict JSON):
  {
    "probability": 0.0–1.0,
    "confidence": 0.0–1.0,
    "reasoning": "3–5 sentences shown to user",
    "key_sources": ["url1", "url2"],
    "watch_for": ["signal 1 that would change this estimate", "signal 2"],
    "time_sensitivity": "low|medium|high"
  }
```

The `watch_for` field is the intelligence backbone of re-evaluation — the agent knows *what specifically* to look for on the next loop, not just "run the prompt again."

### 7.4 What makes this genuinely agentic

Judges score 30% on agentic sophistication. These are the behaviours that qualify — all must be demonstrable in the demo:

| Behaviour | Implementation | Visible to user? |
|---|---|---|
| Self-initiated loop | Cron + Redis queue, no user trigger | Via activity feed timestamps |
| Autonomous execution | Agent calls `buy()`/`sell()` without user approval | Activity feed shows tx hash |
| Position management | Agent sells / holds based on updated estimates | Activity feed: "Exited YES position on [market] — estimate moved to 38%, edge closed" |
| Watchlist evolution | Agent auto-adds new markets from factory events | Activity feed: "Added new market: [question]" |
| Memory / calibration | Per-category confidence multiplier updated from resolved market history | Agent settings: "AI has adjusted confidence for Political markets: -8% based on 12 resolutions" |
| Tool use | LLM can call search, fetch URLs, query resolution history as tools | Shown in reasoning sources |
| Resolution trigger | Agent detects deadline + outcome → calls `resolve()` | Activity feed: "Resolved [market] as YES. Payouts distributed." |

---

## 8. Circle / Arc integration

| Primitive | How it's used | Where in the product |
|---|---|---|
| **USDC on Arc** | Collateral token inside every `PredictionMarket.sol`. All bets, payouts, and yield in USDC. | Everywhere |
| **Embedded Wallets** | Email-based signup — no seed phrase, no MetaMask required. | Onboarding |
| **Paymaster** | Every `buy()`, `sell()`, `claim()` is gasless. User never sees a gas prompt. | All contract interactions |
| **USYC** | Idle bankroll (USDC not in open positions) is held in USYC for yield. Auto-redeemed before each bet. | Portfolio page: "Earned $X.XX in yield" |
| **CCTP** | Optional: user has USDC on Ethereum/Base → bridge to Arc to fund account. Not in execution path. | Deposit flow (optional tab) |
| **Nanopayments** | Stretch: charge $0.001 per "Premium AI Pick" on the public feed. Shows Arc's micro-fee economics. | Public feed (week 2) |

**USYC integration detail:**
- On deposit: USDC → USYC (user earns yield immediately)
- On bet: redeem exactly `cost` USYC back to USDC → call `buy()` in one atomic flow
- On portfolio page: display accrued yield separately from trading PnL
- Talking point for judges: "Even users who lose money on bets may come out ahead on yield"

---

## 9. Data model

```
User
  id, email, wallet_address, risk_profile (conservative|moderate|aggressive)
  agent_enabled (bool), category_filters (jsonb), max_position_pct (int)
  created_at

Market
  id, contract_address, question, category, resolution_criteria
  deadline, status (active|resolved|cancelled), outcome (null|yes|no)
  initial_liquidity, polymarket_slug (nullable, for signal matching)
  created_at, resolved_at

Position
  id, user_id, market_id, outcome (yes|no)
  shares, avg_entry_price, cost_basis_usdc
  status (open|closed), realised_pnl (null until closed)
  opened_at, closed_at

AgentDecision
  id, user_id (null for system-level decisions), market_id
  lmsr_price_at_decision, polymarket_price_at_decision
  estimate_probability, confidence, reasoning, key_sources (jsonb)
  watch_for (jsonb), action (buy|sell|pass|resolve)
  shares, usdc_amount, tx_hash (null if pass)
  created_at

Transaction
  id, user_id, market_id (nullable), type (deposit|withdraw|buy|sell|claim|yield)
  usdc_amount, shares (nullable), price_per_share (nullable)
  tx_hash, created_at

YieldAccrual
  id, user_id, usyc_amount, usdc_equivalent, accrued_at
```

---

## 10. User flows

### Onboarding (new user, 60 seconds)
```
Land on homepage
  → "Get Started" CTA
  → Enter email → Circle creates embedded wallet silently
  → Deposit USDC screen: copy wallet address OR CCTP bridge from another chain
  → Deposit confirmed → USDC auto-converted to USYC (earning yield immediately)
  → Redirected to market browser with bankroll shown in header
```

### Place a manual bet
```
Market browser → click a market
  → Read question, AI estimate, current price
  → Select YES or NO
  → Enter USDC amount
  → Preview: "You will receive ~142 YES shares. Price impact: 1.2¢. New price: 35¢."
  → Confirm → Paymaster sponsors gas → PredictionMarket.buy() called
  → Success toast: "Bought 142 YES shares @ 34¢"
  → Portfolio updates in real time
```

### Enable agent mode
```
Portfolio page → "Enable Agent" toggle
  → Risk profile modal: Conservative / Moderate / Aggressive
  → Category filters (optional): toggle on/off
  → Max per-market cap: default 10%, adjustable
  → Confirm → agent begins monitoring
  → Activity feed populates as agent evaluates markets
  → User can disable at any time → agent closes or holds positions (user chooses)
```

### Market resolution
```
[Admin] Deadline passes → agent backend detects expired market
  → Admin confirms real-world outcome via admin panel
  → Backend calls PredictionMarket.resolve(outcome)
  → Contract distributes USDC to winning token holders
  → Users with winning positions see "Claim $X.XX" button on portfolio
  → Claim → Paymaster sponsors gas → USDC credited to wallet
```

---

## 11. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| **Smart contracts** | Foundry + Solidity ^0.8.20 + OpenZeppelin + PRBMath | Fastest dev loop; PRBMath for LMSR fixed-point arithmetic |
| **Frontend** | Next.js 15 (App Router) + Tailwind + shadcn/ui | Vercel deploy in seconds; shadcn gives polished components fast |
| **Web3 client** | viem + wagmi | Best-in-class Arc/EVM interaction; wagmi handles wallet state |
| **Agent backend** | Python (FastAPI) | Ergonomic for LLM calls, numeric Kelly math, async loops |
| **API gateway** | Node.js (Express) | Thin layer between frontend and agent backend |
| **Database** | Postgres + pgvector (Supabase) | Auth + DB in one; pgvector for article embedding dedup |
| **Job queue** | Redis (Upstash) + RQ (Python) | Simple cron + task queue, one worker process |
| **LLM** | Claude Sonnet 4.6 via Anthropic SDK | Calibrated outputs, tool use, prompt caching on news context |
| **News ingestion** | NewsAPI + GDELT | Broad coverage; GDELT for geopolitical events |
| **Hosting** | Vercel (frontend) + Railway (agent + API) | Zero-ops for solo builder |
| **Analytics** | PostHog | Self-hostable; tracks traction metrics judges will ask for |
| **Error tracking** | Sentry | One-line setup |

---

## 12. Judging criteria mapping

| Criterion | Weight | How YOLO Markets scores |
|---|---|---|
| **Agentic sophistication** | 30% | 7 distinct agentic behaviours (see §7.4), all visible in the live activity feed during the demo. Agent resolves markets, manages positions, evolves its watchlist, and calibrates itself from history — not just "place a bet." |
| **Traction** | 30% | Two user types (manual + agent) generate volume independently. Public market pages are SEO-indexed. Twitter auto-poster on notable agent bets. Leaderboard creates competition. Target: 200+ users, 1000+ bets by demo day. |
| **Circle tool usage** | 20% | 4 primitives used meaningfully: USDC on Arc (settlement), Embedded Wallets (onboarding), Paymaster (gasless UX), USYC (yield on idle). CCTP + Nanopayments as stretch. |
| **Innovation** | 20% | First LMSR prediction market on Arc. Agent is a first-class platform feature, not an add-on. USYC yield on idle bankroll is novel. Public reasoning feed with cited sources is novel. |

---

## 13. Traction strategy

The 30% traction weight is winnable for a solo product builder because it rewards *shipping to real users*, not technical depth.

**Week 1 — build the surface area:**
1. **Public market pages** (`/markets/[slug]`) — SEO-indexed, even non-users find them from search on hot topics
2. **AI Edge badge** — visible on the homepage, creates curiosity ("why does the AI disagree with the crowd on this?")
3. **Share button** on each market — generates a pre-written tweet with the AI's take + price

**Week 2 — drive users:**
4. **Twitter/X auto-poster** — when agent enters a notable position, auto-posts: *"Taking YES on [market] @ 28¢. AI estimate: 44%. Edge: +16pts. Reasoning: [excerpt] [link]"*
5. **Founder-led threads** — daily posts on X about the agent's biggest win/loss with full reasoning
6. **Leaderboard** — opt-in, competitive, shareable
7. **Discord presence** — Canteen + Arc Discord. Post the agent's daily performance card
8. **Referral USDC** — first 50 referrals get $1 testnet USDC to bet with

**Traction metrics to report at submission:**
- Total signups
- Total bets placed (manual + agent combined)
- Total markets active
- Agent decisions made (including passes — shows it's working)
- Weekly active users
- (Testnet volume in USDC as a secondary metric)

---

## 14. 14-day build plan

### Week 1 — foundation

| Day | Goal | End-of-day checkpoint |
|---|---|---|
| **1** | Arc testnet setup. Deploy hello-world contract. Polymarket API connected. Manual LLM estimate in console. | `cast call` reads state from Arc testnet contract. LLM outputs JSON estimate for one market. |
| **2** | `PredictionMarket.sol` (LMSR) written + Foundry unit tests. Deploy to Arc testnet. Manual `buy()` via `cast`. | USDC flows in and out of contract correctly. Price updates after buy. Tests pass. |
| **3** | `MarketFactory.sol` deployed. Seed 5 real markets. Circle embedded wallet integrated. | Email signup → wallet created → testnet USDC deposited → `buy()` called on-chain. End-to-end works. |
| **4** | Frontend: homepage market browser + individual market page with bet UI. | User can browse, select a market, place a bet, see tx confirmation. No styling required — function first. |
| **5** | Portfolio page. Real-time position updates. USYC integration for idle balance. | Full user flow works: signup → deposit → browse → bet → portfolio shows position + yield. **Hard deadline.** |
| **6** | Agent loop: Polymarket signal ingestion + LLM estimate + Kelly sizing. Paper-trade mode (no real execution). | Agent prints decision log every 5 min. Reasoning is coherent. Kelly fractions are sensible. |
| **7** | Agent loop: live execution. Agent calls `buy()` / `sell()` on behalf of an enabled user. Activity feed in UI. | Agent places a real on-chain bet. Activity feed updates in real time. User can enable/disable agent. |

### Week 2 — depth + traction

| Day | Goal | End-of-day checkpoint |
|---|---|---|
| **8** | Market resolution flow. Admin panel (create + resolve). `resolve()` + `claim()` tested end-to-end. | A market resolves. Winning users see "Claim" button. Claiming works. Paymaster sponsors claim gas. |
| **9** | Agentic depth: memory/calibration loop, watchlist evolution, `watch_for` re-evaluation on news triggers. | Agent demonstrates ≥5 of the 7 agentic behaviours in the activity feed. |
| **10** | Public pages: `/live` feed, `/leaderboard`, SEO market slugs. Twitter auto-poster live. | Public feed shows agent bets. Leaderboard renders. Share button generates tweet. |
| **11** | Polish: loading states, error handling, mobile responsiveness, empty states, Paymaster on all flows. | A non-technical friend can sign up and place a bet without asking for help. |
| **12** | Traction sprint: posts on X, Discord, referral bonus live. Monitor drop-off and fix blocking issues. | 50+ signups, 200+ bets from real external users. |
| **13** | Demo video (≤3 min). Submission write-up. Traction report with charts from PostHog. | Video recorded. All assets ready. |
| **14** | Submit. Final social push. | Submitted. |

**Hard rules:**
- End-to-end working product by end of day 5. Nothing slips past this.
- If day 3 contracts are delayed, cut USYC — add it only if ahead of schedule.
- Day 13 is for the demo, not new features.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Arc testnet RPC or USDC faucet is broken | Verify on day 1 before anything else. If broken, escalate in Arc/Circle Discord immediately — this blocks everything. |
| LMSR fixed-point math overflows or loses precision in Solidity | Use PRBMath (audited, MIT). Write unit tests covering extreme inputs (all YES, all NO, 99¢ price). Do not implement `exp()`/`ln()` manually. |
| `PredictionMarket.sol` has a bug that allows double-claim or incorrect payout | Foundry fuzz tests on `claim()`. Test that `sum of all payouts == initial liquidity + total buy cost`. |
| Agent's own large bets move LMSR price against itself | Cap per-bet size at 5% of pool depth. Use fractional Kelly. Compute price impact before placing. |
| LLM probability estimates are systematically biased | Start in paper-trade mode (days 6–7). Enable live execution only after verifying estimates are directionally correct on at least 10 Polymarket markets with known outcomes. Track Brier score continuously. |
| Polymarket Gamma API rate limits | Cache aggressively: prices at 60s TTL, market metadata at 5min TTL. It's read-only HTTP — very permissive in practice. |
| Markets have no counterparty and agent is the only trader | This is fine — the LMSR AMM itself is the counterparty. The agent trades against the AMM, not against other users. Human users provide additional volume but aren't required. |
| Manual market resolution is slow / missed | Cron job alerts you when any market's deadline passes. Admin panel has a "Pending Resolution" queue with one-click resolve. |
| Users confused that this is testnet USDC | Large banner on every page: "YOLO Markets is running on Arc testnet. Balances are not real money." Bright colour. Cannot miss it. |
| Smart contract not audited — could be a judge concern | Acknowledge in submission: "Not production-ready. Contracts are tested but not audited." Judges know this is a hackathon. |
| Scope creep kills week 2 | Day 5 hard deadline. Anything not done by day 5 is cut or deferred to week 2 polish. |

---

## 16. What we're not building

- Mobile app (responsive PWA covers mobile)
- CLOB / order book (LMSR AMM is the mechanism)
- Decentralised oracle (admin resolves manually; UMA/Chainlink is a post-hackathon upgrade)
- User-created markets (admin-only for MVP — prevents spam and ensures quality resolution criteria)
- Multi-currency (USDC only; EURC is a roadmap item)
- Social features (comments, follows)
- Token or governance
- Leveraged positions

---

## 17. Demo video script (3 min)

*Goal: show a judge that the platform is real, the agent is autonomous, and Arc makes it possible.*

| Time | What's on screen | What you say |
|---|---|---|
| 0:00–0:15 | Live dashboard — positions open, agent activity feed ticking | "YOLO Markets is a live prediction market on Arc testnet. The AI agent placed 63 bets in the last 24 hours. I haven't touched it." |
| 0:15–0:45 | Market browser → click a market → show AI estimate panel | "Users can browse markets. Every market shows the AI's independent probability estimate alongside the crowd price. Right now the AI thinks [market] is mispriced by 19 points." |
| 0:45–1:15 | Manual bet flow — select YES, input amount, confirm, position appears | "Manual users place their own bets. Gasless — no MetaMask, no gas prompts. Settled in USDC on Arc in under a second." |
| 1:15–1:45 | Enable agent mode → activity feed shows autonomous bets with reasoning | "Agent mode hands control to the AI. It monitors all markets, runs news synthesis, sizes with Kelly Criterion, and executes on-chain — continuously, autonomously." |
| 1:45–2:10 | Portfolio page — USYC yield line item | "Idle USDC earns yield in USYC while waiting for the next +EV bet. Even a losing trader comes out closer to flat." |
| 2:10–2:35 | Public feed + leaderboard | "The agent's reasoning is public. [X] users signed up in the last 48 hours from a single tweet." |
| 2:35–3:00 | Close on Arc stats: tx count, fee, finality time | "Every bet costs one cent. Settles in under a second. This platform couldn't exist on any other chain. YOLO Markets." |

---

## 18. Definition of done

### Must have (submission blockers)
- [ ] Live URL accessible, working on Arc testnet
- [ ] Email signup → embedded wallet → deposit → place bet → see position (full flow, no errors)
- [ ] Agent mode: enable → watch it place a real on-chain bet → see reasoning in activity feed
- [ ] At least 5 active markets with clear resolution criteria
- [ ] USYC yield visible on portfolio page
- [ ] Paymaster: zero gas prompts on any user action
- [ ] Market resolution + claim flow working end-to-end
- [ ] Public GitHub repo, MIT licensed, README with setup instructions
- [ ] ≤3 min demo video
- [ ] Traction report: signups, bet count, agent decisions, weekly actives (PostHog)

### Target metrics at submission
- ≥150 signups
- ≥750 bets placed (manual + agent)
- ≥5 markets created
- ≥1 market resolved with payouts claimed
- ≥4 Circle primitives demonstrably in use

### Stretch (nice to have)
- [ ] Twitter auto-poster live
- [ ] Nanopayments for premium picks
- [ ] CCTP deposit flow from Ethereum/Base
- [ ] Price history chart on market pages
