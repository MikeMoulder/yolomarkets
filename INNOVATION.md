# YOLO Markets: what is actually unusual here

Five things in this codebase are uncommon in the prediction market landscape.
Each is a real engineering decision rather than a slogan, and each can be
checked from the linked code in about thirty seconds.

---

## 1. The agent pays its own way, in both directions

**Where:** [web/scripts/nanopay-service.ts](web/scripts/nanopay-service.ts) ·
[agent/nanopay.py](agent/nanopay.py) ·
[web/lib/circle-signer.ts](web/lib/circle-signer.ts) ·
[web/app/api/x402/insight/route.ts](web/app/api/x402/insight/route.ts)

Most agentic demos show an agent *holding* a wallet. Ours transacts with real
counterparties in both directions, in sub cent amounts, on Arc.

**It buys.** The free Arc endpoints rate limit `eth_call`, the single request
every market read depends on, and that had been a recurring source of outages
here. The agent now buys premium access through Circle Nanopayments at $0.0001
per call, gasless and batched through Circle Gateway. Four consecutive calls
succeed on the paid path where the free tier fails after the first. A full
discovery pass over 6,654 markets cost 582 paid calls, or $0.0582.

The point worth pausing on is that this is not a token gesture. The agent buys
the thing it was genuinely short of, and paid access sits *last* in the fallback
order precisely because it is a remedy rather than a habit.

**It sells.** `/api/x402/insight` is a priced endpoint where another agent pays
$0.0001 to read our agent's current view of a market: probability, confidence,
edge and reasoning, joined to the live on chain price. Verified with real
settlement, money leaving the payer's Gateway balance and arriving at the
treasury.

It deliberately does not proxy a language model call. Selling inference would
make every sale cost us a model call, would not be differentiated, and would
leave the endpoint only as available as our AI provider. We sell the estimate
the agent has already formed, which costs nothing to serve and stays up when the
model provider does not.

**Each user's agent pays from its own wallet, and we never hold its key.**
Nanopayments settle as an EIP-3009 signature, which Circle's smart contract
wallets cannot produce. Rather than migrate the trading wallets, which hold open
positions that only they can claim, each user has a second wallet used purely
for paying, and [circle-signer.ts](web/lib/circle-signer.ts) delegates the
signature to Circle's MPC. The key never leaves Circle.

## 2. Short crypto rounds are priced, not forecast

**Where:** [agent/fast_signal.py](agent/fast_signal.py)

A market asking whether Bitcoin will be higher in fifteen minutes is not a
research problem, and our agent said so. Every estimate it produced on these
came back at probability 0.50 and confidence 0.10, which is the honest answer to
an unforecastable question. It also meant the agent never traded a single one of
them.

The usual fix would be to lower the confidence threshold until trades appear.
That produces random betting wearing the costume of conviction, so we did the
opposite and gave the agent the information it was missing.

Everything needed is observable. The starting price is recorded in the market's
own metadata, the current price is a public API call, and the time remaining is
arithmetic. With a move of `m`, `t` seconds left and per second volatility `σ`
measured from recent one minute candles, the probability the price is still
above its start at the deadline is `Φ(m / (σ√t))`.

The behaviour that follows is the useful part. Early in a window a small move is
noise and the model returns roughly 0.50, so the risk gate refuses. Late in a
window a move that is large relative to the remaining volatility is decisive,
and the agent takes the bet. That is a genuine expiry and momentum strategy
rather than a coin flip with extra steps.

Two consequences worth noting. Volatility is measured rather than assumed, so a
quiet market and a violent one are priced differently. And because no model call
is involved, this path keeps trading when an AI provider is unavailable, which
is not a hypothetical: it is how the agent kept working through an outage.

## 3. The risk gate is a tool the model can query but never widen

**Where:** [agent/policy.py](agent/policy.py) ·
`check_trade` in [agent/tools.py](agent/tools.py)

The usual pattern is to describe risk limits in the prompt and hope. Prompts are
advisory. Ours is not.

Position sizing, edge thresholds, bankroll caps and portfolio concentration live
in deterministic Python. That same logic is exposed to the model as a tool it
can call, so it can ask whether a trade would pass and plan around a real
answer, but the tool only ever returns a verdict. The model cannot raise a
limit, and a trade that fails the gate is never executed however convinced the
model sounds.

Spending works the same way. The nanopayment service enforces a per payment cap
and a rolling 24 hour cap, checked in the request handler and again in the
payment SDK's pre signature hook, so an over cap payment cannot even be signed.
Those ledgers are kept per payer, so one busy agent cannot exhaust another's
allowance. A caller may lower its own ceiling; nothing can raise it.

## 4. Reasoning is replayable and stored next to the trade

**Where:** [agent/brain.py](agent/brain.py) ·
[agent/agent_core.py](agent/agent_core.py) ·
`agent_decisions` in [web/lib/db/schema.ts](web/lib/db/schema.ts) ·
rendered at [/agent](web/app/agent/page.tsx)

Most agentic projects ship a black box: it trades, you see the trade. We
instrument the reasoning layer instead.

Each estimate fans out into explicit tool calls, recorded with inputs, outputs
and elapsed time. The trace persists alongside the decision row in Postgres
rather than in a log file, and the `/agent` page renders it inline, expandable
per decision.

Refusals are recorded too, and of 4,015 decisions the overwhelming majority are
refusals with a stated reason. That is the honest shape of a disciplined trader,
and far more legible than a feed containing only winners. The agent also keeps a
first person journal and a set of per market theses that survive across runs, so
its view of a market has continuity instead of being re-derived each pass.

## 5. Prediction markets native to Arc, where $1 bets make sense

**Where:** [contracts/src/PredictionMarket.sol](contracts/src/PredictionMarket.sol)
· [contracts/src/MarketFactory.sol](contracts/src/MarketFactory.sol)

An automated market maker is well trodden maths. What is uncommon is running one
where the economics work.

Sub cent transaction cost on Arc makes a $1 bet viable, where the same trade on
a typical L2 would surrender a meaningful share of its value to gas before
settlement. USDC is both the settlement asset and the gas token, so there are no
bridges, no wrapped assets and no second currency to reason about. And because
an automated market maker always quotes a price, there is no order book to
bootstrap, which is what lets the platform carry thousands of short horizon
markets without liquidity providers.

The factory has produced 8,125 markets, of which 8,005 have settled.

---

## What we deliberately did not do

**Circle Paymaster.** On Arc, gas is already USDC. Paymaster exists to let users
pay gas in USDC on chains where gas is a volatile native token, which on Arc is
true by construction. Integrating it would add a dependency and change nothing.

**CCTP and cross chain.** Arc is a single chain product here by design.

**A bespoke smart account system.** We built one earlier and deleted it in
favour of Circle's managed wallets, which give the same custody properties
without us maintaining the contract.

**Session token reuse for paid access.** The provider issues an hour long
session token per payment, but claiming it would mean hand rolling the payment
protocol. Batched reads already keep a full catalogue scan to roughly $0.003, so
the complexity does not pay for itself.

**Fine tuning, reinforcement learning, custom embeddings.** A tool use loop with
good prompts and a hard risk gate is the bar for this problem. Anything fancier
would have been evidence of effort rather than evidence of judgement.
