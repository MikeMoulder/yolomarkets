"""Reader for agent profiles, backed by Postgres (agent_profiles table).

Tier-1a migration: replaces the JSON-file store at agent/profiles.json
with the same DB the Next.js wizard writes into. Same dataclass shape
and helpers — call sites in loop.py don't change.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from db import conn


@dataclass
class AgentProfile:
    user_addr: str
    pattern: str
    preset: str                         # moonshot|quant|contrarian|news_trader|copycat|custom
    brain_model: str                    # economy|standard|premium
    reasoning_depth: str               # fast|balanced|deep
    cadence_minutes: int
    kelly_mult: float
    edge_threshold: float
    min_confidence: float
    signals: list[str]
    markets_mode: Literal["all", "categories", "watchlist"]
    categories: list[str]
    watchlist: list[str]
    budget_total: float
    budget_per_market: float
    budget_per_day: float
    drawdown_pause_pct: float | None
    min_liquidity_usdc: float
    min_tte_hours: int | None
    max_tte_hours: int | None
    odds_range_min: float
    odds_range_max: float
    max_open_positions: int | None
    agent_address: str | None          # Circle wallet's on-chain address
    circle_wallet_id: str | None       # Circle Developer-Controlled wallet ID
    telegram_chat_id: str | None
    telegram_enabled: bool
    telegram_events: list[str]
    active: bool
    paused_until: str | None


_COLUMNS = (
    "user_addr, pattern, preset, brain_model, reasoning_depth,"
    " cadence_minutes, kelly_mult, edge_threshold,"
    " min_confidence, signals, markets_mode, categories, watchlist,"
    " budget_total, budget_per_market, budget_per_day,"
    " drawdown_pause_pct, min_liquidity_usdc, min_tte_hours, max_tte_hours,"
    " odds_range_min, odds_range_max, max_open_positions,"
    " agent_address, circle_wallet_id,"
    " telegram_chat_id, telegram_enabled, telegram_events,"
    " active, paused_until"
)


def _row_to_profile(row: tuple) -> AgentProfile:
    (
        user_addr, pattern, preset, brain_model, reasoning_depth,
        cadence_minutes, kelly_mult, edge_threshold,
        min_confidence, signals, markets_mode, categories, watchlist,
        budget_total, budget_per_market, budget_per_day,
        drawdown_pause_pct, min_liquidity_usdc, min_tte_hours, max_tte_hours,
        odds_range_min, odds_range_max, max_open_positions,
        agent_address, circle_wallet_id,
        telegram_chat_id, telegram_enabled, telegram_events,
        active, paused_until,
    ) = row
    return AgentProfile(
        user_addr=user_addr,
        pattern=pattern,
        preset=preset or "quant",
        brain_model=brain_model or "standard",
        reasoning_depth=reasoning_depth or "balanced",
        cadence_minutes=int(cadence_minutes),
        kelly_mult=float(kelly_mult),
        edge_threshold=float(edge_threshold),
        min_confidence=float(min_confidence),
        signals=list(signals or []),
        markets_mode=markets_mode,
        categories=list(categories or []),
        watchlist=list(watchlist or []),
        budget_total=float(budget_total),
        budget_per_market=float(budget_per_market),
        budget_per_day=float(budget_per_day),
        drawdown_pause_pct=float(drawdown_pause_pct) if drawdown_pause_pct is not None else None,
        min_liquidity_usdc=float(min_liquidity_usdc) if min_liquidity_usdc is not None else 0.0,
        min_tte_hours=int(min_tte_hours) if min_tte_hours is not None else None,
        max_tte_hours=int(max_tte_hours) if max_tte_hours is not None else None,
        odds_range_min=float(odds_range_min) if odds_range_min is not None else 0.05,
        odds_range_max=float(odds_range_max) if odds_range_max is not None else 0.95,
        max_open_positions=int(max_open_positions) if max_open_positions is not None else None,
        agent_address=agent_address,
        circle_wallet_id=circle_wallet_id,
        telegram_chat_id=telegram_chat_id,
        telegram_enabled=bool(telegram_enabled),
        telegram_events=list(telegram_events or []),
        active=bool(active),
        paused_until=paused_until.isoformat() if paused_until is not None else None,
    )


def load_profiles() -> list[AgentProfile]:
    with conn() as c, c.cursor() as cur:
        cur.execute(f"SELECT {_COLUMNS} FROM agent_profiles ORDER BY created_at ASC")
        return [_row_to_profile(r) for r in cur.fetchall()]


def get_profile(user_addr: str) -> AgentProfile | None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM agent_profiles WHERE user_addr = %s",
            (user_addr.lower(),),
        )
        row = cur.fetchone()
        return _row_to_profile(row) if row else None


def is_runnable(p: AgentProfile, now: int | None = None) -> bool:
    """Returns True iff the runner can autonomously trade for this profile.

    Requires a Circle Developer-Controlled wallet (circle_wallet_id): Circle
    MPC signs the approve+buy server-side. Profiles must also be active and
    not currently paused.
    """
    if not p.active:
        return False
    if p.circle_wallet_id is None:
        return False
    if p.paused_until is not None:
        try:
            paused_until = datetime.fromisoformat(p.paused_until.replace("Z", "+00:00"))
            if paused_until.tzinfo is None:
                paused_until = paused_until.replace(tzinfo=timezone.utc)
            if paused_until > datetime.now(timezone.utc):
                return False
        except ValueError:
            return False
    return True


def matches_market(
    p: AgentProfile, market_addr: str, market_category: str
) -> bool:
    if p.markets_mode == "all":
        return True
    if p.markets_mode == "categories":
        return market_category in p.categories
    if p.markets_mode == "watchlist":
        return market_addr.lower() in {w.lower() for w in p.watchlist}
    return False
