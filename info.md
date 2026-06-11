Here’s the whole setup, from the outside in.

**Big Picture**
YOLO Markets has four live-ish moving parts:

1. **Contracts on Arc testnet**: binary prediction markets using USDC.
2. **Next.js web app**: users browse markets, trade, configure agents.
3. **Python AI agent runner**: reads user profiles, evaluates markets, may trade.
4. **Market automation workers**: create/resolve fast crypto markets, mirror Polymarket resolutions, and run a small fast-market swarm.

A key correction: the docs still mention a FastAPI agent service in places, but the actual agent is a daemon process with a tiny health endpoint, launched by PM2 via [ecosystem.config.cjs](/root/yolomarkets/ecosystem.config.cjs:1).

**Contracts**
The market primitive is [PredictionMarket.sol](/root/yolomarkets/contracts/src/PredictionMarket.sol:1). Each market is binary: YES or NO.

A trade means:

- Buyer chooses YES or NO.
- Contract uses LMSR pricing, so price moves as people buy/sell.
- `previewBuy()` estimates exact USDC cost.
- `buy(outcome, shares, maxCost)` charges USDC and enforces slippage.
- After deadline, admin resolves YES/NO/Cancelled.
- Winners call `claim()` and get 1 USDC per winning share.

The factory is [MarketFactory.sol](/root/yolomarkets/contracts/src/MarketFactory.sol:1). It deploys markets, keeps the canonical market list, and resolves markets. The current factory address is in [web/lib/contracts.ts](/root/yolomarkets/web/lib/contracts.ts:1):

- `factory`: `0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA`
- `usdc`: `0x3600000000000000000000000000000000000000`
- `agentFactory`: `0x04538699e0dAe81258FD6Ff1408f763379827a8d`

There is also [AgentAccount.sol](/root/yolomarkets/contracts/src/AgentAccount.sol:1), the older per-user smart-account path. It lets a user grant a scoped session key that can only spend within caps, on allowed targets/selectors. For market buys, it auto-approves USDC for the exact `maxCost`.

**Web App**
The web app is the user and admin surface. It does three jobs:

- Reads Arc markets directly from the factory and market contracts.
- Pulls Polymarket Gamma data for catalog/reference markets.
- Writes agent profiles into Postgres through Next API routes.

The database schema lives in [web/lib/db/schema.ts](/root/yolomarkets/web/lib/db/schema.ts:1). Important tables:

- `agent_profiles`: user’s strategy, budgets, wallet, market filters, active state.
- `agent_decisions`: append-only log of every pass/trade decision.
- `agent_credits`: off-chain AI credit balance.
- `agent_subscriptions`: free/active/pro tier.
- `agent_session_keys`: schema-ready legacy session key storage.

**Agent Runner**
The production entrypoint is [agent/runner.py](/root/yolomarkets/agent/runner.py:1). PM2 runs:

```bash
uv run python runner.py --port 8080
```

That starts:

- a health server on `:8080`
- a repeated call into `main_per_user()` from [agent/loop.py](/root/yolomarkets/agent/loop.py:1)
- live mode via `RUNNER_LIVE=1`
- interval currently `RUNNER_INTERVAL_SECONDS=180`

The runner’s loop is:

1. Connect to Arc RPC.
2. Load all markets from `MarketFactory.allMarkets()`.
3. Load runnable profiles from Postgres.
4. For each profile, read bankroll.
5. Filter markets by profile settings.
6. Ask the AI brain for probability.
7. Compute edge and Kelly size.
8. Apply deterministic risk gates.
9. If allowed, execute.
10. Persist decision to `agent_decisions`.

**Decision Logic**
The “brain” is [agent/brain.py](/root/yolomarkets/agent/brain.py:1). It uses OpenRouter, usually Claude Sonnet, with tools:

- `web_search`: recent evidence via Perplexity/Sonar through OpenRouter.
- `fetch_polymarket_odds`: fuzzy-match Polymarket as a crowd prior.
- `compute_kelly`: deterministic position sizing.

The simpler fallback path is still in [agent/loop.py](/root/yolomarkets/agent/loop.py:1), but the preferred path is the multi-step brain because it records `tool_trace`, `news_summary`, sources, model, prompt hash, and iterations.

The trading math is:

- If AI probability is above market YES price, consider buying YES.
- If AI probability is below market YES price, consider buying NO.
- Edge must clear the profile threshold.
- Confidence must clear the profile threshold.
- Kelly sizing determines stake as a fraction of bankroll.
- Single-market exposure is capped.

Risk policy lives in [agent/policy.py](/root/yolomarkets/agent/policy.py:1). Presets include `moonshot`, `quant`, `contrarian`, `news_trader`, and `copycat`.

**Execution Paths**
There are two execution paths.

Preferred current path: **Circle Developer-Controlled Wallets**, implemented in [agent/circle_wallets.py](/root/yolomarkets/agent/circle_wallets.py:1).

For Circle profiles:

1. Agent reads wallet USDC balance via Circle.
2. Before buying, it optionally transfers platform fee to treasury.
3. It sends an ERC-20 `approve(market, maxCost)`.
4. It sends `buy(uint8,uint256,uint256)` to the market.
5. Circle signs/broadcasts, optionally with Gas Station sponsorship.

Legacy path: **AgentAccount + session key**.

For legacy profiles:

1. Agent signs with `AGENT_SESSION_PRIVATE_KEY`.
2. It calls `AgentAccount.execute(market, 0, buyCalldata)`.
3. AgentAccount validates session caps.
4. AgentAccount auto-approves USDC.
5. AgentAccount forwards `buy()`.

**Credits And Subscriptions**
[agent/credits.py](/root/yolomarkets/agent/credits.py:1) gates live trading economics.

- Free users cannot live trade.
- Active/pro users can live trade.
- Brain runs cost credits by model tier:
  - economy: 1
  - standard: 5
  - premium: 20
- If credits are insufficient, the trade is turned into a pass/paper-style outcome.

Important distinction: these are platform AI credits, separate from OpenRouter’s own account balance.

**Fast Market Infrastructure**
PM2 also runs:

- `yolo-fast-markets`: [web/scripts/fast-market-keeper.ts](/root/yolomarkets/web/scripts/fast-market-keeper.ts:1)
- `yolo-polymarket-resolver`: [web/scripts/polymarket-resolution-keeper.ts](/root/yolomarkets/web/scripts/polymarket-resolution-keeper.ts:1)
- `yolo-fast-swarm`: [web/scripts/fast-market-swarm.ts](/root/yolomarkets/web/scripts/fast-market-swarm.ts:1)

The fast keeper maintains active BTC/ETH/SOL markets for `15m` and `1h`, resolves them from Binance/CoinGecko price data, creates replacements, and sweeps residual treasury. Your logs show it actively creating, resolving, and sweeping.

The swarm uses generated local EOAs from `config/fast-market-swarm.wallets.json`, randomly buys small YES/NO positions on fast markets, then claims winners. This creates activity/liquidity but is not the AI agent.

**Current Health From Logs**
The most important current blocker: the AI brain is failing with OpenRouter `402 Insufficient credits`. That means the agent is cycling, reading profiles/markets, but cannot produce fresh AI estimates.

I also saw:

- occasional Arc RPC `Connection reset by peer`
- Postgres pool discarding closed connections
- profiles with bankrolls like `$15` / `$20`
- users currently showing `tier=free`, which blocks live AI trading anyway

So the system is not “dead”; it is mostly starved at the OpenRouter layer, and live trading is also gated by subscription tier.

**Mental Model**
Think of it like this:

- Contracts are the casino table.
- Fast keepers create and settle short-lived games.
- Web app lets users configure what their agent is allowed to do.
- Postgres is the shared memory.
- Python runner is the trader.
- OpenRouter/Claude is the analyst.
- Policy code is the risk officer.
- Circle or AgentAccount is the signer/executor.
- `agent_decisions` is the audit trail.

The next practical fix is not in the trading algorithm: top up or swap OpenRouter credentials/model config, then make sure the intended user is `active/pro` or run in paper mode deliberately.