"""Postgres connection pool + helpers for the Python runner.

Reads DATABASE_URL from the repo-root .env (loaded by load_dotenv in loop.py
before this module is imported). Uses psycopg v3 with a tiny built-in pool
so we don't reconnect per tx.

Schema source of truth is web/lib/db/schema.ts — keep column names aligned.
"""

from __future__ import annotations

import atexit
import json
import os
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Iterator

import psycopg
from psycopg_pool import ConnectionPool

_POOL: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _POOL
    if _POOL is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL not set — see .env.example (Neon connection string)"
            )
        _POOL = ConnectionPool(url, min_size=1, max_size=4, open=True)
        atexit.register(_close_pool)
    return _POOL


def _close_pool() -> None:
    global _POOL
    if _POOL is not None:
        try:
            _POOL.close()
        except Exception:
            pass
        _POOL = None


@contextmanager
def conn() -> Iterator[psycopg.Connection]:
    """Yields a connection from the pool, autocommit on."""
    pool = _get_pool()
    with pool.connection() as c:
        c.autocommit = True
        yield c


def insert_decision(d: Any) -> int:
    """Insert a Decision dataclass into agent_decisions. Returns row id.

    Schema source of truth is web/lib/db/schema.ts. The trailing columns
    (news_summary, tool_trace, brain_model, brain_iterations) were added in
    Phase 5 to capture the Claude tool-use brain's trace; legacy single-shot
    decisions leave them at their defaults.
    """
    payload = asdict(d) if not isinstance(d, dict) else d
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_decisions (
                ts, market, question, category,
                market_prob, polymarket_prob, polymarket_slug,
                ai_prob, ai_confidence, edge_pts, kelly_fraction, bankroll_usdc,
                action, pass_reason,
                shares, cost_usdc, max_cost_usdc, tx_hash, paper,
                reasoning, watch_for, time_sensitivity,
                user_addr, agent_addr,
                news_summary, tool_trace, brain_model, brain_iterations
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s::jsonb, %s,
                %s, %s,
                %s, %s::jsonb, %s, %s
            )
            RETURNING id
            """,
            (
                _parse_ts(payload["ts"]),
                payload["market"],
                payload["question"],
                payload["category"],
                payload["market_prob"],
                payload.get("polymarket_prob"),
                payload.get("polymarket_slug"),
                payload["ai_prob"],
                payload["ai_confidence"],
                payload["edge_pts"],
                payload["kelly_fraction"],
                payload["bankroll_usdc"],
                payload["action"],
                payload.get("pass_reason"),
                payload["shares"],
                payload["cost_usdc"],
                payload["max_cost_usdc"],
                payload.get("tx_hash"),
                payload["paper"],
                payload["reasoning"],
                json.dumps(payload.get("watch_for") or []),
                payload["time_sensitivity"],
                (payload.get("user_addr") or None) and payload["user_addr"].lower(),
                (payload.get("agent_addr") or None) and payload["agent_addr"].lower(),
                payload.get("news_summary") or "",
                json.dumps(payload.get("tool_trace") or []),
                payload.get("brain_model"),
                payload.get("brain_iterations"),
            ),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def _parse_ts(ts: Any) -> datetime:
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))


def user_spent_since(user_addr: str, since_unix: int) -> float:
    """Sum of cost_usdc for non-paper, non-pass decisions made by this user
    on or after `since_unix`. Drives the per-day spend gate in loop.py.

    Returns 0.0 if the user has no rows yet — the runner treats absence as
    zero spend, which is the right default for a fresh user.
    """
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT COALESCE(SUM(cost_usdc), 0)
              FROM agent_decisions
             WHERE user_addr = %s
               AND action IN ('buy_yes', 'buy_no')
               AND paper = FALSE
               AND ts >= to_timestamp(%s)
            """,
            (user_addr.lower(), since_unix),
        )
        row = cur.fetchone()
        return float(row[0]) if row and row[0] is not None else 0.0


def user_category_spent_since(
    user_addr: str, category: str, since_unix: int
) -> float:
    """Same as user_spent_since but scoped to one market category — used as
    a proxy for correlation. Two markets in the same category (e.g. two
    BTC-price questions) are treated as one risk bucket."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT COALESCE(SUM(cost_usdc), 0)
              FROM agent_decisions
             WHERE user_addr = %s
               AND category = %s
               AND action IN ('buy_yes', 'buy_no')
               AND paper = FALSE
               AND ts >= to_timestamp(%s)
            """,
            (user_addr.lower(), category, since_unix),
        )
        row = cur.fetchone()
        return float(row[0]) if row and row[0] is not None else 0.0


def get_last_run_at(user_addr: str) -> datetime | None:
    """Return the last_run_at timestamp for a user's session, or None."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT last_run_at FROM agent_session_keys WHERE user_addr = %s",
            (user_addr.lower(),),
        )
        row = cur.fetchone()
        return row[0] if row and row[0] else None


def set_last_run_at(user_addr: str, ts: datetime | None = None) -> None:
    """Stamp last_run_at on the user's session row (insert-if-missing).
    Lets the scheduler survive worker restarts. No-op if session row absent."""
    when = ts if ts is not None else datetime.now(timezone.utc)
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_session_keys SET last_run_at = %s
            WHERE user_addr = %s
            """,
            (when, user_addr.lower()),
        )
