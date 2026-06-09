# YOLO Markets — Innovation

Three things in this codebase are genuinely uncommon in the prediction-market
landscape. Each is a real engineering choice, not a slogan. Code locations
are linked so judges can verify in 30 seconds.

---

## 1. Cap-metered `AgentAccount.execute()` that auto-approves USDC per call

**Where:** [contracts/src/AgentAccount.sol](contracts/src/AgentAccount.sol)
· factory [0x0453…7a8d](https://testnet.arcscan.app/address/0x04538699e0dAe81258FD6Ff1408f763379827a8d)

The standard session-key pattern lets a server-side signer call a fixed
selector on a fixed target, up to a per-call and total-cap USDC limit. That's
table-stakes. What makes this implementation uncommon:

- **The contract decodes `buy(uint8,uint256,uint256)`'s third argument
  (`maxCost`) at call time** and meters that against the cap. Other selectors
  meter as 0 — pinning `allowedSelector` is the security boundary, and the
  cap math is exact, not approximate.
- **`approve(market, maxCost)` is issued automatically before forwarding
  the buy** — eliminating the need to whitelist the `approve` selector
  (which would have been a wide attack surface).

Net effect: an off-chain agent can trade for the user without ever holding
the user's USDC, ever exceeding the user-configured cap, or ever being able
to set an unlimited allowance. The contract itself enforces the invariant.

[Phase-3 commit notes in CLAUDE.md](CLAUDE.md) describe the design decision
to stay in-house rather than pull in ZeroDev / Biconomy — the surface is
small enough (~120 lines of Solidity) that a third-party SDK didn't pay for
itself.

## 2. Replayable, on-chain-adjacent agent reasoning

**Where:** [agent/brain.py](agent/brain.py) · stored at
[web/lib/db/schema.ts → agent_decisions](web/lib/db/schema.ts) ·
rendered at [/agent](web/app/agent/page.tsx)

Most agentic prediction-market projects ship a black-box agent: it trades,
you see the trade. We instrument the reasoning layer instead.

- **Multi-step Claude tool-use loop**: every estimate fans out into a
  sequence of explicit tool calls (`web_search` → `fetch_polymarket_odds` →
  `compute_kelly`), each with input + output + elapsed-ms recorded.
- **Tool trace is persisted alongside the decision row** in Postgres
  (`tool_trace jsonb`), not in a log file.
- **The `/agent` page renders the trace inline**, expandable per decision.
  Anyone can read why the agent bet — sources cited, math done.

This trace is the audit surface RFB 02's "agentic sophistication" criterion
is asking for. Single-shot LLM calls are *automation*; a replayable
reasoning chain is *agentic*.

## 3. LMSR AMM native to Arc — viable $1 bets

**Where:** [contracts/src/PredictionMarket.sol](contracts/src/PredictionMarket.sol)
· first market at
[0xC19F…a779](https://testnet.arcscan.app/address/0xC19F30208Ad6a6328E90D5B95F110E87CE34a779)

LMSR is well-trodden math; what's uncommon is shipping it on a chain where
the economics actually work:

- **Sub-cent transaction cost on Arc** makes a $1 bet profitable. On
  Polygon at typical Polymarket gas, the same trade would lose ~10% of its
  value to fees before settlement.
- **Native USDC** (Circle's stablecoin, settled in 6-dec ERC-20) means no
  bridges, no wrapped-asset slippage, no off-chain custodian. Bets settle
  on-chain against the same USDC the user holds in their wallet.
- **First LMSR prediction market on Arc** — at the time of submission, no
  other LMSR-on-Arc deployment exists per a Arcscan search.

The sub-cent cost is what enables (1) the agent to make many small bets
without grinding the bankroll to dust on fees, and (2) the platform to be
useful for casual traders putting $1 on a sports game, not just whales.

---

## Bonus: multi-currency settlement (EURC pilot)

**Where:** `scripts/deploy-eurc-market.ps1`

We deploy a standalone PredictionMarket settled in EURC (Circle's
euro-pegged stablecoin) alongside the USDC factory. This isn't innovation
in the contract — same LMSR, same code — but it demonstrates that the
protocol cleanly supports multi-currency settlement, which RFB 03 calls out
explicitly under "prediction market verticals."

A second factory or a generalised factory was the alternative; a single
standalone market is the right call for the demo (less code, same story).

---

## What we deliberately did NOT do (and why it's a feature, not a gap)

- **No bespoke wallet SDK** when Circle's User-Controlled Wallets and
  Gas Station are the canonical Arc-native primitives. We use them
  ([web/lib/circle.ts](web/lib/circle.ts)).
- **No on-chain oracle dance for resolution**. Markets resolve via the
  admin (treasury) after the deadline, against a public source named in
  `resolutionCriteria`. An oracle would be 2 weeks of work for a feature
  judges can't differentiate from a manual call at this scale.
- **No CCTP / cross-chain rollout**. Arc is a single-chain product by
  design. CCTP is in the roadmap, not the demo.
- **No fine-tuning, no RL, no custom embeddings**. Claude's tool-use loop
  + good prompts wins this round. Anything fancier would have been
  evidence-of-effort theater.
