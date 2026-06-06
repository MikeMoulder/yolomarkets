"""Reader for agent profiles, backed by Postgres (agent_profiles table).

Tier-1a migration: replaces the JSON-file store at agent/profiles.json
with the same DB the Next.js wizard writes into. Same dataclass shape
and helpers — call sites in loop.py don't change.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
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
    stop_loss_pct: float | None
    take_profit_pct: float | None
    agent_address: str | None
    session_key_address: str | None
    session_valid_until: int | None    # unix seconds
    session_total_cap: float | None
    session_per_call_cap: float | None
    circle_wallet_id: str | None       # Circle Developer-Controlled wallet ID
    active: bool
    paused_until: str | None


_COLUMNS = (
    "user_addr, pattern, preset, brain_model, reasoning_depth,"
    " cadence_minutes, kelly_mult, edge_threshold,"
    " min_confidence, signals, markets_mode, categories, watchlist,"
    " budget_total, budget_per_market, budget_per_day,"
    " drawdown_pause_pct, min_liquidity_usdc, min_tte_hours, max_tte_hours,"
    " odds_range_min, odds_range_max, max_open_positions,"
    " stop_loss_pct, take_profit_pct,"
    " agent_address, session_key_address, session_valid_until,"
    " session_total_cap, session_per_call_cap, circle_wallet_id,"
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
        stop_loss_pct, take_profit_pct,
        agent_address, session_key_address, session_valid_until,
        session_total_cap, session_per_call_cap, circle_wallet_id,
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
        stop_loss_pct=float(stop_loss_pct) if stop_loss_pct is not None else None,
        take_profit_pct=float(take_profit_pct) if take_profit_pct is not None else None,
        agent_address=agent_address,
        session_key_address=session_key_address,
        session_valid_until=int(session_valid_until) if session_valid_until is not None else None,
        session_total_cap=float(session_total_cap) if session_total_cap is not None else None,
        session_per_call_cap=float(session_per_call_cap) if session_per_call_cap is not None else None,
        circle_wallet_id=circle_wallet_id,
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

    Two valid execution paths:
      · Circle path (preferred): circle_wallet_id is set — Circle MPC signs
        the tx server-side, no session key required.
      · Legacy session-key path: agent_address + session_key_address set
        and session not expired (kept for --legacy mode).
    """
    if not p.active:
        return False
    # Circle path — preferred
    if p.circle_wallet_id is not None:
        return True
    # Legacy session-key path
    if p.agent_address is None or p.session_key_address is None:
        return False
    if p.session_valid_until is None:
        return False
    t = now if now is not None else int(time.time())
    return p.session_valid_until > t


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
