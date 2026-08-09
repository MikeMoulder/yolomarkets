# YOLO Markets

Prediction markets on Arc, with an AI agent that trades on your behalf and pays
its own way in the process.

Live at **[yolomarkets.fun](https://yolomarkets.fun)** · Arc testnet

---

## The idea

Prediction markets are one of the better ways we have of turning scattered
opinion into a number you can act on. The problem has always been friction. Fees
make a small bet pointless, order books need someone willing to take the other
side, and signing up usually means owning a crypto wallet first.

Arc removes most of that. USDC is both the money and the gas, so the cost of a
transaction stops being the thing that decides whether a bet is worth placing. A
one dollar wager makes sense here in a way it doesn't elsewhere, and so does a
payment of a hundredth of a cent, which turned out to matter more than we
expected.

So we built the whole thing natively. Around eight thousand markets on crypto,
politics, geopolitics, sports and macro, priced by an automated market maker so
there is always a price and never a wait for a counterparty. You can sign in
with an email and a one time code rather than a wallet, place a bet, watch it in
your portfolio, and claim your winnings on chain once the market settles.

And if you would rather not watch the markets yourself, you can hand a budget to
the agent.

## The agent

Give it a budget and a risk profile and it works continuously. Each cycle it
looks at what is live, revisits what it already believes, studies the handful of
markets worth the attention, then either places a bet or writes down why it
didn't. You can also just talk to it, in which case it suggests a trade and
leaves the approval to you.

What we cared about most was making it trustworthy rather than merely busy.

Its risk limits live in ordinary code, not in a prompt. The model is allowed to
ask whether a trade would pass and to plan around the answer, but it cannot
raise a ceiling by arguing for one. A trade that fails the check simply does not
happen, however convincing the reasoning sounds. That distinction matters more
than it first appears: an agent that can talk itself past its own limits doesn't
really have limits.

It also keeps its work in the open. Every decision is stored with the
probability it estimated, how confident it was, what it read, and what it
concluded. That includes the refusals, which are the overwhelming majority, and
honestly they are the more interesting record. Anyone can read why the agent
decided to sit still.

There is one case where we stopped asking the model anything at all. Short
crypto rounds, the kind that ask whether Bitcoin will be higher fifteen minutes
from now, are not a research problem. Ours would answer "no idea" on every one
of them, which was true and also useless. But the question only looks
unanswerable. The starting price is recorded in the market itself, the current
price is a public number, and the time remaining is arithmetic. Put those
together with how much the asset has actually been moving and you get a real
probability instead of a guess. Those trades need no model call at all, which
has the pleasant side effect of working fine on days when an AI provider is
having problems.

## Built on Arc and Circle

| | |
| --- | --- |
| **Arc** | Everything runs here. USDC is both the settlement asset and the gas. |
| **USDC** | Bets, market liquidity, fees, and transaction costs. |
| **Circle Wallets** | Email and one time code sign in for people, plus managed wallets that let the agent trade without anyone holding its keys. |
| **Circle Nanopayments** | Sub cent payments, in both directions. |
| **Circle Gateway** | The rail those payments settle on. |

We left **Circle Paymaster** alone on purpose. It exists so people can pay gas
in USDC on chains where gas is something else, and on Arc gas already is USDC.
Adding it would have bought us a logo and a dependency, and nothing else.

## When the agent started paying for things

This began as an infrastructure problem rather than an ambition. The free
connections to Arc kept throttling the exact request that every market read
depends on, which quietly broke things at unhelpful moments. Premium access
existed, and it could be bought for a hundredth of a cent per request.

So now the agent buys it, by itself, when the free route stops cooperating. No
invoice, no subscription, nobody in the loop. It costs a fraction of a cent and
it fixed a real outage.

Having built that, the other direction was too obvious to skip. Our agent holds
a view on every market it has studied, and that view is worth something to
somebody else's agent. So there is an endpoint where another company's AI can
pay a hundredth of a cent to read it: the probability, the confidence, the
reasoning behind it. Money arriving from machines rather than people.

Each user's agent settles its own running costs from its own wallet over that
same rail. None of this is a mockup. Every payment described here is a real
settlement on Arc and can be checked on chain.

## Where it stands

| | |
| --- | --- |
| Markets created | **8,122**, of which 8,002 have settled |
| Decisions the agent recorded | **4,014** |
| Trades placed | **31** |
| USDC traded | **$12.23** |

The gap between four thousand decisions and thirty one trades isn't the agent
idling. It is the risk limits doing their job, and every refusal carries its
reason. The fuller picture, including the numbers that flatter us less, is in
[traction.md](traction.md), and the details of what we think is genuinely
unusual here are in [INNOVATION.md](INNOVATION.md).

## How it fits together

```
contracts/   the markets themselves, settling in USDC
web/         the site, and the services that keep markets running
agent/       the trading agent
```

Seven services run around the clock: the agent, the component that signs its
payments, an indexer that keeps the market catalogue quick, one service that
creates and settles the short crypto rounds and another that keeps them active,
a settler for markets mirrored from other venues, and an admin bot that can spin
up a new market from a chat message.

## Running it locally

```bash
cp .env.example .env        # add your keys, then fund the deployer at
                            # https://faucet.circle.com

cd contracts && forge install && forge test

cd ../web && npm install
npm run db:migrate
npm run dev                 # the site

cd ../agent && uv sync
uv run python loop.py       # a single agent pass; add --live to trade for real
```

## License

MIT.
