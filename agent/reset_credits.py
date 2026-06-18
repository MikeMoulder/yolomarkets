"""One-off ops: reset every user's included scan quota to their tier grant.

Non-destructive by design — it only touches agent_credits.balance and
free_credits_refill_at. Trade history (agent_decisions), profiles, and
subscriptions are left untouched, so the /agent feed and tier assignments
survive. The rolling daily trade / brain / spend caps are derived from
agent_decisions over the last 24h, so they clear on their own; this script
only resets the persistent included-quota balance.

Usage:
    cd agent && uv run python reset_credits.py            # dry run (prints plan)
    cd agent && uv run python reset_credits.py --apply    # write changes
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Load DATABASE_URL from the repo-root .env before importing db.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from circle_wallets import FREE_CREDITS_PER_TIER  # noqa: E402
from credits import _next_daily_refill, get_subscription_tier  # noqa: E402
from db import conn  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--apply",
        action="store_true",
        help="write the reset (default: dry run that only prints the plan)",
    )
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    next_refill = _next_daily_refill(now)

    with conn() as c, c.cursor() as cur:
        cur.execute("SELECT user_addr, balance FROM agent_credits ORDER BY user_addr")
        rows = cur.fetchall()
        if not rows:
            print("no agent_credits rows — nothing to reset")
            return 0

        plan: list[tuple[str, int, str, int]] = []
        for user_addr, balance in rows:
            tier = get_subscription_tier(user_addr)
            grant = FREE_CREDITS_PER_TIER.get(tier, FREE_CREDITS_PER_TIER["free"])
            plan.append((user_addr, int(balance), tier, grant))

        for user_addr, balance, tier, grant in plan:
            arrow = "=" if balance == grant else "->"
            print(f"  {user_addr}  tier={tier:<5}  balance {balance} {arrow} {grant}")
        print(
            f"{len(plan)} user(s); free_credits_refill_at -> {next_refill.isoformat()}"
        )

        if not args.apply:
            print("dry run — re-run with --apply to write the changes")
            return 0

        for user_addr, _balance, _tier, grant in plan:
            cur.execute(
                """
                UPDATE agent_credits
                   SET balance = %s,
                       free_credits_refill_at = %s,
                       updated_at = NOW()
                 WHERE user_addr = %s
                """,
                (grant, next_refill, user_addr),
            )
        print(f"reset {len(plan)} user(s) to their tier grant")

    return 0


if __name__ == "__main__":
    sys.exit(main())
