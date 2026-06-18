"""Production-grade trading policy for the YOLO Markets runner.

The LLM estimates probability. This module decides whether that estimate is
allowed to become a trade. It keeps sizing, exposure, cadence, and portfolio
construction deterministic so a model cannot talk itself past risk controls.
"""

from __future__ import annotations

import re
import os
from dataclasses import dataclass, field
from typing import Any


MIN_TRADE_USDC = 0.10
MAX_SINGLE_MARKET_BANKROLL_FRACTION = 0.30
MAX_CORRELATED_BANKROLL_FRACTION = 0.45


@dataclass(frozen=True)
class StrategyPolicy:
    preset: str
    description: str
    kelly_mult: float
    edge_threshold: float
    min_confidence: float
    max_trades_per_run: int
    run_bankroll_fraction: float
    max_market_fraction: float = MAX_SINGLE_MARKET_BANKROLL_FRACTION
    max_bucket_fraction: float = MAX_CORRELATED_BANKROLL_FRACTION
    repeat_cooldown_hours: int = 12


@dataclass(frozen=True)
class TierEntitlements:
    tier: str
    description: str
    live_trading: bool
    model_tier: str
    max_trade_usdc: float
    max_daily_trades: int
    max_brain_runs_per_day: int
    min_cadence_minutes: int
    allowed_tools: tuple[str, ...]
    extra_edge_buffer: float
    uncertainty_buffer_mult: float
    slippage_buffer_bps: int
    max_open_positions: int | None = None


@dataclass
class PositionSnapshot:
    market: str
    question: str
    category: str
    bucket: str
    yes_shares: float
    no_shares: float
    yes_price: float

    @property
    def value_usdc(self) -> float:
        return self.yes_shares * self.yes_price + self.no_shares * (1.0 - self.yes_price)

    @property
    def is_open(self) -> bool:
        return self.value_usdc >= MIN_TRADE_USDC


@dataclass
class PortfolioSnapshot:
    bankroll_usdc: float
    positions: list[PositionSnapshot] = field(default_factory=list)

    def market_value(self, market: str) -> float:
        want = market.lower()
        return sum(p.value_usdc for p in self.positions if p.market.lower() == want)

    def bucket_value(self, bucket: str) -> float:
        return sum(p.value_usdc for p in self.positions if p.bucket == bucket)

    def open_position_count(self) -> int:
        return sum(1 for p in self.positions if p.is_open)

    def has_market(self, market: str) -> bool:
        want = market.lower()
        return any(p.is_open and p.market.lower() == want for p in self.positions)


@dataclass
class GateResult:
    allowed: bool
    reason: str | None = None
    scale_to_usdc: float | None = None


PRESET_POLICIES: dict[str, StrategyPolicy] = {
    "moonshot": StrategyPolicy(
        preset="moonshot",
        description="high-risk convex bets only when edge is large and evidence is fresh",
        kelly_mult=1.0,
        edge_threshold=0.03,
        min_confidence=0.55,
        max_trades_per_run=1,
        run_bankroll_fraction=0.15,
        repeat_cooldown_hours=24,
    ),
    "quant": StrategyPolicy(
        preset="quant",
        description="systematic low-variance fractional Kelly with strict diversification",
        kelly_mult=0.25,
        edge_threshold=0.05,
        min_confidence=0.50,
        max_trades_per_run=2,
        run_bankroll_fraction=0.08,
        repeat_cooldown_hours=12,
    ),
    "contrarian": StrategyPolicy(
        preset="contrarian",
        description="bet against crowd consensus only when independent estimate diverges deeply",
        kelly_mult=0.50,
        edge_threshold=0.10,
        min_confidence=0.60,
        max_trades_per_run=1,
        run_bankroll_fraction=0.10,
        repeat_cooldown_hours=24,
    ),
    "news_trader": StrategyPolicy(
        preset="news_trader",
        description="fast-cadence news reaction, high confidence, short cooldown",
        kelly_mult=0.50,
        edge_threshold=0.07,
        min_confidence=0.58,
        max_trades_per_run=2,
        run_bankroll_fraction=0.12,
        repeat_cooldown_hours=4,
    ),
    "copycat": StrategyPolicy(
        preset="copycat",
        description="mirror strong Polymarket disagreement conservatively",
        kelly_mult=0.25,
        edge_threshold=0.02,
        min_confidence=0.40,
        max_trades_per_run=2,
        run_bankroll_fraction=0.06,
        repeat_cooldown_hours=8,
    ),
}

PATTERN_TO_PRESET = {
    "arb": "copycat",
    "value": "quant",
    "event_hunter": "news_trader",
    "slow_build": "quant",
}

def _use_gemini_models() -> bool:
    forced = (os.environ.get("BRAIN_PROVIDER") or "").strip().lower()
    if forced == "gemini":
        return True
    if forced == "openrouter":
        return False
    return bool(os.environ.get("GEMINI_API_KEY"))


if _use_gemini_models():
    MODEL_BY_TIER = {
        "economy": os.environ.get("GEMINI_FREE_MODEL", "gemini-3.1-flash-lite"),
        "standard": os.environ.get("GEMINI_PRO_MODEL", "gemini-3-flash-preview"),
        "premium": os.environ.get("GEMINI_PRO_MODEL", "gemini-3-flash-preview"),
    }
else:
    MODEL_BY_TIER = {
        "economy": os.environ.get("OPENROUTER_FREE_MODEL", "perplexity/sonar"),
        "standard": os.environ.get("OPENROUTER_STANDARD_MODEL", "anthropic/claude-sonnet-4.6"),
        "premium": os.environ.get("OPENROUTER_PRO_MODEL", "anthropic/claude-sonnet-4.6"),
    }


TIER_ENTITLEMENTS: dict[str, TierEntitlements] = {
    "free": TierEntitlements(
        tier="free",
        description="starter live trading with slow cadence and small risk budget",
        live_trading=True,
        model_tier="economy",
        max_trade_usdc=1.00,
        max_daily_trades=5,
        max_brain_runs_per_day=100,
        min_cadence_minutes=240,
        allowed_tools=("fetch_polymarket_odds", "compute_kelly"),
        extra_edge_buffer=0.010,
        uncertainty_buffer_mult=0.030,
        slippage_buffer_bps=125,
        max_open_positions=3,
    ),
    "pro": TierEntitlements(
        tier="pro",
        description="paid live trading with balanced cadence and evidence tools",
        live_trading=True,
        model_tier="standard",
        max_trade_usdc=5.00,
        max_daily_trades=10,
        max_brain_runs_per_day=200,
        min_cadence_minutes=60,
        allowed_tools=("fetch_polymarket_odds", "compute_kelly", "web_search"),
        extra_edge_buffer=0.006,
        uncertainty_buffer_mult=0.020,
        slippage_buffer_bps=90,
        max_open_positions=8,
    ),
    "plus": TierEntitlements(
        tier="plus",
        description="professional autonomy with faster cadence, larger caps, and richer evidence",
        live_trading=True,
        model_tier="premium",
        max_trade_usdc=25.00,
        max_daily_trades=20,
        max_brain_runs_per_day=500,
        min_cadence_minutes=15,
        allowed_tools=("fetch_polymarket_odds", "compute_kelly", "web_search"),
        extra_edge_buffer=0.003,
        uncertainty_buffer_mult=0.012,
        slippage_buffer_bps=60,
        max_open_positions=None,
    ),
}


def normalize_subscription_tier(tier: str | None) -> str:
    raw = (tier or "free").strip()
    if raw == "active":
        return "pro"
    if raw in TIER_ENTITLEMENTS:
        return raw
    return "free"


def policy_for_profile(profile: Any) -> StrategyPolicy:
    raw = (getattr(profile, "preset", None) or "").strip()
    mapped = PATTERN_TO_PRESET.get(getattr(profile, "pattern", ""))
    if mapped and raw in ("", "quant", "custom"):
        preset = mapped
    else:
        preset = raw or "quant"
    base = PRESET_POLICIES.get(preset, PRESET_POLICIES["quant"])
    return StrategyPolicy(
        preset=base.preset,
        description=base.description,
        kelly_mult=float(getattr(profile, "kelly_mult", base.kelly_mult)),
        edge_threshold=float(getattr(profile, "edge_threshold", base.edge_threshold)),
        min_confidence=float(getattr(profile, "min_confidence", base.min_confidence)),
        max_trades_per_run=base.max_trades_per_run,
        run_bankroll_fraction=base.run_bankroll_fraction,
        max_market_fraction=base.max_market_fraction,
        max_bucket_fraction=base.max_bucket_fraction,
        repeat_cooldown_hours=base.repeat_cooldown_hours,
    )


def entitlements_for_tier(tier: str | None) -> TierEntitlements:
    return TIER_ENTITLEMENTS[normalize_subscription_tier(tier)]


def model_for_profile(profile: Any, subscription_tier: str | None = None) -> str | None:
    entitlements = entitlements_for_tier(subscription_tier)
    configured = (getattr(profile, "brain_model", "") or "").strip()
    # Free users always get the low-cost model. Paid tiers may choose within
    # their profile, but default to the tier entitlement.
    model_tier = entitlements.model_tier if entitlements.tier == "free" else configured
    model_tier = model_tier if model_tier in MODEL_BY_TIER else entitlements.model_tier
    return MODEL_BY_TIER.get(model_tier)


def strategy_context(profile: Any, policy: StrategyPolicy) -> str:
    signals = ", ".join(getattr(profile, "signals", []) or []) or "none"
    return (
        f"{policy.preset}: {policy.description}; "
        f"fractional Kelly {policy.kelly_mult:.2f}x; "
        f"minimum edge {policy.edge_threshold * 100:.1f}pt; "
        f"minimum confidence {policy.min_confidence:.0%}; "
        f"signals enabled: {signals}; "
        "risk controls: max 30% bankroll per market, max 45% bankroll per "
        "correlated bucket, daily budget, per-market budget, max open positions."
    )


def risk_bucket(category: str, question: str) -> str:
    text = f"{category} {question}".lower()
    themed = [
        ("crypto:btc", r"\b(bitcoin|btc)\b"),
        ("crypto:eth", r"\b(ethereum|eth)\b"),
        ("crypto:sol", r"\b(solana|sol)\b"),
        ("crypto:arc", r"\b(arc|circle|usdc|stablecoin)\b"),
        ("macro:rates", r"\b(fed|fomc|rates?|cpi|inflation|jobs report|nfp)\b"),
        ("politics:us", r"\b(trump|biden|congress|senate|house|election|president)\b"),
        ("ai:frontier", r"\b(openai|anthropic|google|nvidia|ai model|gpt|claude)\b"),
        ("sports:nba", r"\b(nba|lakers|celtics|warriors|knicks)\b"),
        ("sports:nfl", r"\b(nfl|chiefs|eagles|cowboys|super bowl)\b"),
    ]
    for bucket, pattern in themed:
        if re.search(pattern, text):
            return bucket
    normalized_category = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
    return f"category:{normalized_category or 'unknown'}"


class PortfolioRiskManager:
    def __init__(
        self,
        *,
        profile: Any,
        policy: StrategyPolicy,
        entitlements: TierEntitlements,
        portfolio: PortfolioSnapshot,
        spent_day_usdc: float,
        live_trades_today: int = 0,
        brain_runs_today: int = 0,
        spent_by_bucket_usdc: dict[str, float] | None = None,
        recent_markets: set[str] | None = None,
    ) -> None:
        self.profile = profile
        self.policy = policy
        self.entitlements = entitlements
        self.portfolio = portfolio
        self.spent_day_usdc = spent_day_usdc
        self.live_trades_today = live_trades_today
        self.brain_runs_today = brain_runs_today
        self.spent_by_bucket_usdc = spent_by_bucket_usdc or {}
        self.recent_markets = {m.lower() for m in (recent_markets or set())}
        self.run_spent_usdc = 0.0
        self.run_trades = 0
        self.run_brain_calls = 0

    def pre_market_pass_reason(self, market: Any) -> str | None:
        if getattr(market, "resolved", False):
            return "market already resolved"
        if float(getattr(market, "total_liquidity", 0.0)) < float(
            getattr(self.profile, "min_liquidity_usdc", 0.0)
        ):
            return "below minimum liquidity"
        if self.portfolio.has_market(market.address):
            return None
        profile_max_open = getattr(self.profile, "max_open_positions", None)
        tier_max_open = self.entitlements.max_open_positions
        if profile_max_open is not None and tier_max_open is not None:
            max_open = min(int(profile_max_open), int(tier_max_open))
        else:
            max_open = profile_max_open if profile_max_open is not None else tier_max_open
        if max_open is not None and self.portfolio.open_position_count() >= int(max_open):
            return f"max open positions reached ({max_open})"
        if market.address.lower() in self.recent_markets:
            return f"recent trade cooldown ({self.policy.repeat_cooldown_hours}h)"
        return None

    def trading_halted_for_run(self) -> GateResult:
        """Not-allowed once no further buy can happen this run regardless of
        which market comes next — the per-run trade cap or the tier daily trade
        cap is exhausted. Lets the scanner stop early instead of paying for
        brain calls + x402 reasoning fees on markets it can no longer act on.
        Because markets are scanned best-first (fast → near-deadline → rest),
        the markets skipped by an early stop are the lowest-priority ones."""
        if self.run_trades >= self.policy.max_trades_per_run:
            return GateResult(
                False, f"max trades per run reached ({self.policy.max_trades_per_run})"
            )
        if self.live_trades_today + self.run_trades >= self.entitlements.max_daily_trades:
            return GateResult(
                False, f"tier daily trade cap reached ({self.entitlements.max_daily_trades})"
            )
        return GateResult(True)

    def gate_trade(self, *, decision: Any, market: Any) -> GateResult:
        if decision.action not in ("buy_yes", "buy_no"):
            return GateResult(True)
        if self.run_trades >= self.policy.max_trades_per_run:
            return GateResult(False, f"max trades per run reached ({self.policy.max_trades_per_run})")
        if self.live_trades_today + self.run_trades >= self.entitlements.max_daily_trades:
            return GateResult(False, f"tier daily trade cap reached ({self.entitlements.max_daily_trades})")

        bucket = risk_bucket(market.category, market.question)
        bankroll = max(float(decision.bankroll_usdc), self.portfolio.bankroll_usdc, 0.0)
        if bankroll < MIN_TRADE_USDC:
            return GateResult(False, "bankroll below minimum trade size")

        market_room = min(
            float(getattr(self.profile, "budget_per_market", bankroll)),
            self.entitlements.max_trade_usdc,
            bankroll * self.policy.max_market_fraction,
        ) - self.portfolio.market_value(market.address)
        bucket_room = bankroll * self.policy.max_bucket_fraction
        bucket_room -= self.portfolio.bucket_value(bucket)
        bucket_room -= self.spent_by_bucket_usdc.get(bucket, 0.0)

        day_room = float(getattr(self.profile, "budget_per_day", bankroll)) - self.spent_day_usdc - self.run_spent_usdc
        run_room = bankroll * self.policy.run_bankroll_fraction - self.run_spent_usdc
        allowed = min(market_room, bucket_room, day_room, run_room)

        if allowed < MIN_TRADE_USDC:
            return GateResult(
                False,
                (
                    "risk budget exhausted "
                    f"(market_room={market_room:.2f}, bucket_room={bucket_room:.2f}, "
                    f"day_room={day_room:.2f})"
                ),
            )
        if float(decision.cost_usdc) > allowed:
            return GateResult(True, "rescaled by portfolio risk budget", allowed)
        return GateResult(True)

    def reserve(self, *, decision: Any, market: Any) -> None:
        if decision.action not in ("buy_yes", "buy_no"):
            return
        bucket = risk_bucket(market.category, market.question)
        cost = float(decision.cost_usdc)
        self.run_spent_usdc += cost
        self.spent_by_bucket_usdc[bucket] = self.spent_by_bucket_usdc.get(bucket, 0.0) + cost
        self.run_trades += 1

    def can_spend_brain_call(self) -> GateResult:
        if self.brain_runs_today + self.run_brain_calls >= self.entitlements.max_brain_runs_per_day:
            return GateResult(
                False,
                f"tier daily AI scan cap reached ({self.entitlements.max_brain_runs_per_day})",
            )
        return GateResult(True)

    def reserve_brain_call(self) -> None:
        self.run_brain_calls += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "tier": self.entitlements.tier,
            "tier_description": self.entitlements.description,
            "tier_max_trade_usdc": self.entitlements.max_trade_usdc,
            "tier_max_daily_trades": self.entitlements.max_daily_trades,
            "tier_max_brain_runs_per_day": self.entitlements.max_brain_runs_per_day,
            "tier_min_cadence_minutes": self.entitlements.min_cadence_minutes,
            "preset": self.policy.preset,
            "kelly_mult": self.policy.kelly_mult,
            "edge_threshold": self.policy.edge_threshold,
            "extra_edge_buffer": self.entitlements.extra_edge_buffer,
            "uncertainty_buffer_mult": self.entitlements.uncertainty_buffer_mult,
            "slippage_buffer_bps": self.entitlements.slippage_buffer_bps,
            "min_confidence": self.policy.min_confidence,
            "max_trades_per_run": self.policy.max_trades_per_run,
            "run_bankroll_fraction": self.policy.run_bankroll_fraction,
            "max_market_fraction": self.policy.max_market_fraction,
            "max_bucket_fraction": self.policy.max_bucket_fraction,
            "spent_day_usdc": round(self.spent_day_usdc, 4),
            "live_trades_today": self.live_trades_today,
            "brain_runs_today": self.brain_runs_today,
            "run_spent_usdc": round(self.run_spent_usdc, 4),
            "run_brain_calls": self.run_brain_calls,
            "open_positions": self.portfolio.open_position_count(),
        }
