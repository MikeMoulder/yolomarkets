"""Streaming chat turn for the YOLO agent (Agent v2 · M2 — read only).

Same agent, assistant persona: the user talks to the actor that trades for them.
Streams over SSE — assistant text arrives token-by-token, and each tool call
surfaces as a "status" beat ("Reading your portfolio…") so the narrative shows.

M2 is READ ONLY: the tool belt here (tools.CHAT_TOOLS) has no execute/adjust
tools, so the assistant can inform but cannot move funds or change settings.
Trade/settings actions arrive in M3 behind the connected-wallet confirm flow.

`chat_turn` is a generator of event dicts:
    {"type": "delta",  "text": "..."}       assistant text chunk
    {"type": "status", "text": "...", "tool": "name"}   about to run a tool
    {"type": "tool",   "name": "...", "ok": bool}       tool finished
    {"type": "done"}
    {"type": "error",  "message": "..."}
The runner serializes each as one SSE `data:` frame.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

from rich.console import Console

from tools import ToolContext, tool_schemas, dispatch, CHAT_TOOLS

console = Console()

CHAT_SYSTEM = """You are the assistant voice of the YOLO Markets agent — the same
autonomous agent that researches and trades prediction markets for this user on
Arc (a Circle L1, USDC-settled). You are talking directly to your user.

You can read live data and PREPARE trades for the user to approve. Your tools:
  - read_platform_facts  — how the platform, fees, tiers, and wallets work
  - search_markets / get_market — find markets and their current YES price
  - read_portfolio       — the user's holdings across their wallet + your agent wallet
  - read_my_trades       — decisions you made (trades and passes, with reasons)
  - read_journal / read_theses — your own notes and standing views
  - fetch_polymarket_odds / web_search — outside signal
  - propose_trade        — when the user wants to buy, prepare an order. It shows
    them a confirm card and they approve in their OWN wallet. You never execute it.

Rules:
  - NEVER invent positions, prices, trades, or numbers. If a tool didn't return
    it, say you don't have it.
  - For ANY question about the platform — how it works, where to find something,
    how to navigate, fees, connecting a wallet, getting testnet USDC, docs, or
    contacting support — call read_platform_facts and answer specifically, citing
    the real page (e.g. Portfolio at /portfolio) or link. Be genuinely useful, not
    vague. There is NO public Discord, email, or support desk — never invent one;
    if asked how to reach the team, say so plainly and offer to help here yourself.
  - Format answers for readability: short paragraphs, and use markdown — **bold**
    for key terms, `- ` bullet lists for steps or options, and [label](url) or
    [Portfolio](/portfolio) links. Keep it tight, never a wall of text.
  - To place a trade, ALWAYS use propose_trade — never say a trade happened; it
    only executes after the user confirms in their wallet. If the market or the
    amount is unclear, ask first. After proposing, tell them it's ready to
    confirm below and briefly why it makes sense.
  - You cannot change account settings (pause, strategy, budgets) from chat yet;
    say that's coming soon if asked.
  - Prices are probabilities: a YES price of 0.62 means the market implies 62%.
  - Be concise and concrete. Reference markets by their question and YES%. When
    the user asks about "my" positions or trades, call the tool — don't guess.
  - You are the same agent that made these decisions; speak in the first person
    about your own reasoning when explaining trades."""

_STATUS = {
    "read_platform_facts": "Checking the platform details…",
    "search_markets": "Searching the markets…",
    "get_market": "Pulling up that market…",
    "read_portfolio": "Reading your positions…",
    "read_theses": "Recalling my views…",
    "read_journal": "Reviewing my journal…",
    "read_my_trades": "Looking at your recent trades…",
    "fetch_polymarket_odds": "Checking the Polymarket crowd…",
    "web_search": "Searching the web…",
    "propose_trade": "Sizing the order…",
}


def build_chat_context(user_addr: str, addresses: list[str] | None = None) -> ToolContext:
    """Assemble a read-only chat context: the user's wallets (connected + Circle
    agent) for on-chain portfolio reads, plus their profile if one exists."""
    from loop import get_web3
    from profiles import get_profile

    profile = None
    try:
        profile = get_profile(user_addr)
    except Exception:  # noqa: BLE001
        pass
    agent_address = getattr(profile, "agent_address", None)

    seen: set[str] = set()
    wallets: list[str] = []
    for a in [user_addr, agent_address, *(addresses or [])]:
        if a and a.lower() not in seen:
            seen.add(a.lower())
            wallets.append(a)

    w3 = None
    try:
        w3 = get_web3()
    except Exception:  # noqa: BLE001
        pass

    return ToolContext(
        user_addr=user_addr,
        trigger="chat",
        profile=profile,
        w3=w3,
        user_addresses=wallets,
        agent_address=agent_address,
    )


def chat_model(ctx: ToolContext) -> str:
    from brain import DEFAULT_MODEL
    from policy import model_for_profile

    if ctx.profile is not None:
        try:
            from credits import get_subscription_tier

            tier = get_subscription_tier(ctx.user_addr)
        except Exception:  # noqa: BLE001
            tier = None
        m = model_for_profile(ctx.profile, tier)
        if m:
            return m
    return DEFAULT_MODEL


def chat_turn(
    *,
    ctx: ToolContext,
    message: str,
    history: list[dict[str, str]] | None = None,
    model: str | None = None,
    max_iterations: int = 6,
) -> Iterator[dict[str, Any]]:
    """Run one streaming, tool-using chat turn. Yields SSE event dicts."""
    from brain import (
        _client,
        BRAIN_MAX_TOKENS,
        BRAIN_TEMPERATURE,
        OPENROUTER_REASONING_EFFORT,
    )

    try:
        client = _client()
    except RuntimeError as e:
        yield {"type": "error", "message": str(e)}
        return

    model = model or chat_model(ctx)
    schemas = tool_schemas(CHAT_TOOLS)

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": CHAT_SYSTEM, "cache_control": {"type": "ephemeral"}}
            ],
        }
    ]
    for h in history or []:
        role = h.get("role")
        content = h.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})

    for _iteration in range(max_iterations):
        try:
            stream = client.chat.completions.create(
                model=model,
                max_tokens=BRAIN_MAX_TOKENS,
                temperature=BRAIN_TEMPERATURE,
                tools=schemas,
                tool_choice="auto",
                stream=True,
                messages=messages,
                extra_body={
                    "reasoning": {"effort": OPENROUTER_REASONING_EFFORT},
                    "transforms": [],
                },
            )
        except Exception as e:  # noqa: BLE001
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return

        content_parts: list[str] = []
        tool_calls: dict[int, dict[str, str]] = {}
        try:
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue
                if delta.content:
                    content_parts.append(delta.content)
                    yield {"type": "delta", "text": delta.content}
                for tcd in delta.tool_calls or []:
                    slot = tool_calls.setdefault(tcd.index, {"id": "", "name": "", "args": ""})
                    if tcd.id:
                        slot["id"] = tcd.id
                    if tcd.function and tcd.function.name:
                        slot["name"] = tcd.function.name
                    if tcd.function and tcd.function.arguments:
                        slot["args"] += tcd.function.arguments
        except Exception as e:  # noqa: BLE001
            yield {"type": "error", "message": f"stream error: {type(e).__name__}: {e}"}
            return

        assistant_turn: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts)}
        if tool_calls:
            assistant_turn["tool_calls"] = [
                {
                    "id": s["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": s["name"], "arguments": s["args"] or "{}"},
                }
                for i, s in sorted(tool_calls.items())
            ]
        messages.append(assistant_turn)

        if not tool_calls:
            yield {"type": "done"}
            return

        for i, s in sorted(tool_calls.items()):
            name = s["name"]
            yield {"type": "status", "text": _STATUS.get(name, f"Running {name}…"), "tool": name}
            try:
                args = json.loads(s["args"] or "{}")
            except json.JSONDecodeError as e:
                result, is_error = {"error": f"bad tool args: {e}"}, True
            else:
                result, is_error = dispatch(ctx, name, args)
            yield {"type": "tool", "name": name, "ok": not is_error}
            # A prepared order → the UI renders a confirm card from this event.
            if (
                name == "propose_trade"
                and not is_error
                and isinstance(result, dict)
                and result.get("proposal")
            ):
                yield {"type": "proposal", "order": result["proposal"]}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": s["id"] or f"call_{i}",
                    "content": json.dumps(result, default=str),
                }
            )

    yield {"type": "done"}
