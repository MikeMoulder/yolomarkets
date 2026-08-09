# YOLO Markets — Innovation

Four things in this codebase are genuinely uncommon in the prediction-market
landscape. Each is a real engineering choice, not a slogan, and each is
verifiable from the linked code in about 30 seconds.

---

## 1. The agent pays its own way — both directions

**Where:** [web/scripts/nanopay-service.ts](web/scripts/nanopay-service.ts) ·
[agent/nanopay.py](agent/nanopay.py) ·
[web/app/api/x402/insight/route.ts](web/app/api/x402/insight/route.ts)

Most "agentic economy" demos show an agent *holding* a wallet. Ours transacts
in both directions with real counterparties, in sub-cent amounts, on Arc.

**It buys.** The free Arc RPC endpoints rate-limit `eth_call` — the single call
every market read depends on — to roughly one per period. That has been a
recurring source of outages here. The agent now buys premium Arc RPC from
QuickNode through Circle Nanopayments at **$0.0001 per call**, gaslessly and
batched via Circle Gateway. Measured: four consecutive `eth_call`s succeed
through the paid path where the free tier fails after the first. A full
discovery pass over 6,654 markets cost 582 paid calls — **$0.0582**.

This is the part worth pausing on: the agent is not buying a token gesture, it
is buying the thing it was actually short of. Paid RPC sits *last* in the
fallback order precisely because it is a remedy, not a habit.

**It sells.** `/api/x402/insight` is a priced endpoint where *another* agent
pays $0.0001 to read our agent's current view of a market — probability,
confidence, edge, reasoning — joined to the live on-chain price. Verified with
real settlement (`7163f1e5-5b8a-4ada-9c97-a26a4e1fbf3a`), money moving out of
the payer's Gateway balance and into the treasury.

Notably, it does **not** proxy an LLM call. Selling inference would make every
sale cost us a model call, would not be differentiated, and would make the
endpoint only as available as our AI provider. We sell the accumulated estimate
the agent has already formed — which costs nothing to serve and stays up when
the model provider is down.

## 2. The risk gate is a tool the model can query but never widen

**Where:** [agent/policy.py](agent/policy.py) ·
`check_trade` in [agent/tools.py](agent/tools.py)

The usual pattern is to describe risk limits in the prompt and hope the model
respects them. Prompts are advisory; ours is not.

Position sizing, edge thresholds, bankroll caps and portfolio concentration
live in deterministic Python. That same logic is then exposed to the model as a
tool it can *call* — so it can ask "would this trade pass?" and plan around a
real answer — but the tool only ever reports a verdict. The model cannot raise
a limit, and a trade that fails the gate is never executed regardless of how
convinced the model is.

The same principle governs spending: the nanopayment service enforces a
per-payment cap and a rolling 24-hour cap, checked in the request handler and
again in the payment SDK's pre-signature hook, so an over-cap payment cannot
even be *signed*. A caller may lower its own ceiling; nothing can raise it.

## 3. Replayable agent reasoning, stored next to the trade

**Where:** [agent/brain.py](agent/brain.py) ·
[agent/agent_core.py](agent/agent_core.py) ·
`agent_decisions` in [web/lib/db/schema.ts](web/lib/db/schema.ts) ·
rendered at [/agent](web/app/agent/page.tsx)

Most agentic projects ship a black box: it trades, you see the trade. We
instrument the reasoning layer.

- A multi-step tool-use loop — each estimate fans out into explicit tool calls
  (web search → external odds → Kelly sizing), each recorded with inputs,
  outputs and elapsed time.
- The tool trace persists **alongside the decision row** in Postgres
  (`tool_trace jsonb`), not in a log file.
- The `/agent` page renders it inline, expandable per decision.
- **Passes are recorded too.** Of 3,903 decisions, the overwhelming majority
  are refusals with a stated reason — which is the honest shape of a
  disciplined trader and is far more legible than a feed of only winners.

The agent also keeps a running first-person journal and a set of per-market
theses that survive across runs (`agent_journal`, `agent_theses`), so its view
of a market has continuity rather than being re-derived from scratch each pass.

## 4. LMSR prediction markets native to Arc — $1 bets that make sense

**Where:** [contracts/src/PredictionMarket.sol](contracts/src/PredictionMarket.sol)
· [contracts/src/MarketFactory.sol](contracts/src/MarketFactory.sol)

LMSR is well-trodden maths. What is uncommon is running it where the economics
work:

- **Sub-cent transaction cost on Arc** makes a $1 bet viable. The same trade on
  a typical L2 would surrender a meaningful share of its value to gas before
  settlement.
- **USDC is both the settlement asset and the gas token**, so there are no
  bridges, no wrapped assets, and no second currency to reason about.
- An automated market maker means there is always a price and no order book to
  bootstrap — which is what lets the platform carry thousands of short-horizon
  markets without liquidity providers.

The factory has produced **7,885 markets**, of which 7,768 have resolved.

---

## What we deliberately did NOT do

- **Circle Paymaster.** On Arc, gas is already USDC. Paymaster exists to let
  users pay gas *in USDC* on chains where gas is a volatile native token —
  on Arc that is true by construction, so integrating it would add a dependency
  and change nothing for the user.
- **CCTP / cross-chain.** Arc is a single-chain product by design here.
- **A bespoke smart-account system.** We built one earlier and deleted it in
  favour of Circle Developer-Controlled Wallets, which give the same custody
  properties without us maintaining the contract.
- **Session-token reuse for paid RPC.** The provider issues a one-hour session
  token per payment, but claiming it would mean hand-rolling the payment
  protocol. Batched reads already keep a full catalogue scan to roughly $0.003,
  so the complexity does not pay for itself.
- **Fine-tuning, RL, custom embeddings.** A tool-use loop with good prompts and
  a hard risk gate is the bar for this problem.
