# Deploy one standalone PredictionMarket settling in EURC.
#
# Why standalone (no factory)? The deployed MarketFactory at
# 0x1BED285DfD8C52e837A87681b73506B2301F7441 is bound to USDC by its
# immutable constructor argument. Re-deploying the factory just for one
# EURC market is overkill — and a second factory would fragment the
# `allMarkets()` set the agent's loop discovers from. Standalone is the
# right answer for the hackathon: it demonstrates RFB-03's multi-currency
# settlement requirement without complicating the agent's discovery path.
#
# The web UI surfaces this address explicitly so visitors can see the
# multi-currency story (USDC + EURC settlement on the same protocol).

$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.foundry\bin;" + $env:Path

# Load .env from repo root
Get-Content "..\.env" | Where-Object { $_ -match "^([A-Z_]+)=(.+)$" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
}

# Swap USDC for EURC for the duration of this run only — the existing
# DeployPredictionMarket.s.sol reads USDC_ADDRESS from env, so we just
# point it at the EURC token. EURC is also a Circle stablecoin (6-dec
# ERC-20 on Arc), so the contract math is identical.
$EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"
$env:USDC_ADDRESS = $EURC
$env:MARKET_SEED_USDC = "5000000"  # 5 EURC (6-dec)
$env:MARKET_HORIZON_SECONDS = "1209600"  # 14 days
$env:MARKET_QUESTION = "Will EUR/USD trade above 1.10 on the close of June 13, 2026?"
$env:MARKET_CATEGORY = "Macro"
$env:MARKET_RESOLUTION = "Resolves YES if the ECB reference EUR/USD rate published on 2026-06-13 is strictly greater than 1.10."

Write-Host "Deploying EURC-settled market…" -ForegroundColor Cyan
Write-Host "  token:    $EURC (EURC)" -ForegroundColor DarkGray
Write-Host "  seed:     5 EURC" -ForegroundColor DarkGray
Write-Host "  horizon:  14 days" -ForegroundColor DarkGray
Write-Host "  question: $env:MARKET_QUESTION" -ForegroundColor DarkGray
Write-Host ""

# Step 1: approve the predicted address. For an EOA-deployed contract, the
# address is deterministic from (deployer, nonce). We approve nonce+1 (the
# next deploy tx) for the seed amount before invoking forge create.
$rpc = $env:ARC_TESTNET_RPC_URL
$pk = $env:DEPLOYER_PRIVATE_KEY
$deployer = $env:DEPLOYER_ADDRESS
$nonce = [int](cast nonce --rpc-url $rpc $deployer)
$predicted = cast compute-address --rpc-url $rpc --nonce ($nonce + 1) $deployer | Select-String -Pattern "0x[0-9a-fA-F]{40}" | ForEach-Object { $_.Matches[0].Value }
Write-Host "predicted market address (nonce $($nonce + 1)): $predicted" -ForegroundColor DarkGray

Write-Host "approving $predicted for 5 EURC…"
cast send --rpc-url $rpc --private-key $pk $EURC `
    "approve(address,uint256)" $predicted 5000000 | Out-Null

# Step 2: deterministic deadline computed Solidity-side from block.timestamp
# in the constructor. forge create + constructor-args, paying gas in USDC.
$deadline = [int][double]::Parse((Get-Date -UFormat %s)) + 1209600  # +14d
Write-Host "deploying…"
$out = forge create --rpc-url $rpc --private-key $pk `
    contracts/src/PredictionMarket.sol:PredictionMarket `
    --constructor-args $EURC $deployer $deadline 5000000 `
    "`"$env:MARKET_QUESTION`"" `
    "`"$env:MARKET_CATEGORY`"" `
    "`"$env:MARKET_RESOLUTION`"" `
    --broadcast 2>&1

Write-Host $out
Write-Host ""
Write-Host "Done. Add the deployed address to:" -ForegroundColor Green
Write-Host "  - CLAUDE.md → Deployed addresses table" -ForegroundColor DarkGray
Write-Host "  - web/lib/markets.ts (or equivalent) so the UI surfaces it" -ForegroundColor DarkGray
