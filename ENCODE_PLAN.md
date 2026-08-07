# YOLO Markets — Encode "Build on Arc" implementation plan

Scope: close the gap between what we use of the Circle stack and what the
hackathon brief ([encode_hackathon.md](encode_hackathon.md)) names as core
products. Tracks entered: **Agentic Economy** (primary) + **DeFi** (secondary).

---

## 0. Verified facts (don't re-derive)

Checked against Circle docs, not the May-era notes in CLAUDE.md.

| Fact | Value | Source |
| --- | --- | --- |
| Gateway supports Arc | **Yes — Arc Testnet, Domain 26** | `developers.circle.com/gateway/references/supported-blockchains` |
| Nanopayments buyer SDK | `@circle-fin/x402-batching` + `viem` | Gateway nanopayments buyer quickstart |
| Chain id string | `"arcTestnet"` | same |
| Signature scheme | **EIP-3009, offchain, zero gas** | same |
| Wallet requirement | **EOA only — SCA wallets are NOT supported** | same |
| Deposit | `client.deposit()` — one-time onchain tx, needs native gas | same |
| Pay | `client.pay(url)` → 402 → sign → retry w/ `PAYMENT-SIGNATURE` | same |
| Agent Wallets custody | user-controlled, 2-of-2 MPC (**not** developer-controlled) | `agent-stack/agent-wallets` |
| App Kit packages | `@circle-fin/app-kit` + `@circle-fin/adapter-viem-v2` | `docs.arc.io/app-kit` |
| Paymaster on Arc | **structurally moot** — Arc gas *is* USDC | — |

### Phase 0 spike results (empirical, 2026-08-05)

Verified by running the SDK, not by reading docs.

| Check | Result |
| --- | --- |
| `@circle-fin/x402-batching` | **v3.3.0**, Apache-2.0, by Circle Internet Financial |
| Peer deps | `@x402/core` ^2.3.0 (auto-installed), `@x402/evm` optional, `viem` |
| `'arcTestnet'` in `GATEWAY_DOMAINS` | ✅ **domain 26** |
| Arc USDC in `CHAIN_CONFIGS` | ✅ `0x3600…0000` — matches our documented address |
| Arc chain id | ✅ `5042002` |
| GatewayWallet (Arc testnet) | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` — **163 bytes of bytecode on-chain** |
| GatewayMinter (Arc testnet) | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` — **deployed** |
| Gateway API live for Arc | ✅ `getBalances()` returned a real balance object |
| SDK default rpcUrl | `rpc.testnet.arc.network` — the CORS-hostile one. Server-side so it works, but **pass our own `rpcUrl`** (gotcha #3) |
| Payer EOA | `0xD784708cB9CA80FF035EcfD73D6B1F2d43dC17D9` — provisioned, in root `.env`, **unfunded** |
| OpenRouter credits | ❌ **$23.00 granted / $23.20 used = −$0.20.** This is the source of every 402. |
| Deployer balance | $159.67 USDC (down from $433 on 2026-08-01) |

### Marketplace reality — the Discovery catalogue LIES about networks

`https://api.circle.com/v2/x402/discovery/resources` (public, no auth) lists
**958 services across only 22 distinct hosts**. Categories: FINANCIAL_ANALYSIS
447, DATA_ENRICHMENT 185, WEB_SEARCH_RESEARCH 102, SOCIAL_INTELLIGENCE 95,
INFRASTRUCTURE 89, **PREDICTION_MARKETS 26**, CREATIVE 14.

Filtering that catalogue by `network` shows **zero Arc services** — every
listing advertises Base / Polygon / Solana. **That filter is wrong.** The live
402 handshake offers more than the catalogue advertises:

- `supports()` from an **arcTestnet** client against QuickNode returns
  `supported: true`, `network: eip155:5042002`, `amount: "100"` (**$0.0001**),
  asset `0x3600…`, `verifyingContract` = the Arc GatewayWallet.
- The raw 402 body confirms it: *"per-request ($0.001/request), **nanopayment
  ($0.0001/request via Circle Gateway)**, or credit drawdown"*.

**Implementation rule: never filter the catalogue by network. Probe
`client.supports(url)` per host and cache the answer.**

Tested 6 other hosts (Allium, Exa, Messari, Goldsky, aisa, blockrun) — all
returned `supported: false` from an Arc client. **QuickNode is currently the
only counterparty that settles on Arc.** Leg B is real but has exactly one
supplier today.

### Two blockers that shape the whole design

1. **Our agent wallets cannot pay nanopayments.** Circle Developer-Controlled
   Wallets on Arc are **SCA**; nanopayments require an **EOA** because
   settlement is an EIP-3009 signature. The user's bankroll wallet can never
   be the nanopayments payer.
2. **The SDK is TypeScript; the agent is Python.** `@circle-fin/x402-batching`
   is a TS/viem package. `agent/x402.py` cannot import it. We need a bridge,
   not a rewrite.

---

## 1. Target economics — two distinct legs

The current fee is circular: the agent pays *our own treasury* for reasoning it
performs *in-process*. That is the weakest claim in the repo. Replace it with
two real, non-circular legs:

```
LEG A (retail, on-chain USDC on Arc)   user's Circle SCA wallet ─► platform treasury
                                       tier / credit settlement, unchanged

LEG B (machine-to-machine, Nanopayments)  platform payer EOA ─► QuickNode x402 RPC
                                          $0.0001/req on Arc, gasless, batched

LEG C (revenue, Nanopayments)          external agents ─► YOLO Insight API
                                       we become an x402 *seller*
```

### Leg B has a better justification than "reasoning fees"

The spike found what QuickNode actually sells on Arc: **premium RPC access at
$0.0001 per request**, and a successful nanopayment returns a **JWT session
token valid 3600s** (`extensions.quicknode-session`). So one sub-cent payment
buys an hour of premium RPC.

We are RPC-constrained *today* — the repo is a catalogue of free-Arc-RPC
failures: 429 storms on the portfolio scan, "request limit reached" on 750-call
batches, viem re-splitting multicalls, the polymarket resolver timing out on a
single RPC and leaving 48 markets unsettled. **An agent that autonomously buys
the infrastructure it needs, when it needs it, is a far stronger Agentic-track
story than an agent paying itself a reasoning fee** — and it fixes a real
operational problem rather than staging one.

Retarget Leg B accordingly: the agent pays for RPC/data it genuinely consumes.
Keep the per-decision reasoning fee as Leg A accounting (user → platform).

Leg A already exists and keeps working. **B and C are the new build.**

### Why a platform payer EOA, not per-user EOAs

Per-user EOAs would reintroduce exactly the session-key sprawl deleted on
2026-06-17: N keys to manage, N funded floats, N onchain Gateway deposits.
One platform payer EOA with a Gateway balance gets batching working as
designed, and the user→platform leg stays on-chain in their own wallet. The
user still pays; the platform buys compute wholesale. This is a normal and
defensible structure, and it is *more* honest than the current circular fee.

---

## 2. Phases

### Phase 0 — Foundations

- [x] SDK spike — `arcTestnet` valid, Gateway contracts deployed, API live.
- [x] Marketplace spike — 958 services / 22 hosts; QuickNode is the only Arc
      counterparty; `supports()` probing beats catalogue filtering.
- [x] Provision the **payer EOA** — `0xD784…17D9`, root `.env`. Deliberately
      NOT the deployer (`0xdfB1…`, factory admin) and NOT the resolver
      (`0xF95C…`, settlement authority): role separation is an audit property
      (H-1/H-2). `.env` is gitignored — confirmed.
- [ ] **Top up OpenRouter credits** (user action; balance is −$0.20). Everything
      agentic is downstream — the brain 402s and the agent logs passes only.
- [x] Fund the payer EOA with USDC + native gas, then `deposit()`. Done:
      $20 faucet → $10 deposited → first payment settled (see Phase 1).

### Phase 1 — Nanopayments buyer (Leg B) — **built, awaiting funding**

The bridge: a small Node service, not a rewrite of the agent.

- [x] [web/scripts/nanopay-service.ts](web/scripts/nanopay-service.ts) —
      `GET /health`, `GET /balance`, `GET /supports?url=`, `POST /pay`,
      `POST /deposit`. Binds 127.0.0.1 only (it can spend). `npm run
      nanopay:service` (`-- --once` self-checks and exits).
- [x] Deterministic spend caps in the service: per-payment
      (`NANOPAY_MAX_PAYMENT_MICRO`, $0.01) + rolling 24h
      (`NANOPAY_DAILY_CAP_MICRO`, $1.00). Enforced twice — in the handler, and
      again in the SDK's `onBeforePaymentCreation` hook, which aborts **before a
      signature exists**. The caller may lower the ceiling, never raise it.
- [x] `supports()` results cached (1h). **Never filter the Discovery catalogue
      by network** — probe instead; see the marketplace note above.
- [x] [agent/nanopay.py](agent/nanopay.py) — Python client. Opt-in via
      `AGENT_NANOPAY=1`; every call degrades to `None` when the service is down
      (verified: 0.14s, no exception). Payment rails must never stop trading.
- [x] `yolo-nanopay` added to [ecosystem.config.cjs](ecosystem.config.cjs)
      (not started — needs a funded Gateway balance first).
- [x] Env documented in [.env.example](.env.example).
- [x] **Funded + deposited + first live payment settled.** See below.
- [x] **Wired into the agent.** QuickNode sells Arc testnet RPC as an x402
      resource (`x402.quicknode.com/arc-testnet/`, $0.0001/call) — the agent now
      buys the exact capability the free tier denies it.
      · `POST /rpc` on the nanopay service is a **raw JSON-RPC passthrough**, so
        it drops straight into web3.py as a provider URL.
      · `get_rpc_urls()` in [agent/loop.py](agent/loop.py) appends it to the
        existing fallback list. **Free RPCs first, paid last as the safety net**;
        `AGENT_NANOPAY_RPC_PRIMARY=1` promotes it to first.
      · Rail down/disabled → `paid_rpc_url()` returns None and the URL never
        enters the list. Verified: agent reads are byte-identical without it.
- [x] `yolo-nanopay` running under pm2, `pm2 save`d. `AGENT_NANOPAY=1` in root
      `.env`; agent restarted onto the new code.
- [ ] ~~Session reuse~~ — **not viable without hand-rolling x402.** QuickNode
      issues a 3600s JWT in the *settlement response* extensions, but the SDK's
      `PayResult` exposes only `{data, amount, formattedAmount, transaction,
      status}` and the hook contexts carry only *request*-side extensions. Not
      worth it: Multicall3 batching already keeps a full ~5,300-market scan to
      ~27 aggregate calls ≈ $0.0027.
- [ ] Persist settlements into `agent_decisions` — prefer one `nanopay_receipt`
      jsonb column via a migration following the `0009`/`0010`/`0011`
      direct-apply convention.

### LIVE — first nanopayment settled on Arc, 2026-08-05

| Step | Evidence |
| --- | --- |
| Faucet → payer | $20 USDC (wallet **and** native gas — same underlying) |
| `POST /deposit {"amount":"10"}` | approve `0x0771cf09…9a03`, deposit `0x36fd5440…bb7f` |
| Gateway balance | wallet 9.996854 (gas spent), **gateway 10.0 available** |
| `POST /pay` QuickNode | **paid $0.0001**, `eip155:5042002`, **1115 ms**, Circle settlement `72b15c25-8713-4c0b-9eef-24de9a2d0cc0` |
| Service returned | real data — `eth_blockNumber` → `0x2d998cd` |
| Same call from Python | `agent/nanopay.py` → $0.0001, 1739 ms, `0x2d998f1` |
| Balance after | gateway `9.9999`, ledger `spentLast24h=100` micro |
| Spend cap vs live price | instance with cap 50 micro **refused** the real 100-micro payment: `payment $0.0001 exceeds per-payment cap $0.00005` |

The agent autonomously paid a third party in USDC on Arc, gaslessly, and got a
service back. That is the Agentic-Economy claim, executed rather than asserted.

### Leg B at scale — measured, and why paid RPC is NOT the default path

Ran a full agent discovery pass with paid RPC primary:

| Metric | Value |
| --- | --- |
| Markets discovered | **6,654** (incl. the 13,848-address legacy scan) |
| Paid calls | **582** |
| Cost | **$0.0582** |
| Wall time | **320 s** |
| Consecutive `eth_call`s through paid RPC | **4/4 ok** — the free tier dies after 1 |

The cost is trivial; the *latency* is not — every call is a payment round-trip,
so bulk scans are far slower than a free endpoint. Hence the ordering: free
first for speed, paid last so a rate-limited free tier can't stall the agent.
`AGENT_NANOPAY_RPC_PRIMARY=1` flips it for a demo, and is a proven-working path.

**Ledger caveat:** the 24h spend ledger is in-process and resets on restart —
the on-chain Gateway balance is the real hard limit. Fine for runaway-loop
protection, not an accounting system of record.

**RPC gotcha found the hard way — cost the first three deposit attempts.**
`rpc.quicknode.testnet.arc.network` rate-limits **`eth_call`** to roughly one
per period, returning `-32011 request limit reached`; blockdaemon, dRPC and the
Arc default all answered 3/3. Gateway's `deposit()` reads `allowance()` first,
so a rate-limited eth_call blocks the whole flow with an error that *looks*
like a Gateway problem. The service now probes an ordered fallback list and
pins the first healthy endpoint **before** any broadcast (rotating mid-flight
around a `deposit()` would risk double-sending). quicknode is last in that
list: its CORS headers only matter to the browser.

**Marketplace caveat, stated honestly:** QuickNode remains the only confirmed
Arc-settling counterparty. The other hosts probed returned *"Resource does not
require payment (not 402)"* rather than "Arc unsupported" — `supports()` issues
a GET and those are POST endpoints, so **this is partly a probe artifact, not
proof they refuse Arc**. Direct POSTs to two of them returned 404/403, so their
catalogue paths aren't live endpoints either. Treat "only QuickNode" as the
verified floor, not a closed question.

**Verified pre-funding** (service live, payer unfunded): `/health` 200 with the
payer address · `/balance` reads real Gateway state · `/supports` returns
`supported:true, eip155:5042002, amount 100` for QuickNode and `false` for Exa ·
`/pay` returns 409 when the caller's ceiling is below price, 422 for a
non-Gateway resource, 400 with no url, 404 unknown route · a real `/pay`
attempt fails cleanly with `insufficient_balance` and the service survives ·
typecheck clean.

### Phase 2 — x402 seller: YOLO Insight API (Leg C)

We already generate market intelligence. Sell it.

- [ ] `web/app/api/x402/insight/route.ts` — returns **402 + payment
      requirements** when unpaid; on a valid `PAYMENT-SIGNATURE`, serves the
      insight payload (market prob, AI estimate, edge, confidence, sources).
- [ ] Price it sub-cent — that is the entire point of nanopayments and it
      demos the batching story.
- [ ] Reuse the existing insight path in [web/lib/llm.ts](web/lib/llm.ts); do
      not build a second brain.
- [ ] Verify end-to-end with our own Phase-1 buyer client hitting it (plumbing
      proof), then list on the Agent Marketplace.

### Phase 3 — App Kits (both tracks)

- [ ] `npm i @circle-fin/app-kit @circle-fin/adapter-viem-v2` in `web/` —
      the viem adapter drops into the existing wagmi/viem setup.
- [ ] **Bridge Kit** in the agent funding flow: fund an agent wallet from
      Ethereum Sepolia / Base Sepolia → Arc Testnet in ~10 lines. This is a real
      onboarding gap today (users must already hold Arc USDC).
- [ ] Surface in [web/components/wallet-modal.tsx](web/components/wallet-modal.tsx)
      alongside the existing Circle email/OTP path.

### Phase 4 — Agent Marketplace

- [ ] Buyer: wire Discovery API results into the agent tool belt
      ([agent/tools.py](agent/tools.py)) so the agent can *find* and *pay for*
      data autonomously. Meter it through the existing `check_trade`-style
      deterministic gate — the model may spend, never widen its own budget.
- [ ] Seller: get the Phase-2 Insight API listed.

### Phase 5 — Agent Wallets (conditional, verify first)

Circle Agent Wallets are **user-controlled 2-of-2 MPC** — a different custody
model from our developer-controlled wallets. Their policy engine (per-service
caps, allowlists, time-bounded sessions, x402 payment restrictions) is
precisely the deleted `AgentAccount.sol`, productized.

- [ ] **Verify Arc support first** — the Agent Wallets doc does not mention Arc.
- [ ] Only then evaluate migration. A custody migration is not a cosmetic
      change; do not start it before Phases 1–3 are green.

---

## 3. Explicitly excluded

| Product | Why |
| --- | --- |
| **Paymaster** | Arc gas is already USDC. Integrating it adds nothing. Say this in the deck — it reads as understanding the stack. |
| **CCTP** | Gateway already covers our cross-chain need via App Kit Bridge. |
| **StableFX** | EURC exists only in a dormant PowerShell script. Real FX is a product, not a checkbox. |
| **Circle Contracts** | Our contracts are the differentiated part; template deployment adds nothing. |

---

## 4. Repo hygiene (judges read these)

- [ ] [INNOVATION.md](INNOVATION.md) leads with `AgentAccount.sol` and links to
      it — **deleted 2026-06-17**. Dead link, false claim, first thing seen.
      Rewrite around Circle DCW + nanopayments + the LMSR/Arc design.
- [ ] [traction.md](traction.md) is placeholder numbers from the *previous*
      hackathon ("Day 5 of 14", markets live: 1). Refresh from Postgres:
      3,811 decisions / 7 trades / $2.20 volume / 3 profiles — and be honest
      that the pass rate is the risk gate working, not the agent idling.
- [ ] [PITCH_TODAY.md](PITCH_TODAY.md) script is from 15 June and quotes
      "over 2,000 markets" (actual: ~5,300).

---

## 5. Sequencing rationale

Phase 0 gates everything (no credits → no agent; no Gateway deposit → no
Leg B). Phase 1 is the highest-value single change: it converts the repo's
weakest claim (simulated x402) into the brief's named primitive, and the
`X402Receipt` seam means the blast radius is one file. Phase 2 makes the
economics non-circular and gives us a *seller* surface. Phase 3 is cheap and
scores on both tracks. Phases 4–5 are upside.
