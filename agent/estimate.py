"""Day 1 side-track: Polymarket Gamma signal + Claude probability estimate.

Run:
    cd agent
    uv run python estimate.py                  # picks a sample market
    uv run python estimate.py --slug some-slug  # specific Polymarket slug
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests as cffi_requests
from openai import OpenAI
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

# Load .env from the repo root (one level up from agent/)
REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

console = Console()

GAMMA_BASE = os.environ.get("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com")
OPENROUTER_BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
LLM_MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5")


def _gamma_get(path: str, params: dict) -> object:
    # curl_cffi impersonates a real Chrome TLS fingerprint — needed because
    # Polymarket sits behind Cloudflare and rejects Python's default TLS hello.
    r = cffi_requests.get(
        f"{GAMMA_BASE}{path}", params=params, impersonate="chrome", timeout=30
    )
    r.raise_for_status()
    return r.json()


def fetch_one_market(slug: str | None) -> dict:
    """Fetch one active Polymarket market. If slug given, fetch that one; else
    pick the first usable market from a high-volume active list."""
    if slug:
        results = _gamma_get("/markets", {"slug": slug})
        if not results:
            raise SystemExit(f"No market found with slug={slug!r}")
        return results[0] if isinstance(results, list) else results

    markets = _gamma_get(
        "/markets",
        {
            "active": "true",
            "closed": "false",
            "limit": "20",
            "order": "volume24hr",
            "ascending": "false",
        },
    )
    if not markets:
        raise SystemExit("Polymarket returned no active markets")
    for m in markets:
        if m.get("outcomePrices") and m.get("question"):
            return m
    raise SystemExit("Couldn't find a usable market in the first 20")


def parse_yes_price(market: dict) -> float | None:
    """Polymarket returns outcomePrices as a JSON-encoded string like
    '["0.34","0.66"]'. The first entry is YES."""
    raw = market.get("outcomePrices")
    if not raw:
        return None
    try:
        prices = json.loads(raw) if isinstance(raw, str) else raw
        return float(prices[0])
    except (json.JSONDecodeError, IndexError, ValueError, TypeError):
        return None


SYSTEM = """You are a calibrated probability estimator for prediction markets.
Output STRICT JSON only — no prose before or after. Reason from first principles;
do NOT anchor to the market price. When uncertain, lower your confidence score.
Your output is consumed programmatically; any deviation from the schema breaks it."""

USER_TEMPLATE = """MARKET: "{question}"
RESOLUTION CRITERIA: {criteria}
RESOLVES: {deadline}

CROWD SIGNAL:
  Polymarket YES price: {pm_price}%

OUTPUT FORMAT (strict JSON, no markdown fences):
{{
  "probability": 0.0,
  "confidence": 0.0,
  "reasoning": "3 to 5 sentences shown to the user",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal that would change this estimate", "another"],
  "time_sensitivity": "low" | "medium" | "high"
}}
"""


def llm_estimate(question: str, criteria: str, deadline: str, pm_price: float | None) -> dict:
    client = OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=OPENROUTER_BASE,
        # OpenRouter recommends these for usage attribution / better priority.
        default_headers={
            "HTTP-Referer": "https://github.com/yolo-markets",
            "X-Title": "YOLO Markets agent",
        },
    )
    pm_str = f"{pm_price * 100:.1f}" if pm_price is not None else "unknown"
    resp = client.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        # OpenRouter passes this through to providers that support JSON mode.
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": USER_TEMPLATE.format(
                    question=question,
                    criteria=criteria or "(none provided)",
                    deadline=deadline or "(unknown)",
                    pm_price=pm_str,
                ),
            },
        ],
    )
    text = (resp.choices[0].message.content or "").strip()
    # Defensive: strip markdown fences if the model slips
    if text.startswith("```"):
        text = text.strip("`")
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text[:-3]
    return json.loads(text)


def render(market: dict, pm_price: float | None, estimate: dict) -> None:
    question = market.get("question", "(no question)")
    deadline = market.get("endDate") or market.get("end_date_iso") or "(unknown)"

    console.print(Panel.fit(question, title="market", style="bold cyan"))

    t = Table(show_header=False, box=None)
    t.add_column("k", style="dim")
    t.add_column("v")
    t.add_row("Polymarket YES",
              f"{pm_price * 100:.2f}%" if pm_price is not None else "—")
    est_p = estimate.get("probability", 0.0)
    t.add_row("Claude estimate", f"{est_p * 100:.2f}%")
    if pm_price is not None:
        edge = (est_p - pm_price) * 100
        t.add_row("Edge", f"{edge:+.2f} pts")
    t.add_row("Confidence", f"{estimate.get('confidence', 0.0) * 100:.1f}%")
    t.add_row("Time sensitivity", str(estimate.get("time_sensitivity", "—")))
    t.add_row("Resolves", str(deadline))
    console.print(t)

    console.print(Panel(estimate.get("reasoning", ""), title="reasoning", style="dim"))

    if watch := estimate.get("watch_for"):
        console.print("[bold]watch_for:[/bold]")
        for w in watch:
            console.print(f"  • {w}")

    if srcs := estimate.get("key_sources"):
        console.print("[bold]key_sources:[/bold]")
        for s in srcs:
            console.print(f"  • {s}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", help="Polymarket slug to estimate (default: pick top by 24h volume)")
    args = ap.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        console.print(
            "[red]OPENROUTER_API_KEY not set in environment or .env.[/red]\n"
            "Add it to the repo-root .env and re-run."
        )
        return 1

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    console.rule(f"yolo-agent / estimate · {LLM_MODEL} · {now}")
    market = fetch_one_market(args.slug)
    pm_price = parse_yes_price(market)

    estimate = llm_estimate(
        question=market.get("question", ""),
        criteria=market.get("description") or market.get("resolutionSource") or "",
        deadline=market.get("endDate") or "",
        pm_price=pm_price,
    )
    render(market, pm_price, estimate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
