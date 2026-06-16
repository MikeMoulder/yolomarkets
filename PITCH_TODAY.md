# YOLO Markets Video Pitch - June 15, 2026

## Core Pitch

YOLO Markets is an Arc-native prediction market where users can trade manually or hand a capped bankroll to an AI agent that researches markets, estimates probability, sizes positions, and executes on-chain.

The simple line:

> Polymarket proved prediction markets work. YOLO Markets asks what they look like when the market, wallet, and AI trader are built natively for Arc: cheap small bets, USDC settlement, and an agent that can act while the user is offline.

## 90-Second Version

Hi, I am building YOLO Markets: a prediction market on Arc where every market has two ways to participate.

First, you can trade manually. You open a market, compare the on-chain price with the AI estimate, choose YES or NO, preview the cost and slippage, and place a USDC bet on Arc.

Second, you can turn on agent mode. The agent has a scoped budget and risk profile. It scans live markets, compares Arc prices against external signals like Polymarket and fresh news, computes edge and Kelly-sized position sizes, and either trades or records why it passed. The important part is that the reasoning is not hidden: every decision is logged with probability, confidence, sources, and the tool trace.

Under the hood, YOLO Markets is not just an agent wrapper around another venue. The contracts are native Arc LMSR prediction markets settling in USDC. The current runner is live, the factory has over 2,000 markets, the Polymarket resolver is tracking 110 mirrored markets, and the fast-market worker has already resolved over 100 short-window markets.

Arc matters because this product needs lots of small, frequent transactions. A user might want to place a one-dollar bet, and an agent might need to evaluate and rebalance continuously. That only makes sense when settlement is fast, cheap, and USDC-native.

So the bet is: prediction markets become much more useful when they are not just places to trade opinions, but systems where users can delegate disciplined, transparent market research to agents. That is YOLO Markets.

## 3-Minute Recording Flow

### 0:00-0:20 - Hook

Screen: home page or market grid.

Say:

> YOLO Markets is an Arc-native prediction market with an embedded AI trader. Users can place their own USDC bets, or they can give an agent a capped bankroll and let it research and trade continuously.

### 0:20-0:55 - Manual Market

Screen: open one market page. Show question, YES/NO prices, bet panel, AI/insight panel if available.

Say:

> This is the normal user flow. A market has a clear resolution rule, a live on-chain price, and a trade panel. The user chooses YES or NO, enters an amount, sees the expected shares and price impact, and submits the trade. The contract is an LMSR market maker, so there is always a price and the market can run without needing an order book.

### 0:55-1:40 - Agent

Screen: `/agent` or `/agent/feed`, expand a decision card with reasoning/tool trace.

Say:

> The differentiated part is agent mode. The agent does not just blindly buy. It reads the market, pulls external context, compares against crowd odds, estimates probability, computes the edge, applies risk gates, and then decides whether to trade. Passes are logged too, because transparency is what makes the agent trustworthy.
>
> Each decision stores the probability, confidence, reasoning, sources, Kelly math, and tool trace. That gives users and judges an audit trail for why a trade happened.

### 1:40-2:15 - Infrastructure

Screen: admin or logs/terminal showing PM2/log status if useful.

Say:

> This is running as a real system, not a static demo. The background workers are online: the agent runner, fast-market keeper, Polymarket resolver, and fast-market swarm. The current factory reports over 2,000 markets. The resolver is tracking 110 mirrored Polymarket markets, and the fast-market worker has resolved over 100 short-window crypto markets.

### 2:15-2:40 - Why Arc/Circle

Screen: market transaction/explorer link, wallet/portfolio, or contract address.

Say:

> Arc is the reason this design is viable. Prediction markets need cheap execution, and agents need to make small decisions often. Native USDC settlement means users do not think about wrapped assets or bridges, and low transaction cost means one-dollar bets and frequent agent actions are economically realistic.

### 2:40-3:00 - Close

Screen: return to market grid or agent feed.

Say:

> The thesis is simple: prediction markets should not only show what the crowd thinks. They should help users act on research. YOLO Markets combines Arc-native markets, USDC settlement, and transparent autonomous trading into one product. That is what I am pitching today.

## Say This Only If It Is Visible On Screen

- "The agent placed X trades today."
- "There are X active users."
- "Total volume is X USDC."
- "Gas Station sponsored this transaction."
- "Circle wallet onboarding is live end-to-end."

## Strong Facts You Can Use Today

- PM2 shows `yolo-agent`, `yolo-fast-markets`, `yolo-polymarket-resolver`, and `yolo-fast-swarm` online.
- Agent log reports `factory has 2017 markets`.
- Resolver log reports `tracking 110 mirror market(s)`.
- Fast swarm log reports `active=6 resolved=138`.
- Product surface includes `/`, `/markets/[address]`, `/markets/fast`, `/portfolio`, `/agent`, `/agent/feed`, `/agent/setup`, and `/agent/settings`.

## One-Line Backup Answers

What is it?

> An Arc-native prediction market with a transparent AI agent that can trade for users inside strict risk limits.

Why not just use Polymarket?

> YOLO Markets owns the market venue and execution path on Arc; Polymarket is an external signal, not the place we trade.

Why does the agent matter?

> Most users do not have time to watch every market. The agent turns market research into a continuous, auditable process.

Why Arc?

> Small prediction-market trades and frequent agent actions need cheap, fast, USDC-native settlement.

What is the moat?

> The combination of native market contracts, logged agent reasoning, and autonomous execution creates data and trust that a simple wrapper cannot replicate.
