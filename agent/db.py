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

_REQUIRED_COLUMNS: dict[str, set[str]] = {
    # Added in Phase A economics migration.
    "agent_profiles": {"preset", "telegram_enabled", "telegram_chat_id", "telegram_events"},
    # Added in Phase 5 decision trace migration.
    "agent_decisions": {
        "news_summary",
        "tool_trace",
        "brain_model",
        "brain_iterations",
        "prompt_hash",
        "tools_called",
        "external_odds_snapshot",
        "policy_snapshot",
        "platform_fee_usdc",
        "notification_status",
    },
    # Agent v2 · M1 — memory & narrative (migration 0009_agent_memory.sql).
    "agent_theses": {"scope", "stance", "conviction", "status"},
    "agent_journal": {"trigger", "body", "kind"},
    "agent_preferences": {"key", "value"},
}


def _get_pool() -> ConnectionPool:
    global _POOL
    if _POOL is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL not set — see .env.example (Neon connection string)"
            )
        # Neon closes idle connections (default idle timeout ~5 min), so a
        # connection that sat between runner ticks (180s apart) can be dead by
        # the time the pool hands it out — the symptom was "server closed the
        # connection unexpectedly" crashing the whole pass. Two guards:
        #   • check=check_connection — the pool runs a cheap liveness probe and
        #     transparently discards + reopens a dead connection before yielding
        #     it, so callers never see the stale socket.
        #   • max_idle below Neon's idle timeout — idle connections are recycled
        #     proactively rather than waiting to be killed server-side.
        _POOL = ConnectionPool(
            url,
            min_size=1,
            max_size=4,
            open=True,
            check=ConnectionPool.check_connection,
            max_idle=float(os.environ.get("AGENT_DB_MAX_IDLE_S", "120")),
        )
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


def assert_schema_compatible() -> None:
    """Fail fast if Neon/Postgres is behind required runner schema.

    This avoids a long startup followed by `UndefinedColumn` crashes later in
    the loop. The fix is always to apply web migrations against DATABASE_URL.
    """
    tables = tuple(_REQUIRED_COLUMNS.keys())
    placeholders = ", ".join(["%s"] * len(tables))
    with conn() as c, c.cursor() as cur:
        cur.execute(
            f"""
            SELECT table_name, column_name
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name IN ({placeholders})
            """,
            tables,
        )
        rows = cur.fetchall()

    found: dict[str, set[str]] = {t: set() for t in _REQUIRED_COLUMNS}
    for table_name, column_name in rows:
        if table_name in found:
            found[table_name].add(column_name)

    missing: list[str] = []
    for table_name, required in _REQUIRED_COLUMNS.items():
        for column_name in sorted(required - found.get(table_name, set())):
            missing.append(f"{table_name}.{column_name}")

    if missing:
        missing_str = ", ".join(missing)
        raise RuntimeError(
            "Database schema is behind the runner code. "
            f"Missing column(s): {missing_str}. "
            "Run: cd web && npm run db:migrate"
        )


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
                news_summary, tool_trace, brain_model, brain_iterations,
                prompt_hash, tools_called, external_odds_snapshot,
                policy_snapshot, platform_fee_usdc, notification_status
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s::jsonb, %s,
                %s, %s,
                %s, %s::jsonb, %s, %s,
                %s, %s::jsonb, %s::jsonb,
                %s::jsonb, %s, %s
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
                payload.get("prompt_hash"),
                json.dumps(payload.get("tools_called") or []),
                json.dumps(payload.get("external_odds_snapshot") or {}),
                json.dumps(payload.get("policy_snapshot") or {}),
                payload.get("platform_fee_usdc") or 0,
                payload.get("notification_status"),
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


def user_bucket_spent_since(
    user_addr: str, bucket: str, since_unix: int
) -> float:
    """Sum live trade spend for rows whose policy snapshot tagged a bucket."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT COALESCE(SUM(cost_usdc), 0)
              FROM agent_decisions
             WHERE user_addr = %s
               AND action IN ('buy_yes', 'buy_no')
               AND paper = FALSE
               AND ts >= to_timestamp(%s)
               AND policy_snapshot->>'risk_bucket' = %s
            """,
            (user_addr.lower(), since_unix, bucket),
        )
        row = cur.fetchone()
        return float(row[0]) if row and row[0] is not None else 0.0


def user_traded_markets_since(user_addr: str, since_unix: int) -> set[str]:
    """Markets with recent live non-pass trades; used for repeat cooldown."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT lower(market)
              FROM agent_decisions
             WHERE user_addr = %s
               AND action IN ('buy_yes', 'buy_no')
               AND paper = FALSE
               AND ts >= to_timestamp(%s)
            """,
            (user_addr.lower(), since_unix),
        )
        return {str(r[0]) for r in cur.fetchall()}


def user_live_trade_count_since(user_addr: str, since_unix: int) -> int:
    """Count live non-pass trades in the window."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
              FROM agent_decisions
             WHERE user_addr = %s
               AND action IN ('buy_yes', 'buy_no')
               AND paper = FALSE
               AND ts >= to_timestamp(%s)
            """,
            (user_addr.lower(), since_unix),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def user_brain_run_count_since(user_addr: str, since_unix: int) -> int:
    """Count model-backed decisions in the window.

    This is the closest durable proxy for paid AI scans. A scan that fails
    before producing a decision is intentionally not counted here; the runner
    still keeps an in-process per-run count to avoid loops during outages.
    """
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
              FROM agent_decisions
             WHERE user_addr = %s
               AND brain_model IS NOT NULL
               AND ts >= to_timestamp(%s)
            """,
            (user_addr.lower(), since_unix),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def get_telegram_settings(user_addr: str) -> dict[str, Any] | None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT telegram_enabled, telegram_chat_id, telegram_events
              FROM agent_profiles
             WHERE user_addr = %s
            """,
            (user_addr.lower(),),
        )
        row = cur.fetchone()
        if not row:
            return None
        enabled, chat_id, events = row
        return {
            "enabled": bool(enabled),
            "chat_id": chat_id,
            "events": list(events or []),
        }


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


# ── Agent memory & narrative (Agent v2 · M1) ───────────────────────────────
# Written by the agent core (both the autonomous loop and, later, the chat
# handler). jsonb columns come back from psycopg v3 already parsed (dict/list),
# so reads need no json.loads; writes cast with %s::jsonb like insert_decision.


def insert_journal(
    *,
    user_addr: str,
    trigger: str,
    body: str,
    kind: str = "note",
    market: str | None = None,
    title: str = "",
    meta: dict[str, Any] | None = None,
    decision_id: int | None = None,
    ts: datetime | None = None,
) -> int:
    """Append a first-person journal entry. Returns the new row id.

    `trigger` is autonomous | chat | trade | reflect; `kind` is a finer label
    (plan | decision | reflection | trade | message | note).
    """
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_journal
                (ts, user_addr, trigger, kind, market, title, body, meta, decision_id)
            VALUES (COALESCE(%s, now()), %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            RETURNING id
            """,
            (
                ts,
                user_addr.lower(),
                trigger,
                kind,
                (market.lower() if market else None),
                title,
                body,
                json.dumps(meta or {}),
                decision_id,
            ),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def recent_journal(
    user_addr: str, limit: int = 20, market: str | None = None
) -> list[dict[str, Any]]:
    """Most-recent journal entries for a user (optionally one market), newest first."""
    query = (
        "SELECT id, ts, trigger, kind, market, title, body, meta, decision_id "
        "FROM agent_journal WHERE user_addr = %s"
    )
    params: list[Any] = [user_addr.lower()]
    if market:
        query += " AND market = %s"
        params.append(market.lower())
    query += " ORDER BY ts DESC LIMIT %s"
    params.append(int(limit))
    with conn() as c, c.cursor() as cur:
        cur.execute(query, tuple(params))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def upsert_thesis(
    *,
    user_addr: str,
    scope: str,
    subject: str,
    stance: str,
    conviction: float,
    rationale: str = "",
    evidence: list[str] | None = None,
    status: str = "active",
    market: str | None = None,
    bucket: str | None = None,
    revisit_at: datetime | None = None,
) -> int:
    """Insert or update the user's thesis for `scope` (one row per user+scope).

    `scope` is the natural key: a lower-cased market address, or 'bucket:<name>'
    for a bucket-level view. Returns the row id.
    """
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_theses
                (user_addr, scope, market, bucket, subject, stance, conviction,
                 rationale, evidence, status, revisit_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, now())
            ON CONFLICT (user_addr, scope) DO UPDATE SET
                market     = EXCLUDED.market,
                bucket     = EXCLUDED.bucket,
                subject    = EXCLUDED.subject,
                stance     = EXCLUDED.stance,
                conviction = EXCLUDED.conviction,
                rationale  = EXCLUDED.rationale,
                evidence   = EXCLUDED.evidence,
                status     = EXCLUDED.status,
                revisit_at = EXCLUDED.revisit_at,
                updated_at = now()
            RETURNING id
            """,
            (
                user_addr.lower(),
                scope,
                (market.lower() if market else None),
                bucket,
                subject,
                stance,
                float(conviction),
                rationale,
                json.dumps(evidence or []),
                status,
                revisit_at,
            ),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def get_theses(user_addr: str, status: str | None = "active") -> list[dict[str, Any]]:
    """Load the user's theses (default: active only), most-recently-updated first."""
    query = (
        "SELECT id, scope, market, bucket, subject, stance, conviction, "
        "rationale, evidence, status, revisit_at, updated_at "
        "FROM agent_theses WHERE user_addr = %s"
    )
    params: list[Any] = [user_addr.lower()]
    if status is not None:
        query += " AND status = %s"
        params.append(status)
    query += " ORDER BY updated_at DESC"
    with conn() as c, c.cursor() as cur:
        cur.execute(query, tuple(params))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def set_thesis_status(user_addr: str, scope: str, status: str) -> None:
    """Mark a thesis closed/expired without rewriting the rest of the row."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "UPDATE agent_theses SET status = %s, updated_at = now() "
            "WHERE user_addr = %s AND scope = %s",
            (status, user_addr.lower(), scope),
        )


def expire_stale_theses(user_addr: str, ttl_days: int = 14) -> int:
    """Auto-expire active theses not refreshed within ttl_days — keeps agent
    memory from accumulating stale views over time. Returns how many expired.
    (revisit_at is handled separately: it's surfaced to the planner so it
    reconsiders due theses, rather than auto-expiring them.)"""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_theses
               SET status = 'expired', updated_at = now()
             WHERE user_addr = %s
               AND status = 'active'
               AND updated_at < now() - (%s * interval '1 day')
            """,
            (user_addr.lower(), int(ttl_days)),
        )
        return cur.rowcount


def upsert_preference(
    user_addr: str, key: str, value: Any, source: str = "chat"
) -> None:
    """Store a preference learned about a user (one row per user+key)."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_preferences (user_addr, key, value, source, updated_at)
            VALUES (%s, %s, %s::jsonb, %s, now())
            ON CONFLICT (user_addr, key) DO UPDATE SET
                value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
            """,
            (user_addr.lower(), key, json.dumps(value), source),
        )


def get_preferences(user_addr: str) -> dict[str, Any]:
    """All preferences for a user as a {key: value} dict (values already parsed)."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT key, value FROM agent_preferences WHERE user_addr = %s",
            (user_addr.lower(),),
        )
        return {k: v for k, v in cur.fetchall()}


# ── Catalog + decision reads for chat (Agent v2 · M2) ──────────────────────
# market_index is maintained by the web catalog indexer (scripts/catalog-indexer);
# price_yes there is the raw on-chain int (18-dec). Reads degrade gracefully — if
# the table is missing/empty the chat tool just returns nothing.

def search_market_index(
    query: str,
    limit: int = 8,
    include_resolved: bool = False,
    include_expired: bool = False,
) -> list[dict[str, Any]]:
    """Text search over the catalog by question. Returns only tradeable markets
    (unresolved AND unexpired) by default — an expired-but-unresolved market is
    awaiting resolution, not something to trade. Soonest-deadline first."""
    sql = (
        "SELECT address, question, category, price_yes, deadline, legacy, resolved "
        "FROM market_index WHERE question ILIKE %s"
    )
    params: list[Any] = [f"%{query.strip()}%"]
    if not include_resolved:
        sql += " AND NOT resolved"
    if not include_expired:
        sql += " AND deadline > EXTRACT(EPOCH FROM now())"
    sql += " ORDER BY resolved ASC, deadline ASC LIMIT %s"
    params.append(int(limit))
    with conn() as c, c.cursor() as cur:
        cur.execute(sql, tuple(params))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def get_market_index(address: str) -> dict[str, Any] | None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT address, question, category, price_yes, deadline, legacy, "
            "resolved, outcome, total_liquidity "
            "FROM market_index WHERE lower(address) = %s",
            (address.lower(),),
        )
        row = cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in cur.description]
        return dict(zip(cols, row))


def active_market_rows(limit: int = 300) -> list[dict[str, Any]]:
    """Unresolved catalog rows — the bounded market set a chat portfolio scan
    checks the user's wallets against."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT address, question, category, price_yes, deadline "
            "FROM market_index WHERE NOT resolved ORDER BY deadline ASC LIMIT %s",
            (int(limit),),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def recent_decisions(user_addr: str, limit: int = 10) -> list[dict[str, Any]]:
    """Most-recent decisions (trades and passes) for a user — powers 'explain
    your trades' in chat."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT ts, market, question, category, action, pass_reason, cost_usdc,
                   ai_prob, ai_confidence, edge_pts, tx_hash, paper, reasoning
              FROM agent_decisions
             WHERE user_addr = %s
             ORDER BY ts DESC LIMIT %s
            """,
            (user_addr.lower(), int(limit)),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
