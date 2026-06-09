# YOLO Markets — Required Work

**Status:** Day 5 of 14. Today is 2026-05-25. Submission target ~2026-06-03.
**Hackathon:** [Agora Agents Hackathon](https://agora.thecanteenapp.com/) — Canteen × Circle on Arc.
**Targeted RFBs:** RFB 02 (Prediction Market Trader Intelligence) + RFB 03 (Prediction Market Verticals).
**Prize pool:** $50K. Grand prizes 1–3 = $40K. Realistic target: top-3 or standout.

This file is the load-bearing punch-list. Anything not in here is noise until submission.

---

## 1. Judging math — what we're actually optimizing

| Weight | Criterion | Current self-score | Target | Gap |
|---|---|---|---|---|
| 30% | Agentic sophistication | ~5/30 | 25/30 | **Build the brain** |
| 30% | Traction (real users, txs, volume) | ~2/30 | 18/30 | **Distribution + seeded markets** |
| 20% | Circle tool usage (Wallets, CCTP, Gateway, App Kit, Gas Station) | ~5/20 | 16/20 | **Add Circle Wallets onboarding + Gas Station** |
| 20% | Innovation | ~10/20 | 14/20 | **Lean on session-key AgentAccount + LMSR-on-Arc + multi-vertical** |

Every section below maps back to one of these four buckets. If a piece of work doesn't move one of these numbers, cut it.

---

## 2. The agent brain — 30% (priority 1)

**Problem:** Today `agent/loop.py` calls `AgentAccount.execute(buy(...))` on a schedule. That is automation, not agentic. RFB 02 explicitly names *news/sentiment synthesis*, *Kelly Criterion sizing*, *mispricing detection*, *correlated-market portfolio construction*. None of that exists.

### 2.1 Required: real reasoning loop

- [ ] Wire Claude (Sonnet 4.6 default; Opus 4.7 for hard calls) via the Anthropic SDK in `agent/`.
- [ ] Tool-use loop with these tools, all invokable by Claude:
  - `fetch_news(query, hours)` — news headlines via a low-cost API (Tavily / Perplexity / Brave / NewsAPI). Pick one and stop deliberating.
  - `fetch_market_state(market_addr)` — on-chain current odds, liquidity, recent trades.
  - `fetch_external_odds(question)` — Polymarket via `curl_cffi` (see CLAUDE.md for the TLS workaround), Kalshi if free.
  - `compute_kelly(prob, odds, bankroll, fraction=0.25)` — fractional Kelly, capped.
  - `propose_trade(market, side, max_cost, reasoning)` — emits a structured decision; the runner executes it via `AgentAccount.execute`.
- [ ] Each decision row in `agent_decisions` must store: `prompt_hash`, `model`, `tools_called`, `reasoning` (full text), `confidence`, `kelly_fraction`, `external_odds_snapshot`. Judges will read this table.
- [ ] Prompt caching on every Claude call. Cache the static system prompt and per-market context separately. (See `claude-api` skill.)

### 2.2 Required: portfolio-level reasoning

- [ ] Before each trade, the agent must see its current portfolio across all markets and reject the trade if it concentrates risk (>30% of bankroll in one market, or two highly correlated markets).
- [ ] Daily rebalance pass: agent reviews open positions, closes the ones whose thesis has changed.

### 2.3 Required: observability

- [ ] `/agent?u=<addr>` page must show, per decision: reasoning text, news headlines consumed, Polymarket comparison, Kelly math, outcome. This is the demo's centerpiece.
- [ ] Add a `replay` button that re-runs a past decision with current data so judges can poke at it live.

**Cut:** anything fancier — no fine-tuning, no RL, no custom embeddings. Tool use + good prompts is the bar.

---

## 3. Circle tool usage — 20% (priority 2)

**Problem:** CLAUDE.md admits we skipped Circle Modular Wallets and rolled our own AgentAccount. We use USDC ERC-20 and nothing else. This is a near-zero score on a 20% criterion. Unacceptable.

### 3.1 Required: Circle User-Controlled Wallets for onboarding

- [ ] Decision lock: **User-Controlled Wallets**, not Modular. Faster to ship, email/OTP works without passkey UX work.
- [ ] Email-or-social signup in `web/` → Circle creates SCA wallet on Arc → wallet address stored in `users` table.
- [ ] First-time funding flow: Circle hosted funding screen for USDC, or a "fund from faucet" button that pings a backend that drips 10 USDC from the deployer EOA.
- [ ] AgentAccount deployment: when user enables agent mode, factory deploys an AgentAccount whose `owner` is the Circle SCA wallet. The Circle wallet signs the deposit + the session-key authorization.

### 3.2 Required: Circle Gas Station

- [ ] Configure Gas Station in Circle Console for the project.
- [ ] All user-facing transactions (deposit, enable agent, manual bet) go through Gas Station so the user never holds gas USDC.
- [ ] Demo script must show a brand-new wallet placing a bet with zero pre-funded gas.

### 3.3 Required: meaningful USDC story

- [ ] Show 6-vs-18 decimal handling in code comments where it matters — judges will grep for it.
- [ ] Document Arc CCTP domain (26) and call out *why* we don't use CCTP (single-chain product) so we're not penalized for not using it; flag a "multi-chain rollout" line in the roadmap.

### 3.4 Optional but cheap wins

- [ ] EURC-denominated market (one) to demonstrate multi-currency settlement — directly listed in RFB 03.
- [ ] USYC mock yield panel stays, clearly labeled "Pending institutional allowlist." Do not remove — it answers a judge question before they ask it.

**Cut:** Modular Wallets / passkeys. Pick one wallet product and ship.

---

## 4. Traction — 30% (priority 3)

**Problem:** One demo market, zero users. RFB 03 says "verticals" plural. RFB 02 traction metrics list active users, accuracy rate, volume wagered.

### 4.1 Required: seed real markets across categories

Minimum 8 markets live at submission, across at least 4 categories:

- [ ] **Crypto** — BTC > X by date, ETH > Y by date. (Already have ETH.)
- [ ] **Macro** — next CPI print > consensus; next FOMC decision (cut/hold/hike).
- [ ] **Geopolitical** — one election or treaty outcome with a clear resolution date pre-submission.
- [ ] **Sports** — one weekend game where resolution lands before judging.
- [ ] **Tech** — one product launch / earnings beat market.

Resolution must be automatable or admin-resolvable with a public source. Document the source in market metadata.

### 4.2 Required: distribution push

- [ ] Twitter/X thread on launch day with live link + a screen recording of the agent trading.
- [ ] Post in Arc Discord / Canteen builder channel — sponsor judges hang there.
- [ ] Farcaster cast with a frame that lets users place a bet without leaving the feed (stretch — only if frame tooling is trivial).
- [ ] DM 20 crypto-Twitter friends-of-friends with a "would you bet $5 on X?" pitch. Goal: 25 wallets, 100 trades, $500 volume.

### 4.3 Required: traction report at submission

A `traction.md` in the repo with:
- Wallets created
- Markets live + total liquidity
- Trades executed (human + agent split)
- Total USDC volume
- Agent decision accuracy on resolved markets

Numbers, not adjectives.

---

## 5. Innovation — 20% (priority 4)

Already partly there. Codify it so judges see it:

- [ ] Write `INNOVATION.md` (max 1 page) that names the three novel pieces:
  1. **Session-key AgentAccount with cap-metered `execute()`** decoding `buy(maxCost)` and auto-approving USDC for exactly the worst-case spend. This is genuinely uncommon; lead with it.
  2. **LMSR AMM native to Arc** — first on-chain LMSR on this L1, sub-cent transaction cost makes $1 bets viable.
  3. **Agent reasoning is on-chain-adjacent and replayable** — every trade has a stored prompt + tool trace, auditable post-hoc.
- [ ] Link `INNOVATION.md` from the README so reviewers don't miss it.

**Do not** invent new "innovations" to pad this. Three real ones beats six handwavy ones.

---

## 6. Product polish (no judging weight, but kills you if broken)

### 6.1 Web app must-haves

- [ ] Landing page that explains the product in 10 seconds. Hero: live market grid + "Watch the agent trade →" CTA.
- [ ] Market page: order book / LMSR curve, current probability, AI's probability, recent trades, "Place bet" panel.
- [ ] Portfolio page: open positions, PnL, agent activity feed, mocked USYC yield panel.
- [ ] Agent page: per-user decision feed with reasoning expandable.
- [ ] Mobile-responsive at a minimum. Most judges will open it on a phone first.

### 6.2 Reliability

- [ ] Agent runner deployed somewhere always-on (Railway/Fly/Render). It must be live during the judging window.
- [ ] Postgres backed up nightly to a dump in the repo or to S3-equivalent. If the DB dies during judging, we're done.
- [ ] Health endpoint that returns last successful agent loop timestamp. Surface it in the footer.

### 6.3 Documentation

- [ ] README rewrite (top-of-funnel): one-paragraph pitch, screenshot/GIF, links to live app + video + demo wallet.
- [ ] Architecture diagram (one PNG, no fancy tools — Excalidraw is fine).
- [ ] `DEMO.md` with judge-friendly steps: "Sign up with email → fund with faucet → enable agent → watch it trade → place a manual bet → resolve a test market."

---

## 7. Submission deliverables (hard requirements)

From the hackathon page:

- [ ] **Public GitHub repository** — make `master` clean, remove `.env`, sanity-check for committed keys.
- [ ] **Video demo, max 3 minutes** — script in section 8.
- [ ] **Live product link** — custom domain on Vercel (e.g., `yolomarkets.xyz`); HTTPS; uptime through judging.
- [ ] **Written traction report** — `traction.md`.
- [ ] **Feedback survey** ($500 incentive) — fill it in. Free money.

---

## 8. The 3-minute video — script outline

Judges watch this at 1.5×. Every second matters.

| Time | Beat |
|---|---|
| 0:00–0:15 | Hook: "$1 bets, AI agents, real settlement — on Arc." Show the live market grid. |
| 0:15–0:45 | Manual flow: sign up with email (Circle Wallets), place a $1 bet on BTC market, transaction confirmed in <1s with zero gas in hand (Gas Station). |
| 0:45–1:45 | Agent flow: enable agent on a fresh wallet, show the reasoning panel as it picks a market, executes a trade. Expand the decision card to show news headlines consumed, Kelly math, external odds comparison. |
| 1:45–2:20 | Verticals tour: scroll through 8 markets across 5 categories. Pause on EURC-denominated market. Pause on USYC yield panel (with "pending allowlist" label). |
| 2:20–2:50 | Numbers: wallets, volume, agent accuracy. Architecture diagram. Three innovation bullets on screen. |
| 2:50–3:00 | "Try it now → yolomarkets.xyz". Done. |

Record on the 2nd-to-last day. Re-record once.

---

## 9. Timeline — 9 days to submission

Today: **2026-05-25 (Day 5)**. Submission target: **2026-06-03 (Day 14)**.

| Day | Date | Focus | Definition of done |
|---|---|---|---|
| 5 | 05-25 | Lock decisions: User-Controlled Wallets, news API choice, Gas Station setup started | Decisions in this file; Circle Console project created |
| 6 | 05-26 | Agent brain v1: Claude tool-use loop, fetch_news + fetch_market_state + propose_trade | Agent makes one real reasoned trade end-to-end on testnet |
| 7 | 05-27 | Circle Wallets integration in web; Gas Station wired | New user can sign up with email and place a gasless bet |
| 8 | 05-28 | Seed markets — 8 markets across 5 categories live; EURC market deployed | All markets visible on the home page |
| 9 | 05-29 | Kelly sizing + portfolio risk gate; agent decision page with reasoning + replay | Decision feed shows full reasoning trace; replay button works |
| 10 | 05-30 | Polish: market page, portfolio page, mobile pass; deploy agent runner to always-on host | App is demoable to a stranger without explanation |
| 11 | 05-31 | Distribution push: Twitter thread, Arc Discord post, friend DMs | Target metrics: 10 wallets, 30 trades, $200 volume |
| 12 | 06-01 | More distribution; bug-bash; resolve a market on schedule to validate the end-to-end flow | One market resolved with payouts |
| 13 | 06-02 | Record demo video; write traction.md, INNOVATION.md, DEMO.md; README rewrite | All submission artifacts drafted |
| 14 | 06-03 | Final pass, re-record video if needed, submit | Submitted with hours to spare, not minutes |

If a day slips, the **first thing cut is polish**, not the agent brain or Circle integration.

---

## 10. Explicit cuts (don't reopen these)

- ❌ Circle Paymaster — not supported on Arc. (See CLAUDE.md.)
- ❌ USYC live integration — institution-gated. Mock panel only.
- ❌ Modular Wallets / passkeys — User-Controlled is the choice.
- ❌ CCTP / multi-chain — single chain by design; mention in roadmap, don't build.
- ❌ Custom indexer / subgraph — query chain directly + Postgres cache is fine at this scale.
- ❌ Redis / BullMQ — in-memory scheduler in `loop.py --watch` is enough.
- ❌ Fine-tuning, RL, custom embeddings — tool use + Sonnet 4.6 wins this round.
- ❌ Native mobile app — responsive web only.

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent makes obviously dumb trades during judging | Medium | High | Risk gates: max 1 trade/hour per user, max $5 per trade in demo profiles |
| Arc testnet goes down mid-judging | Low | Critical | Daily DB backups; post a status note in README; nothing else we can do |
| News API ratelimits / fails | Medium | Medium | Cache aggressively; fall back to a static "market context" string |
| Circle Wallets integration takes 2x longer than planned | Medium | High | Day 7 is the buffer day; if not done by EOD Day 8, fall back to EOA + faucet flow but keep Gas Station |
| Demo wallet runs out of gas USDC | Low | High | Fund session key with 5 USDC on Day 5; alert if balance < 1 USDC |
| Video re-record eats Day 14 | Medium | Medium | Record Day 13 evening; Day 14 is only for retakes + submit |

---

## 12. Daily standup with myself

Each morning, in this order:
1. Read this file top to bottom.
2. Check yesterday's checklist — anything not done becomes today's first task.
3. Pick 3 things from today's row in section 9. No more.
4. End of day: tick boxes, update CLAUDE.md memory entries, push.

If a task isn't in this file, ask: does it move one of the four judging numbers? If no, don't do it.
