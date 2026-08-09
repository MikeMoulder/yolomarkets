# YOLO Markets

Prediction markets on **Arc**, Circle's stablecoin-native L1, with an
autonomous agent that researches markets, sizes positions, and trades in USDC —
and that pays for the services it uses, in fractions of a cent, without a human
in the loop.

Live at **[yolomarkets.fun](https://yolomarkets.fun)** · Arc testnet (chain
`5042002`) · every balance, bet, fee and payment denominated in USDC.

---

## Why it's interesting

Three things, in short. The long version — with code links — is in
[INNOVATION.md](INNOVATION.md).

**The agent transacts in both directions.** It *buys* premium Arc RPC at
$0.0001 a call through Circle Nanopayments, because the free endpoints
rate-limit the one call every market read depends on. It also *sells*: any
other agent can pay $0.0001 to read its current view of a market. Real
settlement, both ways.

**Risk limits are code, not prompt text.** Position sizing, edge thresholds and
spend caps live in deterministic Python. The model can *call* that logic to ask
whether a trade would pass — but it can never widen a limit, and a trade that
fails the gate is not executed however confident the model is.

**Reasoning is stored next to the trade.** Every decision — including the
refusals, which are the vast majority — persists with its probability,
confidence, tool trace and stated reason, and renders at `/agent`. You can read
why the agent did nothing, which is usually the more interesting question.

## Where it stands

7,885 markets created, 7,768 resolved, 3,903 agent decisions, 12 live trades,
seven background services running continuously. Full numbers, including the
unflattering ones, in [traction.md](traction.md).

## How it fits together

```
contracts/   PredictionMarket.sol (LMSR AMM) + MarketFactory.sol — USDC settlement
web/         Next.js 16 app + all TypeScript services (keepers, indexer, bot)
agent/       Python trading agent: perceive → plan → score → act → reflect
scripts/     one-off ops (wallet setup, market seeding)
```

The agent runs a plain threaded HTTP server rather than a web framework —
deliberately, so the long-lived trading loop stays the main thread and the chat
endpoint rides alongside it.

**Money moves in three separate flows**, kept distinct so the economics stay
honest: users pay the platform (revenue), the platform pays outside services
(cost), and outside agents pay the platform for intelligence (revenue). See
[ENCODE_PLAN.md](ENCODE_PLAN.md).

## Running it

```bash
cp .env.example .env        # fill DEPLOYER_PRIVATE_KEY, CIRCLE_*, DATABASE_URL
                            # fund the deployer at https://faucet.circle.com

cd contracts && forge install && forge test

cd ../web && npm install
npm run dev                 # the app
npm run db:migrate          # schema

cd ../agent && uv sync
uv run python loop.py       # one pass, paper mode; add --live to trade
```

Background services are managed by pm2 — see
[ecosystem.config.cjs](ecosystem.config.cjs):

```bash
pm2 start ecosystem.config.cjs      # agent, keepers, indexer, nanopay, bot
```

### Two things that will cost you an afternoon

**Don't deploy anything that touches USDC with `forge script`.** Arc's USDC
calls a blocklist precompile that Foundry's local EVM doesn't know, so the
script's own body reverts even with `--skip-simulation`. Use `forge create` +
`cast send`.

**Not all Arc RPC endpoints are interchangeable.** The default one sends no
CORS headers, so browser calls fail silently and balances read as zero. A
different one rate-limits `eth_call` to roughly one per period, which breaks
contract reads in a way that looks like a contract bug. Server-side code should
prefer blockdaemon or dRPC; the browser needs a CORS-safe list.

Both, and the rest of the hard-won detail, are in [CLAUDE.md](CLAUDE.md) — the
load-bearing context file for anyone (human or agent) working in this repo.

## Documentation

| File | What it is |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | Operational truth: addresses, gotchas, decision history |
| [INNOVATION.md](INNOVATION.md) | What's genuinely uncommon here, with code links |
| [traction.md](traction.md) | Reproducible numbers, as of the last snapshot |
| [ENCODE_PLAN.md](ENCODE_PLAN.md) | The Circle-stack integration plan and its results |
| [idea.md](idea.md) | The original design. Treat as intent, not spec — it predates several reversals |

## License

MIT.
