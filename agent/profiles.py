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
    agent_address: str | None
    session_key_address: str | None
    session_valid_until: int | None    # unix seconds
    session_total_cap: float | None
    session_per_call_cap: float | None
    active: bool
    paused_until: str | None


_COLUMNS = (
    "user_addr, pattern, cadence_minutes, kelly_mult, edge_threshold,"
    " min_confidence, signals, markets_mode, categories, watchlist,"
    " budget_total, budget_per_market, budget_per_day,"
    " agent_address, session_key_address, session_valid_until,"
    " session_total_cap, session_per_call_cap, active, paused_until"
)


def _row_to_profile(row: tuple) -> AgentProfile:
    (
        user_addr, pattern, cadence_minutes, kelly_mult, edge_threshold,
        min_confidence, signals, markets_mode, categories, watchlist,
        budget_total, budget_per_market, budget_per_day,
        agent_address, session_key_address, session_valid_until,
        session_total_cap, session_per_call_cap, active, paused_until,
    ) = row
    return AgentProfile(
        user_addr=user_addr,
        pattern=pattern,
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
        agent_address=agent_address,
        session_key_address=session_key_address,
        session_valid_until=int(session_valid_until) if session_valid_until is not None else None,
        session_total_cap=float(session_total_cap) if session_total_cap is not None else None,
        session_per_call_cap=float(session_per_call_cap) if session_per_call_cap is not None else None,
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
    """Returns True iff the runner can autonomously trade for this profile:
    active, agent + session deployed on-chain, session not expired."""
    if not p.active:
        return False
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
