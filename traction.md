# YOLO Markets — Traction

This file is the submission artifact for the **30% Traction** judging
criterion. It's a living scoreboard, updated daily from Day 11 (2026-05-31)
onward and frozen at submission time.

> **Status: pre-launch (Day 5 of 14).** Today is 2026-05-25; the
> distribution push starts Day 11. The numbers below are placeholders —
> update them as real signal lands. Keep the schema; never fudge the
> values.

---

## Headline numbers (update on Day 13)

| Metric | Target | Actual | Source |
| --- | --- | --- | --- |
| Wallets created (unique) | 25 | — | `select count(distinct user_addr) from agent_profiles` |
| Markets live | 9 | 1 | factory.allMarkets() + EURC standalone |
| Markets resolved | ≥ 1 | 0 | `factory.resolveMarket()` event |
| Trades executed | 100 | — | `select count(*) from agent_decisions where action != 'pass'` |
| USDC volume (gross) | $500 | — | `select sum(cost_usdc) from agent_decisions where action != 'pass'` |
| Agent decisions (incl. passes) | 200 | — | `select count(*) from agent_decisions` |
| Agent live calls | — | — | `select count(*) from agent_decisions where paper = false` |
| Agent accuracy (on resolved markets) | — | — | see "Accuracy" section below |

## Verticals shipped (RFB 03)

| Category | Markets |
| --- | --- |
| Crypto | 2 (ETH > 4000, BTC > 110k June 6) |
| Macro | 3 (June FOMC cut, May CPI > 3%, **EURC**: EUR/USD > 1.10) |
| Tech | 2 (GPT-6 by Oct, NVDA Q1 beat) |
| Sports | 2 (Lakers playoffs, Finals in ≤6 games) |
| Politics | 1 (Trump-Xi summit by Aug) |

Multi-currency settlement: 1 EURC-denominated market live alongside USDC.

## Distribution channels (update Day 11–13)

| Channel | Action | Reach | Wallets generated |
| --- | --- | --- | --- |
| Twitter / X (founder account) | Launch thread + agent-trade GIF | — | — |
| Arc Discord — builders channel | Post + live-trade screenshot | — | — |
| Farcaster | Cast with frame (stretch) | — | — |
| Friend DMs | 20 personalised messages | — | — |

## Circle product usage (RFB scoring evidence)

| Product | Status | Evidence |
| --- | --- | --- |
| Circle USDC on Arc | ✅ Settlement asset | All USDC markets settle in 6-dec USDC; native gas in 18-dec USDC |
| Circle EURC on Arc | ✅ Multi-currency demo | 1 standalone PredictionMarket settling in EURC |
| Circle User-Controlled Wallets | 🟡 Server-side wired | `/api/circle/init` + `/api/circle/wallet`; client UI pending |
| Circle Gas Station | 🟡 Helper wired | `sponsorContractCall()` in [web/lib/circle.ts](web/lib/circle.ts); Console policy active |
| Circle Paymaster | ❌ Not applicable | Paymaster doesn't support Arc — Gas Station is the equivalent |
| USYC | ❌ Mock only | Institutional KYB-gated; mock yield panel labelled in UI |

## Agent decisions log

The agent runs continuously from Day 9 onward against the seeded markets.
Every decision — buy, sell, or pass — lands in `agent_decisions` with the
full Claude tool trace ([web/app/agent/page.tsx](web/app/agent/page.tsx)).

Snapshot queries judges can run themselves once they have the DB URL:

```sql
-- Decisions per day
select date_trunc('day', ts) as day, count(*), 
       count(*) filter (where action = 'buy_yes') as yes,
       count(*) filter (where action = 'buy_no')  as no,
       count(*) filter (where action = 'pass')    as pass
from agent_decisions
group by 1 order by 1 desc;

-- Agent accuracy on resolved markets (fill in once markets resolve)
select market, question, action, ai_prob, market_prob, edge_pts,
       (case when ...) as correct
from agent_decisions where resolved...;
```

## Accuracy (update once markets resolve)

For each market that resolves before submission:

| Market | Outcome | Agent's last estimate | Correct? |
| --- | --- | --- | --- |
| _(BTC > 110k Jun 6)_ | _pending_ | — | — |
| _(May CPI > 3%)_ | _pending_ | — | — |
| _(NVDA Q1 beat)_ | _pending_ | — | — |

Hit rate := (correct calls) / (total resolved markets where agent took a
non-pass position). Lower bound for credibility: 60% on ≥ 3 resolved
markets.

---

## How to regenerate this file

```sh
cd web
npm run db:studio  # Drizzle Studio — manual review
# or: psql $DATABASE_URL -f ../scripts/traction-snapshot.sql
```

(`scripts/traction-snapshot.sql` is TODO — it runs the SELECTs above and
emits markdown. Cheap script, write Day 11.)
