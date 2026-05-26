# Seed a handful of varied markets onto the deployed MarketFactory.
# Idempotent-ish: createMarket() uses CREATE2 with keccak(question, deadline)
# as salt, so re-running will revert on collision (which is fine — we just
# skip).

$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.foundry\bin;" + $env:Path

# Load .env from repo root
Get-Content "..\.env" | Where-Object { $_ -match "^([A-Z_]+)=(.+)$" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
}

$rpc = $env:ARC_TESTNET_RPC_URL
$pk = $env:DEPLOYER_PRIVATE_KEY
$factory = "0x1BED285DfD8C52e837A87681b73506B2301F7441"
$usdc = $env:USDC_ADDRESS

# Per-market seed amount, 6-dec USDC.
$seed = 1000000  # $1 USDC

# Total approval (over-approve to cover all in one tx)
$approveAmt = 10000000  # $10 USDC headroom

$now = [int][double]::Parse((Get-Date -UFormat %s))

# 8 markets across 5 verticals (RFB 03). Mix of near-term resolutions
# (resolve before submission 2026-06-03) and longer-horizon ones so the
# agent has variety to reason about during the demo window.
$markets = @(
    # ── Macro ──────────────────────────────────────────────────────────
    @{
        category = "Macro"
        question = "Will the Fed cut rates at the June 2026 FOMC meeting?"
        criteria = "Resolves YES if the FOMC announces a cut to the federal funds target rate at its June 17-18, 2026 meeting, per the official FOMC statement."
        days     = 25
    },
    @{
        category = "Macro"
        question = "Will May 2026 US CPI YoY print above 3.0%?"
        criteria = "Resolves YES if the headline CPI YoY figure released by the BLS for May 2026 (expected mid-June 2026) is strictly greater than 3.0%."
        days     = 22
    },
    # ── Crypto ─────────────────────────────────────────────────────────
    @{
        category = "Crypto"
        question = "Will BTC close above 110,000 USD on June 6, 2026?"
        criteria = "Resolves YES if BTC/USD per the Coinbase Spot index closes >= 110,000 USD at 4pm ET on 2026-06-06."
        days     = 13
    },
    # ── Tech ───────────────────────────────────────────────────────────
    @{
        category = "Tech"
        question = "Will OpenAI release GPT-6 before October 1, 2026?"
        criteria = "Resolves YES if OpenAI publicly announces and makes available a model branded GPT-6 (or 6.0) before 2026-10-01 00:00 UTC."
        days     = 90
    },
    @{
        category = "Tech"
        question = "Will NVIDIA's Q1 FY2027 earnings beat the consensus EPS estimate?"
        criteria = "Resolves YES if NVIDIA's reported non-GAAP EPS for the fiscal quarter ending May 2026 (released ~late May 2026) exceeds the Refinitiv consensus estimate at the time of release."
        days     = 9
    },
    # ── Sports ─────────────────────────────────────────────────────────
    @{
        category = "Sports"
        question = "Will the Los Angeles Lakers make the 2026 NBA playoffs?"
        criteria = "Resolves YES if the Lakers qualify for the 2025-26 NBA postseason (via direct seeding or play-in tournament victory)."
        days     = 21
    },
    @{
        category = "Sports"
        question = "Will the team that wins the 2026 NBA Finals do so in 6 games or fewer?"
        criteria = "Resolves YES if the winning team of the 2026 NBA Finals series wins in 4, 5, or 6 total games."
        days     = 45
    },
    # ── Politics / Geopolitical ────────────────────────────────────────
    @{
        category = "Politics"
        question = "Will Donald Trump and Xi Jinping hold an in-person summit before August 2026?"
        criteria = "Resolves YES if a bilateral in-person meeting between Trump and Xi as sitting heads of state occurs before 2026-08-01."
        days     = 60
    }
)

Write-Host "Approving factory for $approveAmt micro-USDC..."
cast send --rpc-url $rpc --private-key $pk $usdc "approve(address,uint256)" $factory $approveAmt --json | Out-Null

foreach ($m in $markets) {
    $deadline = $now + ($m.days * 86400)
    Write-Host ""
    Write-Host "→ [$($m.category)] $($m.question)"
    Write-Host "   deadline=$deadline ($($m.days) days), seed=$seed micro-USDC"
    try {
        $tx = cast send --rpc-url $rpc --private-key $pk $factory `
            "createMarket(string,string,string,uint256,uint256)" `
            $m.question $m.category $m.criteria $deadline $seed --json `
        | ConvertFrom-Json
        Write-Host "   tx: $($tx.transactionHash)  status: $($tx.status)" -ForegroundColor Green
    }
    catch {
        Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Done. Verifying factory state..."
$count = cast call --rpc-url $rpc $factory "marketCount()(uint256)"
Write-Host "marketCount: $count"
$all = cast call --rpc-url $rpc $factory "allMarkets()(address[])"
Write-Host "addresses: $all"
