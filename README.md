# YOLO Markets

A prediction market platform on **Arc testnet** with an embedded AI agent
that trades autonomously on behalf of users.

> **Status:** Core MVP shipped on Arc testnet (contracts + web + autonomous agent); hardening and polish in progress.
> Full design in [idea.md](idea.md). Agent/repo guidance in [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
# 1. Tooling (one-time)
winget install astral-sh.uv                   # uv (Python package manager)
uv tool install git+https://github.com/the-canteen-dev/ARC-cli
arc-canteen login                             # GitHub device flow
arc-canteen context sync                      # pulls Arc + Circle docs locally

# Foundry (Windows): download foundry_v*_win32_amd64.zip from
# https://github.com/foundry-rs/foundry/releases and extract to ~/.foundry/bin

# 2. Env
cp .env.example .env
# Fill DEPLOYER_PRIVATE_KEY (create with: cast wallet new)
# Fund DEPLOYER_ADDRESS from https://faucet.circle.com (Arc Testnet → USDC)

# 3. Contracts
cd contracts
forge install                                 # pulls submodules
forge test
forge script script/Deploy.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

## Architecture (TL;DR)

- **contracts/** — `PredictionMarket.sol` (LMSR AMM) + `MarketFactory.sol`,
  settling in USDC on Arc.
- **web/** — Next.js 15 frontend: market browser, bet UI, portfolio, agent toggle.
- **agent/** — Python FastAPI service running the autonomous trading loop
  (Polymarket Gamma → Claude → Kelly-sized bet → on-chain execute).
- **api/** — Node gateway between frontend and agent/contracts.

## License

MIT.
