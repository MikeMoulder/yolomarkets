"""Agent credit system — tracks AI brain usage credits per user.

Credits are consumed per brain run (cost depends on brain tier).
When balance hits 0 the runner falls back to paper-trade mode.
A free monthly grant is refilled automatically on the 1st of each month.

Debit order per agent tick:
  1. Check subscription tier → determine credit cost + allowed signals
  2. If balance < cost_for_run → set paper=True, skip broadcast
  3. Else → deduct credits atomically, allow live trade

This module is pure Python / Postgres; no on-chain interaction.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

from db import conn
from circle_wallets import BRAIN_CREDITS, FREE_CREDITS_PER_TIER, SUBSCRIPTION_PRICE


# ── Credit queries ─────────────────────────────────────────────────────────

def get_balance(user_addr: str) -> int:
    """Return current credit balance for user. Returns 0 if no row."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT balance FROM agent_credits WHERE user_addr = %s",
            (user_addr.lower(),),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def ensure_credits_row(user_addr: str) -> None:
    """Create credits row for user if missing (called at profile creation)."""
    addr = user_addr.lower()
    now = datetime.now(timezone.utc)
    # First refill on the 1st of next month.
    if now.month == 12:
        next_refill = now.replace(year=now.year + 1, month=1, day=1,
                                  hour=0, minute=0, second=0, microsecond=0)
    else:
        next_refill = now.replace(month=now.month + 1, day=1,
                                  hour=0, minute=0, second=0, microsecond=0)
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_credits (user_addr, balance, free_credits_refill_at, updated_at)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (user_addr) DO NOTHING
            """,
            (addr, FREE_CREDITS_PER_TIER["free"], next_refill),
        )
        c.commit()


def deduct_credits(user_addr: str, amount: int) -> bool:
    """Deduct `amount` credits atomically. Returns True on success.

    Returns False (and does NOT deduct) if balance would go negative.
    Uses SELECT … FOR UPDATE to prevent race conditions in multi-worker runs.
    """
    addr = user_addr.lower()
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT balance FROM agent_credits WHERE user_addr = %s FOR UPDATE",
            (addr,),
        )
        row = cur.fetchone()
        if row is None or int(row[0]) < amount:
            return False
        cur.execute(
            """
            UPDATE agent_credits
            SET balance = balance - %s, updated_at = NOW()
            WHERE user_addr = %s
            """,
            (amount, addr),
        )
        c.commit()
        return True


def add_credits(user_addr: str, amount: int) -> int:
    """Add `amount` credits and return new balance. Creates row if missing."""
    addr = user_addr.lower()
    ensure_credits_row(addr)
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_credits
            SET balance = balance + %s, updated_at = NOW()
            WHERE user_addr = %s
            RETURNING balance
            """,
            (amount, addr),
        )
        row = cur.fetchone()
        c.commit()
        return int(row[0]) if row else amount


def update_cost_basis(user_addr: str, deposit_usdc: float) -> None:
    """Record a USDC deposit — adds to cost basis for profit-share calc."""
    addr = user_addr.lower()
    ensure_credits_row(addr)
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            UPDATE agent_credits
            SET cost_basis_usdc = cost_basis_usdc + %s, updated_at = NOW()
            WHERE user_addr = %s
            """,
            (deposit_usdc, addr),
        )
        c.commit()


def maybe_refill_free_credits(user_addr: str) -> bool:
    """Refill free credits if the refill timestamp has passed.

    Returns True if credits were refilled.
    Called at the start of each agent loop tick.
    """
    addr = user_addr.lower()
    now = datetime.now(timezone.utc)
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT free_credits_refill_at FROM agent_credits WHERE user_addr = %s FOR UPDATE",
            (addr,),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return False
        refill_at: datetime = row[0]
        if now < refill_at:
            return False

        # Determine tier to know how many free credits to grant.
        cur.execute(
            "SELECT tier FROM agent_subscriptions WHERE user_addr = %s",
            (addr,),
        )
        sub = cur.fetchone()
        tier = sub[0] if sub else "free"
        grant = FREE_CREDITS_PER_TIER.get(tier, FREE_CREDITS_PER_TIER["free"])

        # Next refill is 1st of month after next_refill.
        if refill_at.month == 12:
            next_refill = refill_at.replace(year=refill_at.year + 1, month=1,
                                             day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            next_refill = refill_at.replace(month=refill_at.month + 1, day=1,
                                             hour=0, minute=0, second=0, microsecond=0)

        cur.execute(
            """
            UPDATE agent_credits
            SET balance = balance + %s,
                free_credits_refill_at = %s,
                updated_at = NOW()
            WHERE user_addr = %s
            """,
            (grant, next_refill, addr),
        )
        c.commit()
        return True


# ── Subscription helpers ───────────────────────────────────────────────────

def get_subscription_tier(user_addr: str) -> str:
    """Return current effective subscription tier ('free' if no row)."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT tier, expires_at FROM agent_subscriptions WHERE user_addr = %s",
            (user_addr.lower(),),
        )
        row = cur.fetchone()
        if row is None:
            return "free"
        tier, expires_at = row
        if expires_at is not None and datetime.now(timezone.utc) > expires_at:
            # Expired — effective tier is free.
            return "free"
        return str(tier)


def ensure_subscription_row(user_addr: str) -> None:
    """Create a free-tier subscription row for user if missing."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_subscriptions (user_addr, tier)
            VALUES (%s, 'free')
            ON CONFLICT (user_addr) DO NOTHING
            """,
            (user_addr.lower(),),
        )
        c.commit()


def credit_cost_for_run(brain_model: str) -> int:
    """Return credits consumed by one brain run for the given model tier."""
    return BRAIN_CREDITS.get(brain_model, BRAIN_CREDITS["standard"])


def can_trade_live(user_addr: str) -> bool:
    """Returns True if the user's subscription tier permits live trading."""
    tier = get_subscription_tier(user_addr)
    return tier in ("active", "pro")
