"""Agent core (Agent v2 · M1).

`run_agent_turn` is the one tool-use primitive both entrypoints use — the
autonomous planner/reflect turns today, the chat handler in M2/M3. It
generalizes brain.py's OpenRouter tool loop: system + user prompt, a filtered
tool belt (tools.py), a bounded iteration budget, optional strict-JSON final.

`plan_pass` and `reflect_pass` wrap it into the autonomous lifecycle around the
existing per-market scoring:

    perceive (deterministic) → PLAN (this file) → score (brain.estimate)
        → act (risk gate + Circle, loop.py) → REFLECT (this file)

Both passes are fail-safe: if the model call fails, the autonomous loop still
runs on the deterministic shortlist and a minimal journal entry is written, so
enabling the planner can never *stop* the agent from trading.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from rich.console import Console
from openai import APIStatusError, APIError

from tools import ToolContext, tool_schemas, dispatch, PLAN_TOOLS, REFLECT_TOOLS

console = Console()

DEFAULT_MAX_ITERS = int(os.environ.get("AGENT_TURN_MAX_ITERS", "6"))
# Hard ceiling on how many markets a planner run hands to the (paid) scorer,
# regardless of shortlist size — bounds per-tick scoring cost.
DEEP_DIVE_HARD_CAP = int(os.environ.get("AGENT_DEEP_DIVE_CAP", "8"))


@dataclass
class AgentTurnResult:
    text: str
    parsed: dict[str, Any] | None
    tool_trace: list[dict[str, Any]]
    iterations: int
    usage: dict[str, int]


@dataclass
class Plan:
    deep_dive: list[str]                       # market addresses to score, best first
    notes: str = ""
    watching: list[str] = field(default_factory=list)
    tool_trace: list[dict[str, Any]] = field(default_factory=list)
    from_model: bool = False                   # False → deterministic fallback


# ── The shared tool-use primitive ──────────────────────────────────────────
def run_agent_turn(
    *,
    system_prompt: str,
    user_prompt: str,
    ctx: ToolContext,
    tool_names: tuple[str, ...] | list[str],
    model: str,
    max_tokens: int | None = None,
    max_iterations: int | None = None,
    expect_json: bool = True,
) -> AgentTurnResult | None:
    """Run one bounded tool-use conversation. Returns None only if the client
    can't be built (no API key) or every model call errors."""
    from brain import (
        _client,
        BRAIN_MAX_TOKENS,
        BRAIN_TEMPERATURE,
        OPENROUTER_REASONING_EFFORT,
        _extract_json_payload,
    )

    try:
        client = _client()
    except RuntimeError as e:
        console.print(f"[red]{e}[/red]")
        return None

    max_tokens = max_tokens or BRAIN_MAX_TOKENS
    max_iterations = max_iterations or DEFAULT_MAX_ITERS
    schemas = tool_schemas(tool_names)

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}
            ],
        },
        {"role": "user", "content": user_prompt},
    ]
    tool_trace: list[dict[str, Any]] = []
    total_usage = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    asked_json_retry = False

    for iteration in range(max_iterations):
        create_kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": BRAIN_TEMPERATURE,
            "messages": messages,
            "extra_body": {
                "reasoning": {"effort": OPENROUTER_REASONING_EFFORT},
                "thinking": {"type": "adaptive"},
                "transforms": [],
            },
        }
        if schemas:
            create_kwargs["tools"] = schemas
            create_kwargs["tool_choice"] = "auto"

        try:
            resp = client.chat.completions.create(**create_kwargs)
        except APIStatusError as e:
            console.print(f"[red]agent turn status={e.status_code}: {str(e)[:200]}[/red]")
            return None
        except APIError as e:
            console.print(f"[red]agent turn api iter={iteration}: {e}[/red]")
            return None

        if resp.usage:
            raw = resp.usage.model_dump() if hasattr(resp.usage, "model_dump") else {}
            for k in total_usage:
                v = raw.get(k)
                if isinstance(v, (int, float)):
                    total_usage[k] += int(v)

        choice = resp.choices[0]
        msg = choice.message
        finish = choice.finish_reason

        assistant_turn: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            assistant_turn["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ]
        messages.append(assistant_turn)

        # Final answer (no more tool calls).
        if finish == "stop" and not msg.tool_calls:
            text = msg.content or ""
            parsed = _extract_json_payload(text) if expect_json else None
            if not expect_json or parsed is not None:
                return AgentTurnResult(text, parsed, tool_trace, iteration + 1, total_usage)
            if not asked_json_retry:
                asked_json_retry = True
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Return ONLY a valid JSON object matching the schema. "
                            "No markdown fences, no prose."
                        ),
                    }
                )
                continue
            return AgentTurnResult(text, None, tool_trace, iteration + 1, total_usage)

        if not msg.tool_calls:
            # length / content_filter — return whatever we have.
            console.print(f"[yellow]agent turn finish={finish}, no tools, no final[/yellow]")
            return AgentTurnResult(msg.content or "", None, tool_trace, iteration + 1, total_usage)

        for tc in msg.tool_calls:
            name = tc.function.name
            elapsed_ms = 0
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError as e:
                result, is_error, args = {"error": f"bad tool args JSON: {e}"}, True, {}
            else:
                t0 = time.monotonic()
                result, is_error = dispatch(ctx, name, args)
                elapsed_ms = int((time.monotonic() - t0) * 1000)
            tool_trace.append(
                {
                    "iteration": iteration,
                    "name": name,
                    "input": args,
                    "result": result,
                    "is_error": is_error,
                    "elapsed_ms": elapsed_ms,
                }
            )
            messages.append(
                {"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result, default=str)}
            )

    console.print(f"[yellow]agent turn hit max_iterations={max_iterations}[/yellow]")
    return AgentTurnResult("", None, tool_trace, max_iterations, total_usage)


# ── Prompt builders ────────────────────────────────────────────────────────
def _fmt_candidates(markets: list[Any], limit: int) -> str:
    now = int(time.time())
    lines = []
    for m in markets[:limit]:
        tte_h = (m.deadline - now) / 3600.0
        lines.append(
            f"- {m.address}  [{m.category}]  yes={m.price_yes*100:.0f}%  "
            f"tte={tte_h:.1f}h  liq=${m.total_liquidity:.0f}  "
            f"q={m.question[:90]}"
        )
    if len(markets) > limit:
        lines.append(f"…and {len(markets) - limit} more (lower priority, omitted).")
    return "\n".join(lines) if lines else "(no candidate markets in scope)"


PLAN_SYSTEM = """You are the planning mind of an autonomous prediction-market
trading agent on YOLO Markets (Arc, USDC-settled). This is the PLAN step: you
review your standing views and portfolio, decide which markets are worth a
detailed, paid research pass this run, and update your theses. You do NOT place
trades here — a separate scorer and a deterministic risk gate handle that after
you.

Do this, in order:
  1. Call read_theses to recall your current views. Call read_portfolio to see
     open positions, bankroll, and exposure by bucket.
  2. Consider the candidate markets in the user message. Prefer markets where
     you have (or can form) an edge, that fit your strategy, and that diversify
     rather than concentrate your exposure.
  3. Update memory with write_thesis for any view that changed, is newly formed,
     or should be closed/expired. Keep theses specific and falsifiable; set
     revisit_hours when a view is time-sensitive.
  4. Optionally use check_trade to sanity-check whether a position would even be
     allowed before spending a research slot on it.
  5. Pick the markets to deep-dive this run — best first, at most {cap}. Fewer is
     fine; an empty list is valid if nothing is worth the spend.

Output STRICT JSON as your final message, no prose, no fences:
{{
  "deep_dive": ["<market address>", ...],   // chosen from the candidates, best first
  "notes": "<1-3 sentences: your plan and why>",
  "watching": ["<signal that would change your plan>", ...]
}}"""


REFLECT_SYSTEM = """You are the reflecting mind of an autonomous prediction-market
trading agent on YOLO Markets. This is the REFLECT step at the end of a run.
Given what you did this run, briefly take stock and update your memory so the
next run is smarter.

Do this:
  1. Call write_journal once with a short, first-person reflection (kind
     "reflection"): what you did this run, what you learned, what you're
     watching. Be concrete and honest — a pass with no trades is fine to say so.
  2. Call write_thesis to adjust any view that this run changed (e.g. a market
     you traded, or one you decided to avoid). Close or expire stale theses.

You have no strict output schema; end with a one-line plain-text summary."""


def _plan_user_prompt(ctx: ToolContext, shortlist: list[Any], cap: int) -> str:
    policy = ctx.policy
    preset = getattr(policy, "preset", "?")
    kelly = getattr(policy, "kelly_mult", "?")
    edge = getattr(policy, "edge_threshold", "?")
    return (
        f"RUN CONTEXT\n"
        f"  Strategy: {preset} (kelly {kelly}x, min edge {edge})\n"
        f"  Tier: {ctx.tier}   Bankroll: ${ctx.bankroll_usdc:.2f}\n"
        f"  Open positions: {ctx.portfolio.open_position_count() if ctx.portfolio else 0}\n"
        f"  Deep-dive budget this run: up to {cap} markets.\n\n"
        f"CANDIDATE MARKETS (already pre-filtered & prioritized)\n"
        f"{_fmt_candidates(shortlist, limit=25)}\n\n"
        f"Begin: recall theses + portfolio, update memory, then output the plan JSON."
    )


# ── Lifecycle passes ───────────────────────────────────────────────────────
def _deep_dive_cap(ctx: ToolContext, shortlist_len: int) -> int:
    per_run = int(getattr(ctx.policy, "max_trades_per_run", 2) or 2)
    return max(1, min(DEEP_DIVE_HARD_CAP, per_run * 2, shortlist_len))


def plan_pass(ctx: ToolContext, *, shortlist: list[Any], model: str) -> Plan:
    """Planner turn. Returns a Plan whose deep_dive is a subset of `shortlist`
    (by address). Falls back to the deterministic head of the shortlist if the
    model is unavailable or returns nothing usable."""
    cap = _deep_dive_cap(ctx, len(shortlist))
    valid_addrs = {m.address.lower(): m.address for m in shortlist}

    def fallback(note: str) -> Plan:
        picks = [m.address for m in shortlist[:cap]]
        try:
            from db import insert_journal

            insert_journal(
                user_addr=ctx.user_addr,
                trigger=ctx.trigger,
                kind="plan",
                title="Deterministic plan",
                body=(
                    f"Planner unavailable ({note}); scoring the top {len(picks)} "
                    f"pre-prioritized market(s) of {len(shortlist)} in scope."
                ),
                meta={"deep_dive": picks, "fallback": True},
            )
        except Exception:  # noqa: BLE001
            pass
        return Plan(deep_dive=picks, notes=note, from_model=False)

    if not shortlist:
        return Plan(deep_dive=[], notes="no candidate markets in scope", from_model=False)

    try:
        result = run_agent_turn(
            system_prompt=PLAN_SYSTEM.format(cap=cap),
            user_prompt=_plan_user_prompt(ctx, shortlist, cap),
            ctx=ctx,
            tool_names=PLAN_TOOLS,
            model=model,
            expect_json=True,
        )
    except Exception as e:  # noqa: BLE001
        return fallback(f"planner error: {type(e).__name__}")

    if result is None or result.parsed is None:
        return fallback("planner returned no plan")

    raw = result.parsed.get("deep_dive") or []
    picks: list[str] = []
    for a in raw:
        key = str(a).lower()
        if key in valid_addrs and valid_addrs[key] not in picks:
            picks.append(valid_addrs[key])
        if len(picks) >= cap:
            break

    notes = str(result.parsed.get("notes") or "")
    watching = [str(w) for w in (result.parsed.get("watching") or [])]

    # Always leave a narrative beat, even if the model didn't journal one itself.
    if not ctx.journal_ids:
        try:
            from db import insert_journal

            insert_journal(
                user_addr=ctx.user_addr,
                trigger=ctx.trigger,
                kind="plan",
                title="Run plan",
                body=notes or f"Planned to deep-dive {len(picks)} market(s) this run.",
                meta={"deep_dive": picks, "watching": watching},
            )
        except Exception:  # noqa: BLE001
            pass

    return Plan(
        deep_dive=picks,
        notes=notes,
        watching=watching,
        tool_trace=result.tool_trace,
        from_model=True,
    )


def reflect_pass(ctx: ToolContext, *, decisions: list[Any], model: str) -> None:
    """Reflect turn. Best-effort — writes a journal reflection and lets the
    model update theses. Never raises into the caller."""
    trades = [d for d in decisions if getattr(d, "action", "pass") in ("buy_yes", "buy_no")]
    passes = [d for d in decisions if getattr(d, "action", "pass") == "pass"]

    def summarize(d: Any) -> str:
        act = getattr(d, "action", "pass")
        q = (getattr(d, "question", "") or "")[:70]
        if act == "pass":
            return f"- PASS {q} — {getattr(d, 'pass_reason', '') or ''}"
        side = "YES" if act == "buy_yes" else "NO"
        return f"- {side} ${getattr(d, 'cost_usdc', 0):.2f} {q}"

    body_lines = [summarize(d) for d in (trades + passes)[:12]]
    user_prompt = (
        f"RUN SUMMARY\n"
        f"  Trades placed: {len(trades)}   Passes: {len(passes)}\n"
        f"  Bankroll: ${ctx.bankroll_usdc:.2f}\n\n"
        + ("\n".join(body_lines) if body_lines else "(no markets evaluated this run)")
        + "\n\nReflect now: write one journal reflection and update any theses that changed."
    )

    journals_before = len(ctx.journal_ids)
    try:
        run_agent_turn(
            system_prompt=REFLECT_SYSTEM,
            user_prompt=user_prompt,
            ctx=ctx,
            tool_names=REFLECT_TOOLS,
            model=model,
            expect_json=False,
            max_iterations=4,
        )
    except Exception as e:  # noqa: BLE001
        console.print(f"[dim]reflect turn failed: {type(e).__name__}[/dim]")

    # Guarantee a reflection entry even if the model skipped write_journal.
    if len(ctx.journal_ids) == journals_before:
        try:
            from db import insert_journal

            insert_journal(
                user_addr=ctx.user_addr,
                trigger=ctx.trigger,
                kind="reflection",
                title="Run reflection",
                body=(
                    f"Ran a pass: {len(trades)} trade(s), {len(passes)} pass(es). "
                    f"Bankroll ${ctx.bankroll_usdc:.2f}."
                ),
                meta={"trades": len(trades), "passes": len(passes)},
            )
        except Exception:  # noqa: BLE001
            pass

    # Housekeeping: auto-expire theses gone stale so memory doesn't accumulate
    # views the agent never revisited.
    try:
        from db import expire_stale_theses

        ttl_days = int(os.environ.get("AGENT_THESIS_TTL_DAYS", "14"))
        n = expire_stale_theses(ctx.user_addr, ttl_days)
        if n:
            console.print(f"[dim]expired {n} stale thesis(es) (>{ttl_days}d)[/dim]")
    except Exception:  # noqa: BLE001
        pass
