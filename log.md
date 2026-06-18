# YOLO agent — trading smoke test

- Run: `20260617T201051Z` (UTC)
- Chain: Arc testnet `5042002`
- Market: `0x5ABE0088A188326de5a1ac15950B924D1F779e49`
  - Will ETH be UP in the next 15m? (Start: $1734.72)
  - YES price 0.616, liquidity $10.84
- **Overall: ✅ PASS**

## Stage 0 — preflight

| check | result | detail |
| --- | --- | --- |
| rpc | ✅ | chainId=5042002 |
| deployer | ✅ | 0xdfB1E9b15e93824dAD19C0E8Bf06a1b28DcEb901 balance $1474.16 |
| circle creds | ✅ | API key / entity secret / wallet set present |
| postgres | ✅ | connection OK |
| markets | ✅ | 2869 total / 106 active / 2755 resolved |

## Per-tier pipeline (A–G)

| tier | A | B | C | D | E | F | G | wallet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **free** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `0x49d48011693364c1bd155c0c783f49ffee8cfdc5` |
| **pro** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `0x315f63cd1bd57135f1e6ca4cee5793f75fb8095f` |
| **plus** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `0x580a5deb46dd09edb52a02467eb8f99d0d7cdd26` |

### tier `free` — 0x000000000000000000000000000000000000FEE1

- ✅ **A subscription** — stored & read back tier=free
- ✅ **B credits** — balance 100→99 (cost 1/run, refill cap 100)
- ✅ **C entitlements** — max_trade=$1 daily=5 cadence=240m model=gemini-3.1-flash-lite
- ✅ **D live gate** — live_trading=True can_trade_live=True
- ✅ **E policy clamp** — $100 bet → $1.00 (tier cap $1)
- ✅ **F brain** — gemini-3.1-flash-lite: p=0.50 conf=0.10
- ✅ **G execution** — buy $0.4109 → 0.6494 YES shares | fee $0.0100→treasury | buy_tx=0x3c77b6433bb3…
- buy tx: `0x3c77b6433bb3b8b322cd39a5a4f30a368562091fd26346ce91bde71d788b6b4e`

### tier `pro` — 0x000000000000000000000000000000000000fEE2

- ✅ **A subscription** — stored & read back tier=pro
- ✅ **B credits** — balance 200→199 (cost 1/run, refill cap 200)
- ✅ **C entitlements** — max_trade=$5 daily=10 cadence=60m model=gemini-3-flash-preview
- ✅ **D live gate** — live_trading=True can_trade_live=True
- ✅ **E policy clamp** — $100 bet → $5.00 (tier cap $5)
- ✅ **F brain** — gemini-3-flash-preview: p=0.50 conf=0.01
- ✅ **G execution** — buy $0.4729 → 0.6494 YES shares | fee $0.0100→treasury | buy_tx=0xd5080df0618d…
- buy tx: `0xd5080df0618d0b323011aa0d81021822ab94cafe5e363d690956521c89eb4b9b`

### tier `plus` — 0x000000000000000000000000000000000000fEE3

- ✅ **A subscription** — stored & read back tier=plus
- ✅ **B credits** — balance 500→499 (cost 1/run, refill cap 500)
- ✅ **C entitlements** — max_trade=$25 daily=20 cadence=15m model=gemini-3-flash-preview
- ✅ **D live gate** — live_trading=True can_trade_live=True
- ✅ **E policy clamp** — $100 bet → $25.00 (tier cap $25)
- ✅ **F brain** — gemini-3-flash-preview: p=0.50 conf=0.10
- ✅ **G execution** — buy $0.4845 → 0.6494 YES shares | fee $0.0100→treasury | buy_tx=0x303c0e39da6c…
- buy tx: `0x303c0e39da6c3247c074db7b4c583bf79e5a126e7563505e833f4ed406db369b`

