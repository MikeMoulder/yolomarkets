# YOLO Markets: where it actually stands

A factual snapshot taken from the production database and Arc testnet. Every
number here is reproducible with the query beside it. Where a figure is
unflattering it is stated anyway, because a scoreboard that only reports wins
is not a scoreboard.

---

## Platform

| Metric | Actual | Source |
| --- | --- | --- |
| Markets created | **8,125** | `select count(*) from market_index` |
| Markets settled | **8,005** | `... where resolved` |
| Markets open | 120 | the remainder |
| Chain | Arc testnet (5042002) | USDC is both settlement asset and gas |

Category mix:

| Category | Markets |
| --- | --- |
| Fast (short horizon crypto) | 8,005 |
| Other | 25 |
| Geopolitics | 20 |
| Politics | 19 |
| Crypto | 16 |
| Sports | 16 |
| Macro | 11 |
| Tech | 6 |

The catalogue is dominated by automated short horizon rounds. The editorial and
mirrored markets are the long tail. That is the honest shape of it.

## Agent

| Metric | Actual | Source |
| --- | --- | --- |
| Decisions recorded | **4,015** | `select count(*) from agent_decisions` |
| Trades placed | **32** | `... where action <> 'pass'` |
| Executed live on chain | **26** | `... and paper = false` |
| USDC traded | **$12.39** | `select sum(cost_usdc) ...` |
| Users the agent trades for | 3 | `count(distinct user_addr)` |
| Persistent market theses | 39 | `select count(*) from agent_theses` |
| Journal entries | 395 | `select count(*) from agent_journal` |

**Read this honestly.** Thirty two trades against four thousand decisions is a
pass rate above 99%. Two things drive it, and they are not the same thing.

The first is the risk gate working as designed. The most common recorded refusal
is confidence below threshold, which is the correct answer for a short horizon
market with no real signal, and every refusal carries its reason in
`pass_reason`.

The second is less flattering. For stretches of this period the AI provider was
unavailable, first on credit and then on a free tier daily quota, and an agent
that cannot form an estimate cannot trade. Both causes are visible in the data.

## Short horizon trading

Eighteen of the thirty two trades come from a deterministic pricing path added
recently, which prices short crypto rounds from live spot against the market's
recorded start price rather than asking a model to forecast them.

| Metric | Actual |
| --- | --- |
| Fast market trades | **18** |
| Settled record | **5 won, 1 lost** (83% of 6 settled) |

Six settled bets is a small sample and should be read as one. At the confidence
levels this path reports, you would expect to win most of them early, and the
meaningful test is dozens of rounds rather than six. What it does establish is
that the mechanism works end to end on chain.

One caveat stated plainly: the counterparty on these markets is the platform's
own seeded liquidity and market making service. The pricing model, execution and
settlement are all real, but profit here moves value between our own wallets. It
supports the claim that the agent trades continuously on a defensible signal. It
does not support a claim of alpha.

## Machine to machine payments

| Metric | Actual |
| --- | --- |
| Gateway balance funded | $10.00 deposited |
| Spent buying services | **$0.0587**, roughly 587 paid calls at $0.0001 |
| Remaining | $9.94, roughly 99,400 calls |
| What was bought | Premium Arc RPC access |
| Per user payment wallets | 3, each funded with a $0.50 Gateway balance |
| Insight API sales | Verified end to end with real settlement |

The selling side has been proven with real settlement, money leaving a Gateway
balance and arriving at the treasury. But the buyer in those tests was our own
wallet. There is no third party revenue yet. The plumbing is real; the market
for it is not.

## Circle products in use

| Product | Status | Evidence |
| --- | --- | --- |
| USDC on Arc | Core | Settlement, seeded liquidity, fees, and gas |
| Circle Wallets (managed) | Core | Agent execution, [agent/circle_wallets.py](agent/circle_wallets.py) |
| Circle Wallets (email sign in) | Onboarding | [web/components/wallet-modal.tsx](web/components/wallet-modal.tsx) |
| Circle Nanopayments | Both directions | [nanopay service](web/scripts/nanopay-service.ts), [insight API](web/app/api/x402/insight/route.ts) |
| Circle Gateway | Via Nanopayments | Arc testnet |
| Circle Paymaster | Not applicable | Arc gas is already USDC, see INNOVATION.md |
| CCTP, App Kits, StableFX | Not used | Out of scope for a single chain product |

## Live infrastructure

Seven services run continuously:

| Service | Role |
| --- | --- |
| `yolo-agent` | The trading agent |
| `yolo-nanopay` | Signs and meters machine to machine payments |
| `yolo-catalog-indexer` | Keeps the market catalogue fast |
| `yolo-fast-markets` | Creates and settles short horizon rounds |
| `yolo-fast-swarm` | Provides activity on those rounds |
| `yolo-polymarket-resolver` | Settles mirrored markets |
| `yolo-telegram-bot` | Admin command centre, authors markets from chat |

## Reproducing these numbers

```sh
psql $DATABASE_URL -c "select count(*), count(*) filter (where resolved)
                       from market_index"
psql $DATABASE_URL -c "select count(*),
                              count(*) filter (where action <> 'pass'),
                              coalesce(sum(cost_usdc), 0)
                       from agent_decisions"
curl -s 127.0.0.1:8090/balance
```
