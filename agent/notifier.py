"""User notifications for agent decisions."""

from __future__ import annotations

import os
from typing import Any

import httpx

from db import get_telegram_settings


def notify_decision(user_addr: str, decision: Any) -> str:
    """Send a Telegram notification if the user enabled it.

    Returns a short status string stored on the decision row. Notification
    delivery is intentionally best-effort: a Telegram outage must never block
    trade execution or decision persistence.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return "telegram_not_configured"

    try:
        settings = get_telegram_settings(user_addr)
    except Exception as e:  # noqa: BLE001
        return f"telegram_settings_error:{type(e).__name__}"
    if not settings or not settings.get("enabled") or not settings.get("chat_id"):
        return "telegram_disabled"

    events = set(settings.get("events") or ["live_trade", "paper_trade", "risk_pass"])
    event = _event_for(decision)
    if event not in events:
        return f"telegram_skipped:{event}"

    text = _format_message(decision, event)
    try:
        resp = httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={
                "chat_id": settings["chat_id"],
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        return "telegram_sent"
    except Exception as e:  # noqa: BLE001
        return f"telegram_error:{type(e).__name__}"


def _event_for(decision: Any) -> str:
    if decision.action in ("buy_yes", "buy_no") and not decision.paper:
        return "live_trade"
    if decision.action in ("buy_yes", "buy_no") and decision.paper:
        return "paper_trade"
    return "risk_pass"


def _format_message(decision: Any, event: str) -> str:
    action = {
        "buy_yes": "BUY YES",
        "buy_no": "BUY NO",
        "pass": "PASS",
    }.get(decision.action, str(decision.action).upper())
    mode = "live" if not decision.paper else "paper"
    edge = f"{decision.edge_pts:+.1f}pt"
    size = f"${decision.cost_usdc:.2f}" if decision.cost_usdc else "$0.00"
    reason = decision.pass_reason or decision.reasoning
    tx = f"\nTx: {decision.tx_hash}" if decision.tx_hash else ""
    return (
        f"<b>YOLO agent {action}</b> ({mode})\n"
        f"{decision.question[:220]}\n\n"
        f"Edge: {edge} | Confidence: {decision.ai_confidence:.0%} | Size: {size}\n"
        f"Market: {decision.market}\n"
        f"Reason: {str(reason)[:500]}{tx}"
    )
