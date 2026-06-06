#requires -Version 5.1
<#
.SYNOPSIS
    Bulk-wrap top-volume Polymarket binary events into native YOLO markets on Arc.

.DESCRIPTION
    Pulls the live Polymarket Gamma catalog, expands group events into individual
    binary markets, dedupes against MarketFactory.allMarkets(), and calls
    createMarket(...) once per chosen market. Skips anything already on Arc.

    Cost (~at $0.50 seed):
      Seed liquidity:  $SeedUsdc * $Limit
      Gas (Arc):       ~0.02-0.04 USDC per createMarket  (negligible)

    LMSR math note:
      b = seed / ln(2)
      $0.50 seed → b ≈ 0.72 → marginal depth, OK for demo
      $1.00 seed → b ≈ 1.44 → comfortable
      $2.00 seed → b ≈ 2.89 → tradeable at real sizes
      Anything below $0.30 produces unusable depth.

.PARAMETER Limit
    Max number of new markets to wrap (skips already-wrapped questions).

.PARAMETER SeedUsdc
    USDC seed liquidity per market. Don't go below 0.30 — markets become unusable.

.PARAMETER DurationDays
    Days from now until the market deadline. Default 30.

.PARAMETER DryRun
    Plan only. Doesn't send any tx. Prints the list of markets that *would* be wrapped.

.EXAMPLE
    .\bulk-wrap.ps1 -DryRun
    .\bulk-wrap.ps1 -Limit 10 -SeedUsdc 0.50
#>

[CmdletBinding()]
param(
    [int]$Limit = 10,
    [decimal]$SeedUsdc = 0.50,
    [int]$DurationDays = 30,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.foundry\bin;" + $env:Path

# Load repo .env
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
Get-Content $envPath | Where-Object { $_ -match "^([A-Z_]+)=(.+)$" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
}

$rpc      = $env:ARC_TESTNET_RPC_URL
$pk       = $env:DEPLOYER_PRIVATE_KEY
$usdc     = $env:USDC_ADDRESS
$deployer = $env:DEPLOYER_ADDRESS
$factory  = "0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA"

if ($SeedUsdc -lt 0.30 -and -not $DryRun) {
    Write-Host "Refusing seed < 0.30 USDC. Markets would be unusable (LMSR b too small)." -ForegroundColor Red
    Write-Host "Pass -DryRun to preview, or use -SeedUsdc 0.30 or higher." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor DarkGray
Write-Host "  YOLO Markets · bulk-wrap" -ForegroundColor White
Write-Host "  Limit:       $Limit"
Write-Host "  Seed/market: $SeedUsdc USDC   (b ~= $([Math]::Round($SeedUsdc / 0.693147, 3)))"
Write-Host "  Duration:    $DurationDays days"
Write-Host "  Mode:        $(if ($DryRun) { 'DRY RUN — no tx' } else { 'LIVE — broadcasts to Arc' })"
Write-Host "================================================================" -ForegroundColor DarkGray

# ── 1. Read bankroll ────────────────────────────────────────────────────────
$balRaw = cast call --rpc-url $rpc $usdc "balanceOf(address)(uint256)" $deployer
$balMicro = [decimal]($balRaw -split " ")[0]
$balUsdc = $balMicro / 1000000
Write-Host ""
Write-Host "Bankroll: $balUsdc USDC ($deployer)" -ForegroundColor Cyan

$needed = $SeedUsdc * $Limit
if (-not $DryRun -and $balUsdc -lt $needed) {
    Write-Host "Insufficient. Need $needed USDC (= $SeedUsdc x $Limit). Have $balUsdc." -ForegroundColor Red
    Write-Host "Top up at https://faucet.circle.com and rerun." -ForegroundColor Yellow
    exit 1
}

# ── 2. Discover existing markets on Arc (for dedup) ─────────────────────────
Write-Host ""
Write-Host "Reading existing markets from factory..." -ForegroundColor DarkGray
$countRaw = cast call --rpc-url $rpc $factory "marketCount()(uint256)"
$count = [int]($countRaw -split " ")[0]
$existing = New-Object System.Collections.Generic.HashSet[string]
for ($i = 0; $i -lt $count; $i++) {
    $addrRaw = cast call --rpc-url $rpc $factory "markets(uint256)(address)" $i
    $addr = $addrRaw.Trim()
    $qRaw = cast call --rpc-url $rpc $addr "question()(string)"
    $q = $qRaw.Trim('"').Trim().ToLower()
    [void]$existing.Add($q)
}
Write-Host "  found $count existing markets on Arc" -ForegroundColor DarkGray

# ── 3. Fetch Polymarket Gamma catalog ───────────────────────────────────────
#    Use curl.exe — Cloudflare in front of Gamma forcibly closes Invoke-WebRequest
#    connections on large responses (works at limit=1, fails at limit=300).
#    curl is in PATH on Windows 11 by default. Retry up to 3 times.
Write-Host ""
Write-Host "Fetching Polymarket Gamma catalog (limit 300)..." -ForegroundColor DarkGray
$gamma = "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=volume24hr&ascending=false"

$tmp = [System.IO.Path]::GetTempFileName()
$raw = $null
$attempt = 0
while ($attempt -lt 3) {
    $attempt++
    & curl.exe -sS --max-time 60 -A "Mozilla/5.0" -o $tmp $gamma 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp) -and (Get-Item $tmp).Length -gt 1000) {
        try {
            $raw = (Get-Content $tmp -Raw -Encoding UTF8) | ConvertFrom-Json
            break
        } catch {
            Write-Host "  attempt ${attempt}: parse failed, retrying..." -ForegroundColor DarkYellow
        }
    } else {
        Write-Host "  attempt ${attempt}: HTTP failed (exit $LASTEXITCODE), retrying..." -ForegroundColor DarkYellow
    }
    Start-Sleep -Seconds ($attempt * 2)
}
Remove-Item $tmp -ErrorAction SilentlyContinue

if (-not $raw) {
    Write-Host "Polymarket Gamma unreachable after 3 attempts. Aborting." -ForegroundColor Red
    exit 1
}
Write-Host ("  fetched {0} events" -f $raw.Count) -ForegroundColor DarkGreen

# ── 4. Expand to binary candidates ──────────────────────────────────────────
#    Dedupe in two layers:
#      · `$seen` — exact title (kills literal duplicates across events)
#      · `$parentSeen` — at most one child per parent event, so we don't fill
#        the catalog with 8 World Cup sub-options at the expense of variety.
$candidates = New-Object System.Collections.ArrayList
$seen = New-Object System.Collections.Generic.HashSet[string]
$parentSeen = New-Object System.Collections.Generic.HashSet[string]
$categoryMap = @(
    @{ Label = "Politics";    Match = @("Politics","Trump","Elections","Election","Biden","Congress","Senate") }
    @{ Label = "Crypto";      Match = @("Crypto","Bitcoin","Ethereum","BTC","ETH","Solana","Memes") }
    @{ Label = "Sports";      Match = @("Sports","Soccer","Football","NBA","NFL","FIFA","Baseball","Hockey","Tennis","Boxing","UFC","MLB") }
    @{ Label = "Geopolitics"; Match = @("Geopolitics","Iran","China","Russia","Ukraine","War","Middle East","Israel") }
    @{ Label = "Tech";        Match = @("Tech","AI","OpenAI","ChatGPT","SpaceX","Apple") }
    @{ Label = "Macro";       Match = @("Macro","Economy","Fed","Inflation","Recession","Markets","Stocks","Interest Rates") }
    @{ Label = "Culture";     Match = @("Pop Culture","Movies","Music","Awards","Celebrity","Entertainment") }
    @{ Label = "Science";     Match = @("Science","Space","Climate","Health","Medicine") }
)

function Get-Category {
    param($tags)
    if (-not $tags) { return "Other" }
    $labels = $tags | ForEach-Object { $_.label } | Where-Object { $_ }
    foreach ($cat in $categoryMap) {
        foreach ($lbl in $labels) {
            if ($cat.Match -contains $lbl) { return $cat.Label }
        }
    }
    $fallback = $labels | Where-Object { $_ -notin @("Hide From New","All") } | Select-Object -First 1
    if ($fallback) { return $fallback } else { return "Other" }
}

foreach ($e in $raw) {
    if (-not $e.markets) { continue }
    $openMarkets = $e.markets | Where-Object { -not $_.closed }
    if (-not $openMarkets) { continue }
    $isGroup = ($openMarkets.Count -gt 1)
    $parentTitle = $e.title.Trim()
    $parentKey = $e.id
    $category = Get-Category $e.tags
    $description = ""
    if ($e.description) {
        $description = ($e.description -replace "\s+", " ").Trim()
        if ($description.Length -gt 480) { $description = $description.Substring(0, 480) + "…" }
    }

    # For multi-option group events, pick only the highest-24h-volume child.
    # Singles (markets.Count == 1) pass through unchanged.
    $marketsToWrap = if ($isGroup) {
        @($openMarkets | Sort-Object -Property @{
            Expression = {
                if ($null -eq $_.volume24hr) { 0.0 } else { [double]$_.volume24hr }
            }
            Descending = $true
        } | Select-Object -First 1)
    } else {
        @($openMarkets)
    }

    foreach ($m in $marketsToWrap) {
        # parse outcomePrices JSON string
        $prices = $null
        try { $prices = $m.outcomePrices | ConvertFrom-Json } catch { continue }
        if (-not $prices -or $prices.Count -lt 2) { continue }

        $childLabel = $m.groupItemTitle
        if (-not $childLabel) { $childLabel = $m.question }
        if (-not $childLabel) { continue }
        $childLabel = $childLabel.Trim()

        $title = $parentTitle
        if ($isGroup -and $childLabel) {
            $cNorm = $childLabel.ToLower()
            $pNorm = $parentTitle.ToLower()
            if ($cNorm -eq $pNorm) {
                $title = $parentTitle
            } elseif ($cNorm.Contains($pNorm)) {
                $title = $childLabel
            } elseif ($pNorm.Contains($cNorm)) {
                $title = $parentTitle
            } else {
                $title = "${parentTitle}: $childLabel"
            }
        }
        if ($title.Length -gt 500) { $title = $title.Substring(0, 500) }

        $key = $title.ToLower()
        if ($seen.Contains($key)) { continue }
        [void]$seen.Add($key)
        if ($parentSeen.Contains($parentKey)) { continue }
        [void]$parentSeen.Add($parentKey)

        if ($existing.Contains($key)) { continue }

        $vol = 0.0
        if ($m.volume24hr) { $vol = [double]$m.volume24hr }

        # Always use the canned criteria — Polymarket descriptions sometimes
        # embed quote chars that break PowerShell native-command argument parsing
        # when passed to `cast send`. See run output 2026-05-23 (5/25 failures
        # all with "encode length mismatch" because PS split the criteria mid-word).
        $criteria = "Resolves YES iff the underlying Polymarket binary market resolves YES per its official resolution criteria."

        [void]$candidates.Add([PSCustomObject]@{
            Title    = $title
            Category = $category
            Criteria = $criteria
            Volume   = $vol
            Slug     = $m.slug
        })
    }
}

# Sort by 24h volume, take top N
$plan = $candidates | Sort-Object -Property Volume -Descending | Select-Object -First $Limit
Write-Host ""
Write-Host "Plan: wrap $($plan.Count) market(s)" -ForegroundColor Cyan
Write-Host ""

$idx = 0
foreach ($p in $plan) {
    $idx++
    $vol = if ($p.Volume -ge 1000000) { "$" + ("{0:N1}M" -f ($p.Volume / 1000000)) }
           elseif ($p.Volume -ge 1000) { "$" + ("{0:N0}k" -f ($p.Volume / 1000)) }
           else { "$" + ("{0:N0}" -f $p.Volume) }
    $shortTitle = $p.Title
    if ($shortTitle.Length -gt 78) { $shortTitle = $shortTitle.Substring(0, 75) + "…" }
    Write-Host ("  [{0,2}] {1,-13} {2,-8}  {3}" -f $idx, "[$($p.Category)]", $vol, $shortTitle)
}

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run. Nothing broadcast." -ForegroundColor Yellow
    Write-Host "To execute: .\bulk-wrap.ps1 -Limit $Limit -SeedUsdc $SeedUsdc" -ForegroundColor Yellow
    exit 0
}

# ── 5. Approve factory once for the full envelope ───────────────────────────
$totalMicro = [int64]($SeedUsdc * $Limit * 1000000)
$seedMicro = [int]($SeedUsdc * 1000000)
$now = [int64][double]::Parse((Get-Date -UFormat %s))
$deadline = $now + ($DurationDays * 86400)

Write-Host ""
Write-Host "Approving factory for $($SeedUsdc * $Limit) USDC..." -ForegroundColor DarkGray
cast send --rpc-url $rpc --private-key $pk $usdc "approve(address,uint256)" $factory $totalMicro --json | Out-Null
Write-Host "  approved." -ForegroundColor DarkGreen

# ── 6. Loop createMarket per candidate ──────────────────────────────────────
$success = 0
$failed = @()
$idx = 0
foreach ($p in $plan) {
    $idx++
    $shortTitle = $p.Title
    if ($shortTitle.Length -gt 70) { $shortTitle = $shortTitle.Substring(0, 67) + "…" }
    Write-Host ""
    Write-Host ("  [{0,2}/{1,2}] {2}" -f $idx, $plan.Count, $shortTitle) -ForegroundColor White

    try {
        $txJson = cast send --rpc-url $rpc --private-key $pk $factory `
            "createMarket(string,string,string,uint256,uint256)" `
            $p.Title $p.Category $p.Criteria $deadline $seedMicro --json
        $tx = $txJson | ConvertFrom-Json
        if ($tx.status -eq "0x1") {
            Write-Host ("       tx: {0}  [OK]" -f $tx.transactionHash.Substring(0, 14)) -ForegroundColor DarkGreen
            $success++
        } else {
            Write-Host ("       tx: {0}  [REVERTED]" -f $tx.transactionHash.Substring(0, 14)) -ForegroundColor Yellow
            $failed += $p.Title
        }
    } catch {
        Write-Host ("       FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
        $failed += $p.Title
    }
}

# ── 7. Summary ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor DarkGray
Write-Host ("  wrapped:  {0} / {1}" -f $success, $plan.Count) -ForegroundColor Green
if ($failed.Count -gt 0) {
    Write-Host ("  failed:   {0}" -f $failed.Count) -ForegroundColor Yellow
    foreach ($f in $failed) {
        $short = if ($f.Length -gt 70) { $f.Substring(0, 67) + "…" } else { $f }
        Write-Host "    - $short" -ForegroundColor DarkYellow
    }
}

$finalCountRaw = cast call --rpc-url $rpc $factory "marketCount()(uint256)"
$finalCount = [int]($finalCountRaw -split " ")[0]
Write-Host ("  total on arc: {0}" -f $finalCount) -ForegroundColor Cyan
$balRawAfter = cast call --rpc-url $rpc $usdc "balanceOf(address)(uint256)" $deployer
$balAfter = [decimal](($balRawAfter -split " ")[0]) / 1000000
Write-Host ("  bankroll remaining: {0} USDC" -f $balAfter) -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor DarkGray
