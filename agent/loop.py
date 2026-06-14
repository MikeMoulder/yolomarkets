"""YOLO Markets autonomous trading agent — one pass over all live markets.

Pipeline per market:
    1. Read on-chain state (question, category, price, deadline, my position)
    2. Best-effort fuzzy match to a Polymarket Gamma market for a crowd prior
    3. Ask the LLM (Gemini by default, OpenRouter fallback) for a calibrated probability
    4. Compute edge & Kelly fraction (fractional by risk profile)
    5. If edge >= threshold AND confidence high enough, decide buy YES/NO
    6. Paper-trade by default. `--live` actually broadcasts the buy.
    7. Append a structured decision record to decisions.jsonl for the UI

Usage:
    uv run python loop.py                  # paper trade (default)
    uv run python loop.py --live           # broadcast buys on Arc
    uv run python loop.py --risk moderate  # ¼ kelly, ½ kelly, full kelly
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

from curl_cffi import requests as cffi_requests
from dotenv import load_dotenv
from openai import OpenAI
from rich.console import Console
from rich.table import Table
from web3 import Web3
from web3.exceptions import ContractLogicError

from profiles import (
    AgentProfile,
    is_runnable,
    load_profiles,
    matches_market,
)
from db import insert_decision, assert_schema_compatible
from policy import (
    PortfolioRiskManager,
    PortfolioSnapshot,
    PositionSnapshot,
    entitlements_for_tier,
    policy_for_profile,
    model_for_profile,
    risk_bucket,
    strategy_context,
)
from notifier import notify_decision
from credits import (
    maybe_refill_free_credits,
    ensure_credits_row,
    ensure_subscription_row,
    credit_cost_for_run,
    deduct_credits,
    can_trade_live,
    get_subscription_tier,
)
from circle_wallets import (
    get_wallet_usdc_balance,
    execute_contract_call,
    transfer_usdc,
    wait_for_transaction,
    compute_protocol_fee,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

console = Console()

# ── Contract addresses & ABIs ──────────────────────────────────────────────
FACTORY = Web3.to_checksum_address("0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA")
USDC = Web3.to_checksum_address("0x3600000000000000000000000000000000000000")

FACTORY_ABI = [
    {"type": "function", "name": "allMarkets", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address[]"}]},
]
AGENT_ACCOUNT_ABI = [
    {"type": "function", "name": "owner", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "execute", "stateMutability": "nonpayable",
     "inputs": [{"type": "address"}, {"type": "uint256"}, {"type": "bytes"}],
     "outputs": [{"type": "bytes"}]},
    {"type": "function", "name": "sessions", "stateMutability": "view",
     "inputs": [{"type": "address"}],
     "outputs": [
         {"name": "validUntil", "type": "uint64"},
         {"name": "totalCap", "type": "uint128"},
         {"name": "totalSpent", "type": "uint128"},
         {"name": "perCallCap", "type": "uint128"},
         {"name": "allowedTarget", "type": "address"},
         {"name": "allowedSelector", "type": "bytes4"},
     ]},
]
MARKET_ABI = [
    {"type": "function", "name": "question", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "category", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "resolutionCriteria", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "deadline", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "priceYes", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "int256"}]},
    {"type": "function", "name": "totalLiquidity", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "resolved", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "outcome", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint8"}]},
    {"type": "function", "name": "previewBuy", "stateMutability": "view",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "previewSell", "stateMutability": "view",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "buy", "stateMutability": "nonpayable",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sell", "stateMutability": "nonpayable",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "claim", "stateMutability": "nonpayable",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sharesYes", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sharesNo", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
]
USDC_ABI = [
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"type": "address"}, {"type": "address"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"type": "address"}, {"type": "uint256"}],
     "outputs": [{"type": "bool"}]},
]

# ── Risk profiles ──────────────────────────────────────────────────────────
RISK_PROFILES = {
    "conservative": {"kelly_mult": 0.25, "edge_threshold": 0.10, "min_confidence": 0.55},
    "moderate":     {"kelly_mult": 0.50, "edge_threshold": 0.07, "min_confidence": 0.45},
    "aggressive":   {"kelly_mult": 1.00, "edge_threshold": 0.05, "min_confidence": 0.35},
}
SLIPPAGE_BPS = 200            # 2%
MAX_POSITION_FRACTION = 0.30  # never bet more than 30% of bankroll on one market
PROTOCOL_FEE_BUFFER = 0.003

_LAST_RUN_BY_USER: dict[str, float] = {}

DECISIONS_PATH = REPO_ROOT / "agent" / "decisions.jsonl"


# ── Data shapes ────────────────────────────────────────────────────────────
@dataclass
class MarketState:
    address: str
    question: str
    category: str
    resolution_criteria: str
    deadline: int
    price_yes: float        # 0..1
    total_liquidity: float  # USDC
    resolved: bool


@dataclass
class Estimate:
    probability: float
    confidence: float
    reasoning: str
    key_sources: list[str]
    watch_for: list[str]
    time_sensitivity: Literal["low", "medium", "high"]
    polymarket_prob: float | None
    polymarket_slug: str | None


@dataclass
class Decision:
    ts: str
    market: str
    question: str
    category: str
    market_prob: float
    polymarket_prob: float | None
    polymarket_slug: str | None
    ai_prob: float
    ai_confidence: float
    edge_pts: float                     # AI - market, signed
    kelly_fraction: float
    bankroll_usdc: float
    action: Literal["pass", "buy_yes", "buy_no"]
    pass_reason: str | None
    shares: int                          # 6-dec
    cost_usdc: float
    max_cost_usdc: float
    tx_hash: str | None
    paper: bool
    reasoning: str
    watch_for: list[str]
    time_sensitivity: str
    # Phase 4 — when set, this decision was made on behalf of a specific
    # user via their AgentAccount + session key, not the dev demo runner.
    user_addr: str | None = None
    agent_addr: str | None = None
    # Phase 5 — populated only when the Claude tool-use brain produced this
    # decision. Legacy single-shot path leaves these at defaults. The web
    # /agent page renders them so judges can replay the reasoning.
    news_summary: str = ""
    tool_trace: list[dict] = field(default_factory=list)
    brain_model: str | None = None
    brain_iterations: int | None = None
    prompt_hash: str | None = None
    tools_called: list[str] = field(default_factory=list)
    external_odds_snapshot: dict[str, Any] = field(default_factory=dict)
    policy_snapshot: dict[str, Any] = field(default_factory=dict)
    platform_fee_usdc: float = 0.0
    notification_status: str | None = None


# ── Web3 helpers ───────────────────────────────────────────────────────────
def get_rpc_urls() -> list[str]:
    urls: list[str] = []
    for key in ("ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_URLS"):
        raw = os.environ.get(key, "")
        urls.extend(part.strip() for part in raw.split(",") if part.strip())

    seen: set[str] = set()
    return [url for url in urls if not (url in seen or seen.add(url))]


def get_web3() -> Web3:
    urls = get_rpc_urls()
    if not urls:
        raise RuntimeError("ARC_TESTNET_RPC_URL is not set")

    last_error: Exception | None = None
    for url in urls:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 10}))
            expected_chain_id = int(os.environ.get("ARC_TESTNET_CHAIN_ID", "5042002"))
            if w3.is_connected() and int(w3.eth.chain_id) == expected_chain_id:
                if url != urls[0]:
                    console.print(f"[yellow]Arc RPC fallback active:[/yellow] {url}")
                return w3
        except Exception as e:
            last_error = e

    if last_error:
        console.print(f"[red]Arc RPC check failed:[/red] {last_error}")
    return Web3(Web3.HTTPProvider(urls[-1], request_kwargs={"timeout": 10}))


def read_market_state(w3: Web3, addr: str) -> MarketState:
    c = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=MARKET_ABI)
    # Sequential because Arc RPC doesn't support multicall via web3.py easily
    # and the markets are small in number.
    question = c.functions.question().call()
    category = c.functions.category().call()
    criteria = c.functions.resolutionCriteria().call()
    deadline = c.functions.deadline().call()
    price_yes_raw = c.functions.priceYes().call()
    liq = c.functions.totalLiquidity().call()
    resolved = c.functions.resolved().call()
    return MarketState(
        address=Web3.to_checksum_address(addr),
        question=question,
        category=category,
        resolution_criteria=criteria,
        deadline=int(deadline),
        price_yes=int(price_yes_raw) / 1e18,
        total_liquidity=int(liq) / 1e6,
        resolved=bool(resolved),
    )


def read_position_snapshot(
    w3: Web3,
    market: MarketState,
    owner_addr: str | None,
) -> PositionSnapshot | None:
    if not owner_addr:
        return None
    c = w3.eth.contract(address=Web3.to_checksum_address(market.address), abi=MARKET_ABI)
    try:
        yes = int(c.functions.sharesYes(Web3.to_checksum_address(owner_addr)).call()) / 1e6
        no = int(c.functions.sharesNo(Web3.to_checksum_address(owner_addr)).call()) / 1e6
    except Exception:
        return None
    if yes <= 0 and no <= 0:
        return None
    return PositionSnapshot(
        market=market.address,
        question=market.question,
        category=market.category,
        bucket=risk_bucket(market.category, market.question),
        yes_shares=yes,
        no_shares=no,
        yes_price=market.price_yes,
    )


def build_portfolio_snapshot(
    w3: Web3,
    *,
    profile: AgentProfile,
    markets: list[MarketState],
    bankroll_usdc: float,
) -> PortfolioSnapshot:
    owner = profile.agent_address
    positions: list[PositionSnapshot] = []
    for m in markets:
        snap = read_position_snapshot(w3, m, owner)
        if snap is not None:
            positions.append(snap)
    return PortfolioSnapshot(bankroll_usdc=bankroll_usdc, positions=positions)


def claim_resolved_positions(
    w3: Web3,
    *,
    profile: AgentProfile,
    markets: list[MarketState],
    live: bool,
) -> int:
    """Claim resolved winning shares for Circle-backed agents.

    Legacy AgentAccount permissions are intentionally buy-scoped, so this only
    runs for Circle wallets where the runner can call `claim()` directly.
    """
    if not live or not profile.circle_wallet_id or not profile.agent_address:
        return 0

    claimed = 0
    owner = Web3.to_checksum_address(profile.agent_address)
    for m in markets:
        if not m.resolved:
            continue
        c = w3.eth.contract(address=Web3.to_checksum_address(m.address), abi=MARKET_ABI)
        try:
            outcome = int(c.functions.outcome().call())
            if outcome == 1:
                shares = int(c.functions.sharesYes(owner).call())
            elif outcome == 2:
                shares = int(c.functions.sharesNo(owner).call())
            else:
                continue
            if shares <= 0:
                continue

            tx_id = execute_contract_call(
                wallet_id=profile.circle_wallet_id,
                contract_address=m.address,
                abi_function_signature="claim()",
                abi_parameters=[],
                idempotency_key=f"claim-{m.address[:8]}-{int(time.time()) // 3600}",
            )
            on_chain_hash = wait_for_transaction(tx_id, max_wait=60.0)
            console.print(
                f"  [dim]claimed {shares/1e6:.2f} winning shares "
                f"from {m.address[:10]}… tx {on_chain_hash[:14]}…[/dim]"
            )
            claimed += 1
        except Exception as e:  # noqa: BLE001
            console.print(f"  [yellow]claim skipped for {m.address[:10]}…: {e}[/yellow]")
    return claimed


def discover_markets(w3: Web3) -> list[str]:
    factory = w3.eth.contract(address=FACTORY, abi=FACTORY_ABI)
    return factory.functions.allMarkets().call()


# ── Polymarket crowd signal ────────────────────────────────────────────────
def polymarket_match(question: str) -> tuple[float | None, str | None]:
    """Fuzzy-match against the top high-volume Polymarket markets.
    Returns (yes_price, slug) if match found, else (None, None)."""
    base = os.environ.get("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com")
    try:
        r = cffi_requests.get(
            f"{base}/markets",
            params={"active": "true", "closed": "false", "limit": "100",
                    "order": "volume24hr", "ascending": "false"},
            impersonate="chrome",
            timeout=20,
        )
        r.raise_for_status()
        markets = r.json()
    except Exception as e:
        console.print(f"[dim]polymarket fetch failed: {e}[/dim]")
        return (None, None)

    q_lower = question.lower()
    best_ratio = 0.0
    best_market = None
    for m in markets:
        if not m.get("question") or not m.get("outcomePrices"):
            continue
        ratio = SequenceMatcher(None, q_lower, m["question"].lower()).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_market = m

    if best_market is None or best_ratio < 0.55:
        return (None, None)

    try:
        prices = best_market["outcomePrices"]
        if isinstance(prices, str):
            prices = json.loads(prices)
        return (float(prices[0]), best_market.get("slug"))
    except (json.JSONDecodeError, IndexError, ValueError, TypeError):
        return (None, None)


# ── LLM estimate ───────────────────────────────────────────────────────────
SYSTEM = """You are a calibrated probability estimator for prediction markets.
Output STRICT JSON only — no prose. Reason from first principles; do NOT anchor
to the market price. When uncertain, lower your confidence score. Your output
is consumed programmatically; any deviation from the schema breaks it."""


def llm_estimate(m: MarketState, polymarket_prob: float | None,
                 polymarket_slug: str | None) -> Estimate | None:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return None
    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        default_headers={
            "HTTP-Referer": "https://github.com/yolo-markets",
            "X-Title": "YOLO Markets agent",
        },
    )

    pm_str = f"{polymarket_prob * 100:.1f}" if polymarket_prob is not None else "no match"
    deadline_str = datetime.fromtimestamp(m.deadline, tz=timezone.utc).isoformat()

    user = f"""MARKET: "{m.question}"
RESOLUTION CRITERIA: {m.resolution_criteria}
RESOLVES: {deadline_str}

CROWD SIGNALS:
  Our AMM YES price: {m.price_yes * 100:.1f}%
  Polymarket YES price (fuzzy match): {pm_str}%

OUTPUT FORMAT (strict JSON, no markdown fences):
{{
  "probability": 0.0,
  "confidence": 0.0,
  "reasoning": "3 to 5 sentences",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal 1", "signal 2"],
  "time_sensitivity": "low|medium|high"
}}"""

    try:
        # No `response_format` here: Perplexity (default) doesn't honour
        # json_object; strict-JSON is enforced in the prompt + the parser below.
        resp = client.chat.completions.create(
            model=os.environ.get("OPENROUTER_MODEL", "perplexity/sonar"),
            max_tokens=900,
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": user},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            text = text.split("\n", 1)[1] if "\n" in text else text
            if text.endswith("```"):
                text = text[:-3]
        payload = json.loads(text)

        # Perplexity (and OpenRouter `:online` plugins) return the URLs they
        # actually browsed in a separate field — merge them into key_sources
        # so we cite real evidence, not whatever the model imagined.
        raw_resp: dict[str, Any] = {}
        if hasattr(resp, "model_dump"):
            try:
                raw_resp = resp.model_dump()
            except Exception:
                raw_resp = {}
        live_citations = _extract_citations(raw_resp)
        if live_citations:
            existing = payload.get("key_sources") or []
            existing = [s for s in existing if isinstance(s, str)]
            seen: set[str] = set()
            merged: list[str] = []
            for src in [*live_citations, *existing]:
                if src and src not in seen:
                    seen.add(src)
                    merged.append(src)
            payload["key_sources"] = merged

        return Estimate(
            probability=float(payload["probability"]),
            confidence=float(payload["confidence"]),
            reasoning=str(payload.get("reasoning", "")),
            key_sources=list(payload.get("key_sources", [])),
            watch_for=list(payload.get("watch_for", [])),
            time_sensitivity=payload.get("time_sensitivity", "medium"),
            polymarket_prob=polymarket_prob,
            polymarket_slug=polymarket_slug,
        )
    except Exception as e:
        console.print(f"[red]llm error for {m.question[:40]}: {e}[/red]")
        return None


def _extract_citations(raw: dict[str, Any]) -> list[str]:
    """Pull URLs from the two shapes OpenRouter forwards: Perplexity's
    top-level `citations` list, and OpenAI-style `message.annotations`."""
    out: list[str] = []
    top = raw.get("citations") if isinstance(raw, dict) else None
    if isinstance(top, list):
        out.extend(c for c in top if isinstance(c, str))
    try:
        choice = (raw.get("choices") or [{}])[0]
        msg = (choice.get("message") or {}) if isinstance(choice, dict) else {}
        anns = msg.get("annotations") or []
        if isinstance(anns, list):
            for a in anns:
                if not isinstance(a, dict):
                    continue
                url = a.get("url") or (a.get("url_citation") or {}).get("url")
                if isinstance(url, str) and url:
                    out.append(url)
    except Exception:
        pass
    return out


# ── Kelly sizing ───────────────────────────────────────────────────────────
def kelly_fraction(p: float, price: float) -> float:
    """Fraction of bankroll to bet at price `price` if true prob is `p`.
    Standard binary Kelly: f* = p - (1-p) * price / (1 - price)
    Simplifies to: f* = (p - price) / (1 - price)
    Returns 0 if negative EV.
    """
    if price >= 0.99 or price <= 0.01:
        return 0.0
    f = (p - price) / (1.0 - price)
    return max(0.0, f)


# ── Decision logic ─────────────────────────────────────────────────────────
def decide(m: MarketState, est: Estimate, bankroll_usdc: float,
           risk: dict) -> Decision:
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    edge_pts = (est.probability - m.price_yes) * 100  # signed YES-side edge

    base = dict(
        ts=now_iso, market=m.address, question=m.question, category=m.category,
        market_prob=m.price_yes, polymarket_prob=est.polymarket_prob,
        polymarket_slug=est.polymarket_slug, ai_prob=est.probability,
        ai_confidence=est.confidence, edge_pts=edge_pts,
        bankroll_usdc=bankroll_usdc, reasoning=est.reasoning,
        watch_for=est.watch_for, time_sensitivity=est.time_sensitivity,
    )

    def make_pass(reason: str) -> Decision:
        return Decision(**base, kelly_fraction=0.0, action="pass",
                        pass_reason=reason, shares=0, cost_usdc=0.0,
                        max_cost_usdc=0.0, tx_hash=None, paper=True)

    if m.resolved:
        return make_pass("market already resolved")
    if est.confidence < risk["min_confidence"]:
        return make_pass(f"confidence {est.confidence:.0%} < {risk['min_confidence']:.0%}")

    abs_edge = abs(est.probability - m.price_yes)
    fee_buffer = PROTOCOL_FEE_BUFFER + float(risk.get("slippage_buffer_bps", 0)) / 10_000
    uncertainty_buffer = (1.0 - est.confidence) * float(
        risk.get("uncertainty_buffer_mult", 0.0)
    )
    required_edge = (
        risk["edge_threshold"]
        + fee_buffer
        + float(risk.get("extra_edge_buffer", 0.0))
        + uncertainty_buffer
    )
    if abs_edge < required_edge:
        return make_pass(
            "net edge "
            f"{abs_edge*100:.1f}pt < required {required_edge*100:.1f}pt "
            f"(fees/slippage/uncertainty included)"
        )

    # Pick a side
    if est.probability > m.price_yes:
        side_name = "buy_yes"
        side_id = 1
        side_price = m.price_yes
        p = est.probability
    else:
        side_name = "buy_no"
        side_id = 2
        side_price = 1 - m.price_yes
        p = 1 - est.probability

    f_star = kelly_fraction(p, side_price) * risk["kelly_mult"]
    f_capped = min(f_star, MAX_POSITION_FRACTION)
    bet_usd = f_capped * bankroll_usdc

    if bet_usd < 0.10:  # below $0.10, not worth the gas
        return Decision(**base, kelly_fraction=f_star, action="pass",
                        pass_reason="bet size < $0.10", shares=0,
                        cost_usdc=0.0, max_cost_usdc=0.0, tx_hash=None,
                        paper=True)

    shares = int(bet_usd / side_price * 1e6)  # 6-dec
    return Decision(**base, kelly_fraction=f_star, action=side_name,  # type: ignore[arg-type]
                    pass_reason=None, shares=shares, cost_usdc=bet_usd,
                    max_cost_usdc=0.0, tx_hash=None, paper=True)


def apply_contract_preview_pricing(w3: Web3, m: MarketState, decision: Decision) -> None:
    """Use the LMSR contract preview as the source of truth before risk gates.

    `decide()` sizes from spot odds, which is intentionally cheap and fast.
    The AMM curve can make the real cost higher for larger orders, so this
    function shrinks shares to fit the intended spend and records the actual
    preview cost even for paper decisions.
    """
    if decision.action not in ("buy_yes", "buy_no") or decision.shares <= 0:
        return
    side_id = 1 if decision.action == "buy_yes" else 2
    market_contract = w3.eth.contract(
        address=Web3.to_checksum_address(m.address), abi=MARKET_ABI
    )
    target_usdc = max(float(decision.cost_usdc), 0.0)
    preview = int(market_contract.functions.previewBuy(side_id, decision.shares).call())
    preview_usdc = preview / 1e6

    if target_usdc > 0 and preview_usdc > target_usdc:
        ratio = max(0.0, min(1.0, target_usdc / preview_usdc))
        decision.shares = int(decision.shares * ratio)
        if decision.shares <= 0:
            decision.action = "pass"
            decision.pass_reason = "contract preview reduced shares to zero"
            decision.cost_usdc = 0.0
            decision.max_cost_usdc = 0.0
            return
        preview = int(market_contract.functions.previewBuy(side_id, decision.shares).call())
        preview_usdc = preview / 1e6

    max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
    decision.cost_usdc = preview_usdc
    decision.max_cost_usdc = max_cost / 1e6


def policy_pass(
    m: MarketState,
    *,
    bankroll_usdc: float,
    reason: str,
    user_addr: str | None,
    agent_addr: str | None,
    policy_snapshot: dict[str, Any],
) -> Decision:
    return Decision(
        ts=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        market=m.address,
        question=m.question,
        category=m.category,
        market_prob=m.price_yes,
        polymarket_prob=None,
        polymarket_slug=None,
        ai_prob=m.price_yes,
        ai_confidence=0.0,
        edge_pts=0.0,
        kelly_fraction=0.0,
        bankroll_usdc=bankroll_usdc,
        action="pass",
        pass_reason=reason,
        shares=0,
        cost_usdc=0.0,
        max_cost_usdc=0.0,
        tx_hash=None,
        paper=True,
        reasoning=f"Policy gate passed before model spend: {reason}.",
        watch_for=[],
        time_sensitivity="low",
        user_addr=user_addr,
        agent_addr=agent_addr,
        policy_snapshot=policy_snapshot,
    )


# ── On-chain execution ─────────────────────────────────────────────────────
def execute_buy(w3: Web3, account, market_addr: str, side_id: int,
                shares: int, max_cost_micro: int) -> str:
    """LEGACY path — broadcast approve + buy from `account` directly.
    Used by --legacy mode where the dev EOA trades from its own wallet."""
    market = w3.eth.contract(address=Web3.to_checksum_address(market_addr),
                              abi=MARKET_ABI)
    usdc = w3.eth.contract(address=USDC, abi=USDC_ABI)

    current_allowance = usdc.functions.allowance(account.address,
                                                  market_addr).call()
    if current_allowance < max_cost_micro:
        tx = usdc.functions.approve(market_addr, max_cost_micro).build_transaction({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gasPrice": w3.eth.gas_price,
            "gas": 100_000,
        })
        signed = account.sign_transaction(tx)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        w3.eth.wait_for_transaction_receipt(h)

    tx = market.functions.buy(side_id, shares, max_cost_micro).build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gasPrice": w3.eth.gas_price,
        "gas": 500_000,
    })
    signed = account.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(h)
    if receipt.status != 1:
        raise RuntimeError("buy reverted")
    return h.hex()


def execute_buy_via_agent(
    w3: Web3,
    session_account,
    agent_addr: str,
    market_addr: str,
    side_id: int,
    shares: int,
    max_cost_micro: int,
) -> str:
    """PHASE-4 path — call AgentAccount.execute(market, 0, buy_calldata)
    signed by the off-chain session key. The AgentAccount auto-approves
    USDC for the market before forwarding the buy."""
    agent = w3.eth.contract(
        address=Web3.to_checksum_address(agent_addr), abi=AGENT_ACCOUNT_ABI
    )
    market = w3.eth.contract(
        address=Web3.to_checksum_address(market_addr), abi=MARKET_ABI
    )

    buy_calldata = market.encode_abi("buy", args=[side_id, shares, max_cost_micro])

    tx = agent.functions.execute(
        Web3.to_checksum_address(market_addr), 0, buy_calldata
    ).build_transaction({
        "from": session_account.address,
        "nonce": w3.eth.get_transaction_count(session_account.address),
        "gasPrice": w3.eth.gas_price,
        "gas": 700_000,
    })
    signed = session_account.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(h)
    if receipt.status != 1:
        raise RuntimeError("execute reverted")
    return h.hex()


# ── Logging ────────────────────────────────────────────────────────────────
def append_decision(d: Decision) -> None:
    """Persist a decision to Postgres (agent_decisions). On DB failure,
    fall back to the legacy JSONL file so we don't drop the call entirely
    (file lives at agent/decisions.jsonl, kept for emergency dump only)."""
    try:
        insert_decision(d)
    except Exception as e:
        console.print(f"[red]DB write failed, falling back to JSONL: {e}[/red]")
        DECISIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with DECISIONS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(d)) + "\n")


def drain_pending_jsonl() -> None:
    """If a previous run left rows in decisions.jsonl (DB was unreachable),
    push them into Postgres now and truncate the file. Idempotent — failures
    leave the JSONL intact so we can retry next startup."""
    if not DECISIONS_PATH.exists():
        return
    try:
        lines = DECISIONS_PATH.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        console.print(f"[dim]jsonl drain: read failed: {e}[/dim]")
        return
    pending = [ln for ln in lines if ln.strip()]
    if not pending:
        return

    console.print(f"[dim]draining {len(pending)} pending decision(s) from jsonl…[/dim]")
    drained = 0
    leftovers: list[str] = []
    for ln in pending:
        try:
            row = json.loads(ln)
            insert_decision(row)
            drained += 1
        except Exception as e:
            console.print(f"[red]jsonl drain: row failed ({e}), keeping[/red]")
            leftovers.append(ln)

    # Rewrite (or unlink) so we don't re-import what we just drained.
    try:
        if leftovers:
            DECISIONS_PATH.write_text("\n".join(leftovers) + "\n", encoding="utf-8")
        else:
            DECISIONS_PATH.unlink(missing_ok=True)
        console.print(f"[dim]jsonl drain: {drained} imported, {len(leftovers)} kept[/dim]")
    except Exception as e:
        console.print(f"[red]jsonl drain: cleanup failed: {e}[/red]")


def render(d: Decision) -> None:
    short = d.market[:10] + "…"
    color = {
        "buy_yes": "yes",  # we'll map at print time
        "buy_no": "no",
        "pass": "dim",
    }[d.action]

    if d.action == "pass":
        console.print(
            f"  [{color}]pass[/]  {short}  edge {d.edge_pts:+.1f}pt  "
            f"conf {d.ai_confidence:.0%}  [dim]({d.pass_reason})[/dim]"
        )
    else:
        side = "YES" if d.action == "buy_yes" else "NO"
        side_color = "green" if d.action == "buy_yes" else "red"
        console.print(
            f"  [bold {side_color}]{side}[/]   {short}  "
            f"shares={d.shares/1e6:.2f}  cost≈${d.cost_usdc:.2f}  "
            f"edge {d.edge_pts:+.1f}pt  conf {d.ai_confidence:.0%}"
            f"  [dim]{('tx ' + d.tx_hash[:14] + '…') if d.tx_hash else '(paper)'}[/dim]"
        )


# ── Estimate dispatcher (Phase 5) ──────────────────────────────────────────
def _pick_estimate(
    m: MarketState,
    profile: AgentProfile,
    bankroll_usdc: float,
    policy,
    tier: str,
    allowed_tools: tuple[str, ...],
) -> tuple["Estimate | None", "Any"]:
    """Pick the best available probability estimator for this market.

    Prefers the multi-step tool-use brain (agent/brain.py, OpenRouter) —
    that's the path RFB-02 judges will replay via the /agent page tool
    trace. Falls back to the legacy single-shot OpenRouter call if the
    brain import fails (typically a stale checkout missing brain.py).

    Both paths require OPENROUTER_API_KEY. The brain additionally honours
    BRAIN_MODEL (orchestrator) and BRAIN_SEARCH_MODEL (web-search delegate).

    Returns (estimate, brain_result_or_none). brain_result_or_none is the
    full BrainResult when the brain ran, so the caller can copy tool_trace
    and news_summary into the Decision.
    """
    use_brain = bool(os.environ.get("OPENROUTER_API_KEY"))

    if use_brain:
        try:
            from brain import estimate as brain_estimate
        except Exception as e:  # noqa: BLE001
            console.print(f"[red]brain import failed: {e} — using legacy[/red]")
            use_brain = False

    if use_brain:
        br = brain_estimate(
            question=m.question,
            category=m.category,
            resolution_criteria=m.resolution_criteria,
            deadline_unix=m.deadline,
            amm_yes_price=m.price_yes,
            bankroll_usdc=bankroll_usdc,
            kelly_mult=policy.kelly_mult,
            strategy_context=strategy_context(profile, policy),
            model=model_for_profile(profile, tier),
            allowed_tools=allowed_tools,
        )
        if br is None:
            return (None, None)
        est = Estimate(
            probability=br.probability,
            confidence=br.confidence,
            reasoning=br.reasoning,
            key_sources=br.key_sources,
            watch_for=br.watch_for,
            time_sensitivity=br.time_sensitivity,
            polymarket_prob=br.polymarket_prob,
            polymarket_slug=br.polymarket_slug,
        )
        return (est, br)

    # Legacy fallback: single-shot Perplexity/Sonar via OpenRouter. The
    # polymarket prior is fetched separately here because the legacy
    # llm_estimate doesn't know how to do it itself.
    pm_prob, pm_slug = (
        polymarket_match(m.question)
        if "polymarket" in profile.signals
        else (None, None)
    )
    est = llm_estimate(m, pm_prob, pm_slug) if "ai" in profile.signals else None
    if est is None and "ai" in profile.signals:
        return (None, None)
    if est is None:
        if pm_prob is None:
            return (None, None)
        est = Estimate(
            probability=pm_prob,
            confidence=0.55,
            reasoning="Pure crowd-arbitrage signal — Polymarket reference price.",
            key_sources=[],
            watch_for=[],
            time_sensitivity="medium",
            polymarket_prob=pm_prob,
            polymarket_slug=pm_slug,
        )
    return (est, None)


# ── Per-user runner (Phase 4) ──────────────────────────────────────────────
def run_for_user(
    w3: Web3,
    profile: AgentProfile,
    session_account,
    addrs: list[str],
    *,
    live: bool,
) -> list[Decision]:
    """One pass over the user's in-scope markets, executing buys via their
    AgentAccount when the runner is in --live mode."""
    try:
        ensure_subscription_row(profile.user_addr)
        ensure_credits_row(profile.user_addr)
    except Exception as _e:
        console.print(f"  [dim]account economics setup skipped: {_e}[/dim]")

    # Refill free monthly credits if the refill date has passed.
    try:
        maybe_refill_free_credits(profile.user_addr)
    except Exception as _e:
        console.print(f"  [dim]credit refill skipped: {_e}[/dim]")

    tier = get_subscription_tier(profile.user_addr)
    entitlements = entitlements_for_tier(tier)
    policy = policy_for_profile(profile)
    risk = {
        "kelly_mult": policy.kelly_mult,
        "edge_threshold": policy.edge_threshold,
        "min_confidence": policy.min_confidence,
        "extra_edge_buffer": entitlements.extra_edge_buffer,
        "uncertainty_buffer_mult": entitlements.uncertainty_buffer_mult,
        "slippage_buffer_bps": entitlements.slippage_buffer_bps,
    }

    # Bankroll: USDC in the agent's wallet.
    # Circle path: query via Circle Wallets API (no web3 needed for balance).
    # Legacy path: balanceOf(agent_address) via ERC-20.
    if profile.circle_wallet_id:
        bankroll = get_wallet_usdc_balance(profile.circle_wallet_id)
        agent_label = profile.agent_address[:10] + "…" if profile.agent_address else "(circle)"
    else:
        usdc_contract = w3.eth.contract(address=USDC, abi=USDC_ABI)
        bankroll_micro = usdc_contract.functions.balanceOf(
            Web3.to_checksum_address(profile.agent_address)  # type: ignore[arg-type]
        ).call()
        bankroll = bankroll_micro / 1e6
        agent_label = profile.agent_address[:10] + "…" if profile.agent_address else "?"

    console.print(
        f"[bold cyan]· user[/bold cyan] {profile.user_addr[:10]}…  "
        f"agent={agent_label}  "
        f"tier={tier}  model={model_for_profile(profile, tier)}  "
        f"preset={policy.preset}  bankroll=${bankroll:.4f}"
    )

    out: list[Decision] = []
    states: list[MarketState] = []
    for addr in addrs:
        try:
            states.append(read_market_state(w3, addr))
        except Exception as e:
            console.print(f"  [red]read failed for {addr[:10]}…: {e}[/red]")
            continue

    if claim_resolved_positions(w3, profile=profile, markets=states, live=live):
        if profile.circle_wallet_id:
            bankroll = get_wallet_usdc_balance(profile.circle_wallet_id)
            console.print(f"  [dim]bankroll after claims: ${bankroll:.4f}[/dim]")

    portfolio = build_portfolio_snapshot(
        w3,
        profile=profile,
        markets=states,
        bankroll_usdc=bankroll,
    )
    day_start = int(time.time()) - 86400
    try:
        from db import user_spent_since, user_traded_markets_since
        from db import user_live_trade_count_since, user_brain_run_count_since

        spent_day = user_spent_since(profile.user_addr, day_start)
        live_trades_today = user_live_trade_count_since(profile.user_addr, day_start)
        brain_runs_today = user_brain_run_count_since(profile.user_addr, day_start)
        recent_markets = user_traded_markets_since(
            profile.user_addr,
            int(time.time()) - policy.repeat_cooldown_hours * 3600,
        )
    except Exception as e:  # noqa: BLE001
        console.print(f"  [yellow]policy DB context unavailable: {e}[/yellow]")
        spent_day = 0.0
        live_trades_today = 0
        brain_runs_today = 0
        recent_markets = set()

    risk_manager = PortfolioRiskManager(
        profile=profile,
        policy=policy,
        entitlements=entitlements,
        portfolio=portfolio,
        spent_day_usdc=spent_day,
        live_trades_today=live_trades_today,
        brain_runs_today=brain_runs_today,
        recent_markets=recent_markets,
    )

    for m in states:

        if m.resolved:
            continue
        if not matches_market(profile, m.address, m.category):
            continue

        # ── Market filters (from profile config) ─────────────────────────
        if m.total_liquidity < profile.min_liquidity_usdc:
            continue
        now_ts = int(time.time())
        tte_hours = (m.deadline - now_ts) / 3600.0
        if profile.min_tte_hours is not None and tte_hours < profile.min_tte_hours:
            continue
        if profile.max_tte_hours is not None and tte_hours > profile.max_tte_hours:
            continue
        if not (profile.odds_range_min <= m.price_yes <= profile.odds_range_max):
            continue

        base_policy_snapshot = {
            **risk_manager.snapshot(),
            "risk_bucket": risk_bucket(m.category, m.question),
        }
        pre_pass = risk_manager.pre_market_pass_reason(m)
        if pre_pass:
            decision = policy_pass(
                m,
                bankroll_usdc=bankroll,
                reason=pre_pass,
                user_addr=profile.user_addr,
                agent_addr=profile.agent_address,
                policy_snapshot=base_policy_snapshot,
            )
            decision.notification_status = notify_decision(profile.user_addr, decision)
            append_decision(decision)
            render(decision)
            out.append(decision)
            continue

        brain_gate = risk_manager.can_spend_brain_call()
        if not brain_gate.allowed:
            decision = policy_pass(
                m,
                bankroll_usdc=bankroll,
                reason=brain_gate.reason or "AI scan budget exhausted",
                user_addr=profile.user_addr,
                agent_addr=profile.agent_address,
                policy_snapshot=base_policy_snapshot,
            )
            decision.notification_status = notify_decision(profile.user_addr, decision)
            append_decision(decision)
            render(decision)
            out.append(decision)
            continue

        if live:
            credit_cost = credit_cost_for_run(entitlements.model_tier)
            if not deduct_credits(profile.user_addr, credit_cost):
                decision = policy_pass(
                    m,
                    bankroll_usdc=bankroll,
                    reason=f"insufficient AI credits for scan (need {credit_cost})",
                    user_addr=profile.user_addr,
                    agent_addr=profile.agent_address,
                    policy_snapshot=base_policy_snapshot,
                )
                decision.notification_status = notify_decision(profile.user_addr, decision)
                append_decision(decision)
                render(decision)
                out.append(decision)
                continue

        risk_manager.reserve_brain_call()
        est, brain_result = _pick_estimate(
            m,
            profile,
            bankroll,
            policy,
            tier,
            entitlements.allowed_tools,
        )
        if est is None:
            continue

        decision = decide(m, est, bankroll, risk)
        decision.user_addr = profile.user_addr
        decision.agent_addr = profile.agent_address
        if brain_result is not None:
            decision.news_summary = brain_result.news_summary
            decision.tool_trace = brain_result.tool_trace
            decision.brain_model = brain_result.model
            decision.brain_iterations = brain_result.iterations
            decision.prompt_hash = brain_result.prompt_hash
            decision.tools_called = [
                str(step.get("name"))
                for step in brain_result.tool_trace
                if isinstance(step, dict) and step.get("name")
            ]
        decision.external_odds_snapshot = {
            "polymarket": {
                "yes_probability": decision.polymarket_prob,
                "slug": decision.polymarket_slug,
            }
        }
        decision.policy_snapshot = {
            **risk_manager.snapshot(),
            "risk_bucket": risk_bucket(m.category, m.question),
        }
        if decision.action in ("buy_yes", "buy_no"):
            try:
                apply_contract_preview_pricing(w3, m, decision)
            except Exception as e:  # noqa: BLE001
                decision.action = "pass"
                decision.pass_reason = f"contract preview failed: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0

        gate = risk_manager.gate_trade(decision=decision, market=m)
        if not gate.allowed:
            decision.action = "pass"
            decision.pass_reason = gate.reason
            decision.shares = 0
            decision.cost_usdc = 0.0
        elif gate.scale_to_usdc is not None and decision.cost_usdc > 0:
            ratio = gate.scale_to_usdc / decision.cost_usdc
            decision.shares = int(decision.shares * ratio)
            decision.cost_usdc = decision.cost_usdc * ratio
            decision.pass_reason = gate.reason
            try:
                apply_contract_preview_pricing(w3, m, decision)
            except Exception as e:  # noqa: BLE001
                decision.action = "pass"
                decision.pass_reason = f"contract preview failed after rescale: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0
            console.print(
                f"  [dim]policy rescaled to ${decision.cost_usdc:.2f} "
                f"({gate.reason})[/dim]"
            )
        if decision.action in ("buy_yes", "buy_no"):
            decision.policy_snapshot["approved_cost_usdc"] = round(decision.cost_usdc, 4)

        # ── Live execution ─────────────────────────────────────────────────
        # Gate 1: tier permits live trading. Free is allowed; policy caps do
        # the limiting so the product remains real from day one.
        if live and decision.action in ("buy_yes", "buy_no"):
            if not entitlements.live_trading or not can_trade_live(profile.user_addr):
                decision.action = "pass"
                decision.pass_reason = "tier does not permit live trading"
                decision.shares = 0
                decision.cost_usdc = 0.0

        if decision.action in ("buy_yes", "buy_no"):
            risk_manager.reserve(decision=decision, market=m)

        # Gate 2: actual execution via Circle wallet or legacy session key.
        if live and decision.action in ("buy_yes", "buy_no"):
            try:
                side_id = 1 if decision.action == "buy_yes" else 2
                market_contract = w3.eth.contract(
                    address=Web3.to_checksum_address(m.address), abi=MARKET_ABI
                )
                preview = market_contract.functions.previewBuy(side_id, decision.shares).call()
                max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
                approved_cost = float(
                    decision.policy_snapshot.get("approved_cost_usdc")
                    or decision.cost_usdc
                    or 0
                )
                if approved_cost > 0 and preview / 1e6 > approved_cost + 0.02:
                    raise RuntimeError(
                        "contract preview exceeded policy-approved cost "
                        f"({preview/1e6:.4f} > {approved_cost:.4f})"
                    )
                decision.max_cost_usdc = max_cost / 1e6
                decision.cost_usdc = preview / 1e6

                # ── Circle Developer-Controlled Wallet path (preferred) ──
                if profile.circle_wallet_id:
                    treasury = os.environ.get("TREASURY_ADDRESS", "")

                    # Step 1: Deduct protocol fee → treasury.
                    if treasury:
                        fee_micro = compute_protocol_fee(int(preview))
                        decision.platform_fee_usdc = fee_micro / 1e6
                        try:
                            fee_tx_id = transfer_usdc(
                                wallet_id=profile.circle_wallet_id,
                                destination_address=treasury,
                                amount_micro=fee_micro,
                                idempotency_key=f"fee-{decision.ts}-{m.address[:8]}",
                            )
                            # Non-blocking: don't wait for fee confirmation before
                            # submitting the buy — Arc is fast enough that they
                            # settle in the same block window.
                            console.print(
                                f"  [dim]fee ${fee_micro/1e6:.4f} USDC → "
                                f"treasury (circle tx {fee_tx_id[:12]}…)[/dim]"
                            )
                        except Exception as fee_err:
                            # Fee failure is non-fatal — log and continue.
                            console.print(f"  [yellow]fee transfer failed: {fee_err}[/yellow]")

                    # Step 2: USDC approve (Circle wallet calls approve before buy
                    # via a separate contractExecution tx, since the Circle wallet
                    # is a plain EOA and can't auto-approve like AgentAccount).
                    approve_tx_id = execute_contract_call(
                        wallet_id=profile.circle_wallet_id,
                        contract_address=USDC,
                        abi_function_signature="approve(address,uint256)",
                        abi_parameters=[m.address, str(max_cost)],
                        idempotency_key=f"approve-{decision.ts}-{m.address[:8]}",
                    )
                    wait_for_transaction(approve_tx_id, max_wait=60.0)

                    # Step 3: buy().
                    buy_tx_id = execute_contract_call(
                        wallet_id=profile.circle_wallet_id,
                        contract_address=m.address,
                        abi_function_signature="buy(uint8,uint256,uint256)",
                        abi_parameters=[side_id, str(decision.shares), str(max_cost)],
                        idempotency_key=f"buy-{decision.ts}-{m.address[:8]}",
                    )
                    on_chain_hash = wait_for_transaction(buy_tx_id, max_wait=90.0)
                    decision.tx_hash = (
                        on_chain_hash
                        if on_chain_hash.startswith("0x")
                        else "0x" + on_chain_hash
                    )
                    decision.paper = False

                else:
                    # ── Legacy session-key path (AgentAccount.sol) ──────────
                    if session_account is None:
                        raise RuntimeError("AGENT_SESSION_PRIVATE_KEY missing for legacy AgentAccount")
                    tx_hash = execute_buy_via_agent(
                        w3,
                        session_account,
                        profile.agent_address,
                        m.address,
                        side_id,
                        decision.shares,
                        int(max_cost),
                    )
                    decision.tx_hash = (
                        tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
                    )
                    decision.paper = False

            except (ContractLogicError, Exception) as e:
                console.print(f"  [red]execute failed: {e}[/red]")
                decision.action = "pass"
                decision.pass_reason = f"execute failed: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0
        decision.notification_status = notify_decision(profile.user_addr, decision)
        append_decision(decision)
        render(decision)
        out.append(decision)
        time.sleep(0.3)

    return out


def main_per_user(args) -> int:
    """Per-user run path — iterates the profiles store, runs each runnable
    profile once (or in a loop with --watch)."""
    try:
        assert_schema_compatible()
    except Exception as e:
        console.print(f"[red]{e}[/red]")
        return 1

    w3 = get_web3()
    if not w3.is_connected():
        console.print("[red]not connected to Arc[/red]")
        return 1

    # Best-effort import of anything written to the JSONL fallback by a
    # previous run when the DB was unreachable. Idempotent.
    try:
        drain_pending_jsonl()
    except Exception as e:
        console.print(f"[dim]jsonl drain skipped: {e}[/dim]")

    if args.live:
        pk = os.environ.get("AGENT_SESSION_PRIVATE_KEY")
        if pk:
            from eth_account import Account
            session_account = Account.from_key(pk)
            console.print(f"[dim]session signer:[/dim] {session_account.address}")
        else:
            session_account = None
            console.print(
                "[yellow]AGENT_SESSION_PRIVATE_KEY missing; Circle wallets can "
                "trade live, legacy AgentAccount users will pass on execution[/yellow]"
            )
    else:
        session_account = None

    addrs = discover_markets(w3)
    console.print(f"[dim]factory has {len(addrs)} markets[/dim]")

    last_run = _LAST_RUN_BY_USER

    def one_pass() -> int:
        profiles = load_profiles()
        runnable = [p for p in profiles if is_runnable(p)]
        if args.user:
            runnable = [p for p in runnable if p.user_addr.lower() == args.user.lower()]
        if not runnable:
            console.print("[dim]no runnable profiles[/dim]")
            return 0

        now = time.time()
        worked = 0
        for p in runnable:
            p_tier = get_subscription_tier(p.user_addr)
            p_entitlements = entitlements_for_tier(p_tier)
            cadence_minutes = max(p.cadence_minutes, p_entitlements.min_cadence_minutes)
            due_at = last_run.get(p.user_addr, 0) + cadence_minutes * 60
            if now < due_at:
                wait_s = int(due_at - now)
                console.print(
                    f"  [dim]skip {p.user_addr[:10]}… — next run in {wait_s}s "
                    f"(tier cadence {cadence_minutes}m)[/dim]"
                )
                continue
            console.rule(f"user {p.user_addr[:10]}… · {p.pattern}")
            run_for_user(w3, p, session_account, addrs, live=args.live)
            last_run[p.user_addr] = time.time()
            worked += 1
        return worked

    if not args.watch:
        one_pass()
        return 0

    console.rule("watch mode · ctrl-C to stop")
    try:
        while True:
            one_pass()
            time.sleep(args.watch_interval)
    except KeyboardInterrupt:
        console.print("\n[dim]stopped[/dim]")
        return 0


# ── Main ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--risk", choices=list(RISK_PROFILES),
                    default="moderate", help="(legacy mode) risk profile")
    ap.add_argument("--live", action="store_true",
                    help="(legacy mode) broadcast buys from the dev EOA")
    ap.add_argument("--limit", type=int, default=None,
                    help="(legacy mode) only evaluate the first N markets")
    ap.add_argument("--legacy", action="store_true",
                    help="run the original dev-EOA loop (pre-Phase-4)")
    # Per-user / scheduler flags
    ap.add_argument("--user", type=str, default=None,
                    help="only run for this user address")
    ap.add_argument("--watch", action="store_true",
                    help="loop forever, respecting each profile's cadence")
    ap.add_argument("--watch-interval", type=int, default=30,
                    help="seconds between watch-mode passes")
    args = ap.parse_args()

    if not args.legacy:
        return main_per_user(args)

    # ── Legacy dev-EOA path (Phase 1 demo) ─────────────────────────────────

    risk = RISK_PROFILES[args.risk]
    console.rule(
        f"yolo-agent / loop · risk={args.risk} "
        f"({risk['kelly_mult']:.0%} kelly, edge ≥ {risk['edge_threshold']*100:.0f}pt) "
        f"· {'LIVE' if args.live else 'paper'}"
    )

    w3 = get_web3()
    if not w3.is_connected():
        console.print("[red]not connected to Arc[/red]")
        return 1

    account = None
    if args.live:
        pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
        if not pk:
            console.print("[red]DEPLOYER_PRIVATE_KEY missing — can't go live[/red]")
            return 1
        from eth_account import Account
        account = Account.from_key(pk)
        console.print(f"  trader: {account.address}")

    # Bankroll = trader's USDC ERC-20 balance
    usdc = w3.eth.contract(address=USDC, abi=USDC_ABI)
    trader_addr = account.address if account else os.environ.get(
        "DEPLOYER_ADDRESS", "0x0000000000000000000000000000000000000000")
    bankroll_micro = usdc.functions.balanceOf(
        Web3.to_checksum_address(trader_addr)).call()
    bankroll = bankroll_micro / 1e6
    console.print(f"  bankroll: ${bankroll:.4f} USDC")

    addrs = discover_markets(w3)
    if args.limit:
        addrs = addrs[:args.limit]
    console.print(f"  discovered {len(addrs)} markets\n")

    summary_rows = []

    for addr in addrs:
        try:
            m = read_market_state(w3, addr)
        except Exception as e:
            console.print(f"[red]read failed for {addr}: {e}[/red]")
            continue

        if m.resolved:
            console.print(f"  [dim]skip[/dim] {addr[:10]}…  (resolved)")
            continue

        console.print(f"[bold]·[/] {m.category}  {m.question[:80]}")
        pm_prob, pm_slug = polymarket_match(m.question)
        if pm_prob is not None:
            console.print(
                f"  polymarket: {pm_prob*100:.1f}%  [dim]slug={pm_slug}[/dim]"
            )

        est = llm_estimate(m, pm_prob, pm_slug)
        if est is None:
            console.print("  [dim red]no llm estimate, skipping[/dim red]")
            continue

        decision = decide(m, est, bankroll, risk)

        # Live execution
        if args.live and decision.action in ("buy_yes", "buy_no") and account:
            try:
                side_id = 1 if decision.action == "buy_yes" else 2
                market = w3.eth.contract(
                    address=Web3.to_checksum_address(m.address), abi=MARKET_ABI)
                # Authoritative preview from the contract
                preview = market.functions.previewBuy(side_id, decision.shares).call()
                max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
                decision.max_cost_usdc = max_cost / 1e6
                decision.cost_usdc = preview / 1e6
                tx_hash = execute_buy(w3, account, m.address, side_id,
                                       decision.shares, int(max_cost))
                decision.tx_hash = tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
                decision.paper = False
            except (ContractLogicError, Exception) as e:
                console.print(f"  [red]execute failed: {e}[/red]")
                # Fall back to pass + log
                decision.action = "pass"
                decision.pass_reason = f"execute failed: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0

        append_decision(decision)
        render(decision)
        summary_rows.append(decision)
        # Polite pause so we don't get rate-limited on Polymarket/OpenRouter
        time.sleep(0.4)

    # Summary table
    t = Table(title="\nsummary", box=None)
    t.add_column("action", style="bold")
    t.add_column("count", justify="right")
    counts = {"buy_yes": 0, "buy_no": 0, "pass": 0}
    for d in summary_rows:
        counts[d.action] += 1
    for k, v in counts.items():
        t.add_row(k, str(v))
    console.print(t)

    return 0


if __name__ == "__main__":
    sys.exit(main())
