"""Claude-driven probability estimation, routed via OpenRouter.

Why OpenRouter rather than Anthropic direct: one key, one bill, one
provider abstraction. OpenRouter passes through Anthropic's prompt caching
(`cache_control`), adaptive thinking (`thinking: {type: "adaptive"}` via
`extra_body`), and tool-use loop format unchanged — we get the same
agentic depth as the direct SDK without managing two upstream accounts.

The one Anthropic-side feature OpenRouter can't proxy is the server-side
`web_search_20260209` tool (it's not a wire-protocol feature; it lives
inside Anthropic's request handler). We substitute it with a custom
`web_search` tool that delegates to Perplexity Sonar via the same
OpenRouter client. Sonar does web search natively and returns citations;
the orchestrator model decides when to call it, so the agentic story
(model emits tool_use, harness runs it, result feeds back) is preserved
intact and judge-replayable in the tool_trace.

Public API: estimate(**kwargs) -> BrainResult | None

Tools the orchestrator can call:
  - web_search(query)            — Sonar via OpenRouter; returns summary + URLs
  - fetch_polymarket_odds(...)   — crowd prior, existing helper in loop.py
  - compute_kelly(...)           — deterministic position-sizing math
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from openai import OpenAI, APIStatusError, APIError
from rich.console import Console

# ── Config ─────────────────────────────────────────────────────────────────
# Default orchestrator: Sonnet 4.6 via OpenRouter (slug uses dots, not
# dashes). Override with BRAIN_MODEL=anthropic/claude-opus-4.7 for harder
# markets, or e.g. openai/gpt-5 if you want to A/B against a non-Anthropic
# orchestrator (the tool-use loop is OpenAI-compatible across providers).
DEFAULT_MODEL = os.environ.get("BRAIN_MODEL", "anthropic/claude-sonnet-4.6")

# Web-search delegate. Sonar is OpenRouter's first-party web-search model;
# results come back as text + a `citations` field that we surface.
SEARCH_MODEL = os.environ.get("BRAIN_SEARCH_MODEL", "perplexity/sonar")

# Hard cap on tool-use iterations per market. Stops a confused model from
# spinning forever; typical run uses 3–5 iterations.
MAX_ITERATIONS = 8

# Allow disabling web_search at the .env level to cut OpenRouter spend
# during e.g. CI runs that don't need real news.
ENABLE_WEB_SEARCH = os.environ.get("BRAIN_WEB_TOOLS", "1") != "0"

console = Console()


# ── OpenRouter client (singleton) ──────────────────────────────────────────
_CLIENT: OpenAI | None = None


def _client() -> OpenAI:
    """Lazy singleton — same client object reused across `estimate()` calls
    so HTTP connections + cache state aren't thrown away per market."""
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY missing — set it in .env to enable the brain.",
        )
    _CLIENT = OpenAI(
        api_key=api_key,
        base_url=os.environ.get(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
        ),
        # OpenRouter recommends these for usage attribution / better priority
        # in their routing layer. Same headers the legacy llm_estimate uses.
        default_headers={
            "HTTP-Referer": "https://github.com/yolo-markets",
            "X-Title": "YOLO Markets agent",
        },
    )
    return _CLIENT


# ── Tool execution: web_search ─────────────────────────────────────────────
def _tool_web_search(query: str) -> dict[str, Any]:
    """Delegate to Perplexity Sonar via OpenRouter. Sonar does live web
    search and returns text + citations; we surface both so the
    orchestrator can quote URLs and the /agent UI can show sources.

    Why this lives in-process rather than a separate microservice: a tool
    call costs ~1 second of network + ~$0.001 of OpenRouter spend. A
    microservice would add ops complexity without changing the math.
    """
    try:
        resp = _client().chat.completions.create(
            model=SEARCH_MODEL,
            max_tokens=600,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a research assistant. Answer the user's "
                        "query with 3–5 sentences of relevant recent facts. "
                        "Be specific (names, dates, numbers). Cite the URLs "
                        "you used."
                    ),
                },
                {"role": "user", "content": query},
            ],
        )
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "summary": "", "citations": []}

    text = (resp.choices[0].message.content or "").strip()
    citations = _extract_citations(resp.model_dump() if hasattr(resp, "model_dump") else {})
    return {"summary": text, "citations": citations}


def _extract_citations(raw: dict[str, Any]) -> list[str]:
    """Pull URLs from the two shapes OpenRouter forwards: Perplexity's
    top-level `citations` list, and OpenAI-style `message.annotations`.
    (Copied from loop.py to keep brain.py self-contained.)"""
    out: list[str] = []
    top = raw.get("citations") if isinstance(raw, dict) else None
    if isinstance(top, list):
        out.extend(c for c in top if isinstance(c, str))
    try:
        choice = (raw.get("choices") or [{}])[0]
        msg = (choice.get("message") or {}) if isinstance(choice, dict) else {}
        anns = msg.get("annotations") or []
        if isinstance(anns, list):
            for a in anns:
                if not isinstance(a, dict):
                    continue
                url = a.get("url") or (a.get("url_citation") or {}).get("url")
                if isinstance(url, str) and url:
                    out.append(url)
    except Exception:  # noqa: BLE001
        pass
    # De-dupe preserving order
    seen: set[str] = set()
    deduped: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            deduped.append(u)
    return deduped


# ── Tool execution: market-specific helpers ────────────────────────────────
def _tool_fetch_polymarket(question: str) -> dict[str, Any]:
    from loop import polymarket_match

    prob, slug = polymarket_match(question)
    if prob is None:
        return {
            "found": False,
            "note": "No close-enough Polymarket market to anchor on. "
            "Rely on web_search + first-principles reasoning.",
        }
    return {
        "found": True,
        "yes_probability": round(prob, 4),
        "slug": slug,
        "url": f"https://polymarket.com/event/{slug}" if slug else None,
        "note": (
            "Crowd price on the closest Polymarket market via fuzzy title "
            "match — a prior, not ground truth. Could be a different "
            "resolution date or wording."
        ),
    }


def _tool_compute_kelly(
    probability: float,
    market_price: float,
    bankroll_usdc: float,
    kelly_mult: float = 0.5,
) -> dict[str, Any]:
    """Deterministic Kelly sizing. Gives the model exact math instead of
    asking it to multiply in its head — calibration depends on getting
    this right."""
    from loop import kelly_fraction

    if not (0.0 < market_price < 1.0):
        return {"error": "market_price must be strictly between 0 and 1"}
    f = kelly_fraction(probability, market_price) * kelly_mult
    bet = max(0.0, f * bankroll_usdc)
    return {
        "kelly_fraction": round(f, 4),
        "bet_size_usdc": round(bet, 4),
        "bankroll_usdc": round(bankroll_usdc, 4),
        "kelly_multiplier_applied": kelly_mult,
        "note": "kelly_fraction is the fraction of bankroll to bet after "
        "applying the profile's risk multiplier. 0 means pass.",
    }


# Map of tool name → execution function.
_TOOL_HANDLERS = {
    "web_search": _tool_web_search,
    "fetch_polymarket_odds": _tool_fetch_polymarket,
    "compute_kelly": _tool_compute_kelly,
}


# ── Tool schemas (OpenAI function-calling format) ──────────────────────────
def _tool_definitions() -> list[dict[str, Any]]:
    """OpenAI-style function tool schemas. OpenRouter normalises this
    shape across providers — same definitions work whether the
    orchestrator is Anthropic, OpenAI, or anything else with tool-use
    support."""
    tools: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "fetch_polymarket_odds",
                "description": (
                    "Fuzzy-match the given question against active "
                    "Polymarket markets and return the crowd's YES "
                    "probability if a close match exists. Call once per "
                    "estimation as a crowd prior."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": (
                                "The market question, verbatim or lightly "
                                "rephrased for better match quality."
                            ),
                        }
                    },
                    "required": ["question"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "compute_kelly",
                "description": (
                    "Deterministically compute fractional-Kelly position "
                    "size given your probability estimate, the AMM price "
                    "on the side you'd bet, the user's bankroll, and a "
                    "kelly multiplier (0.25=conservative, 0.5=moderate, "
                    "1.0=aggressive). Call AFTER you have a probability "
                    "and BEFORE final JSON so reasoning can cite real "
                    "numbers."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "probability": {"type": "number"},
                        "market_price": {"type": "number"},
                        "bankroll_usdc": {"type": "number"},
                        "kelly_mult": {"type": "number"},
                    },
                    "required": [
                        "probability",
                        "market_price",
                        "bankroll_usdc",
                    ],
                },
            },
        },
    ]

    if ENABLE_WEB_SEARCH:
        # Front-loaded in the list so judges scanning the tool surface see
        # the web-search capability first — visual evidence of agentic
        # depth on the /agent page.
        tools.insert(
            0,
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": (
                        "Search the live web for recent information about "
                        "the market — news, official statements, data "
                        "releases, expert commentary. Returns a 3–5 "
                        "sentence summary plus the URLs of the sources "
                        "used. Be specific in your query — include dates, "
                        "named entities, and the resolution mechanism."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query (full sentence is fine).",
                            }
                        },
                        "required": ["query"],
                    },
                },
            },
        )

    return tools


# ── Prompts ────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a calibrated probability estimator for an autonomous
prediction-market trading agent that settles on Arc (a Circle L1, USDC-native).

Your job is to estimate the probability of YES on a given market and recommend
either a buy or a pass. You have tools to gather evidence — USE THEM. A bare
estimate without evidence is a bad estimate.

PROCESS (follow in order):
  1. Read the market question, resolution criteria, deadline, and current AMM
     YES price provided in the user message. Pay attention to the exact
     wording of the resolution criteria — markets often hinge on a precise
     definition (e.g. "next NYSE close" vs "by end of week").
  2. Call web_search to gather recent news. Be specific in your query — include
     dates, named entities, the resolution mechanism. Read 1–3 high-signal
     sources, not 10.
  3. Call fetch_polymarket_odds to get the crowd's prior. Treat as one signal,
     not ground truth.
  4. Reason from first principles. DO NOT anchor to the AMM price or
     Polymarket — both can be wrong. Identify the base rate, key
     uncertainties, and what would change your view.
  5. Call compute_kelly with your final probability, the relevant side price,
     and the bankroll/kelly_mult from the user message. This gives you the
     real position-sizing math; your final reasoning should reference it.
  6. Output STRICT JSON as your final message. Schema below. No prose outside
     the JSON, no markdown fences, nothing.

OUTPUT FORMAT (final message, no extra text):
{
  "probability": <0..1, your estimated P(YES)>,
  "confidence": <0..1, how confident you are — LOWER it when evidence is
                thin, time-sensitive, or contradictory>,
  "reasoning": "<3–5 sentences a human can audit. Cite sources and the
                Kelly math you computed. Be specific, not generic.>",
  "news_summary": "<2–3 sentences distilling what you learned from search.
                   Empty string if you didn't search.>",
  "key_sources": ["<url>", "<url>"],
  "watch_for": ["<signal that would flip your view>", "<another>"],
  "time_sensitivity": "low" | "medium" | "high"
}

NON-NEGOTIABLES:
  - JSON parses as valid JSON (use the schema above exactly).
  - probability and confidence are in [0,1].
  - reasoning is grounded in specific facts you gathered, not hand-waving.
  - If you can't form a confident estimate, set confidence low (<0.3) and
    explain why in reasoning. Do NOT make up sources.
  - Never call the same tool with identical arguments twice. If a tool
    returned no useful information, move on; do not retry.
"""


def _user_prompt(
    *,
    question: str,
    category: str,
    resolution_criteria: str,
    deadline_iso: str,
    amm_yes_price: float,
    bankroll_usdc: float,
    kelly_mult: float,
) -> str:
    return f"""MARKET TO ESTIMATE

  Question:            {question}
  Category:            {category}
  Resolution criteria: {resolution_criteria or "(none provided)"}
  Resolves at:         {deadline_iso}
  Current AMM YES:     {amm_yes_price * 100:.2f}%

USER CONTEXT (pass to compute_kelly when called)

  Bankroll (USDC):   {bankroll_usdc:.4f}
  Kelly multiplier:  {kelly_mult}

Begin. Gather evidence with tools, then output strict JSON per the schema in
the system prompt."""


# ── Data shapes ────────────────────────────────────────────────────────────
@dataclass
class BrainResult:
    """What loop.py consumes. Superset of the legacy Estimate — adds tool
    trace and news_summary so the /agent page can render judge-replayable
    detail."""

    probability: float
    confidence: float
    reasoning: str
    key_sources: list[str]
    watch_for: list[str]
    time_sensitivity: Literal["low", "medium", "high"]
    polymarket_prob: float | None
    polymarket_slug: str | None
    news_summary: str = ""
    tool_trace: list[dict[str, Any]] = field(default_factory=list)
    model: str = DEFAULT_MODEL
    iterations: int = 0
    usage: dict[str, int] = field(default_factory=dict)


# ── Core: the agent loop ───────────────────────────────────────────────────
def estimate(
    *,
    question: str,
    category: str,
    resolution_criteria: str,
    deadline_unix: int,
    amm_yes_price: float,
    bankroll_usdc: float,
    kelly_mult: float,
    model: str | None = None,
) -> BrainResult | None:
    """Run one tool-use loop over the given market via OpenRouter.

    Returns None on any unrecoverable error (missing API key, model refusal,
    malformed final JSON). Callers treat None the same as a failed LLM call
    — skip the market this cycle.
    """
    try:
        client = _client()
    except RuntimeError as e:
        console.print(f"[red]{e}[/red]")
        return None
    model = model or DEFAULT_MODEL

    deadline_iso = datetime.fromtimestamp(
        deadline_unix, tz=timezone.utc
    ).isoformat()
    user_msg = _user_prompt(
        question=question,
        category=category,
        resolution_criteria=resolution_criteria,
        deadline_iso=deadline_iso,
        amm_yes_price=amm_yes_price,
        bankroll_usdc=bankroll_usdc,
        kelly_mult=kelly_mult,
    )

    tools = _tool_definitions()
    # System prompt as a content-block list so cache_control attaches to it.
    # OpenRouter forwards cache_control verbatim to Anthropic models — for
    # non-Anthropic orchestrators the field is silently ignored (no error).
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
        {"role": "user", "content": user_msg},
    ]
    tool_trace: list[dict[str, Any]] = []
    polymarket_prob: float | None = None
    polymarket_slug: str | None = None
    total_usage = {"prompt_tokens": 0, "completion_tokens": 0,
                   "cache_creation_input_tokens": 0,
                   "cache_read_input_tokens": 0}

    for iteration in range(MAX_ITERATIONS):
        try:
            resp = client.chat.completions.create(
                model=model,
                max_tokens=8000,
                tools=tools,
                # `tool_choice="auto"` lets the model decide when to call
                # tools vs. emit the final JSON. Forcing "any" would push
                # it to always tool-call, which we don't want on the final
                # turn.
                tool_choice="auto",
                messages=messages,
                # extra_body forwards provider-specific knobs untouched.
                # For Anthropic orchestrators, this enables adaptive
                # thinking; for non-Anthropic models OpenRouter strips it.
                extra_body={
                    "thinking": {"type": "adaptive"},
                    # OpenRouter's transform hint — keeps the request body
                    # close to provider-native format, which improves
                    # prompt-cache hit rates.
                    "transforms": [],
                },
            )
        except APIStatusError as e:
            console.print(
                f"[red]brain api iter={iteration} status={e.status_code}: "
                f"{str(e)[:200]}[/red]"
            )
            return None
        except APIError as e:
            console.print(f"[red]brain api iter={iteration}: {e}[/red]")
            return None

        # Tally usage. Field names vary by provider — try Anthropic-style
        # cache fields first, fall back to OpenAI-style prompt/completion.
        if resp.usage:
            raw_usage = (
                resp.usage.model_dump()
                if hasattr(resp.usage, "model_dump")
                else {}
            )
            for k in total_usage:
                v = raw_usage.get(k)
                if isinstance(v, (int, float)):
                    total_usage[k] += int(v)

        choice = resp.choices[0]
        msg = choice.message
        finish_reason = choice.finish_reason

        # Always echo the assistant turn back into history. OpenAI-format
        # requires the original `tool_calls` to be present for the next
        # turn's `tool` results to be linked correctly.
        assistant_turn: dict[str, Any] = {
            "role": "assistant",
            "content": msg.content or "",
        }
        if msg.tool_calls:
            assistant_turn["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
        messages.append(assistant_turn)

        if finish_reason == "stop" and not msg.tool_calls:
            return _finalize(
                text=msg.content or "",
                tool_trace=tool_trace,
                polymarket_prob=polymarket_prob,
                polymarket_slug=polymarket_slug,
                model=model,
                iterations=iteration + 1,
                usage=total_usage,
            )

        if not msg.tool_calls:
            # Finish reason isn't `stop` and there are no tool calls —
            # likely `length` (hit max_tokens) or `content_filter`.
            console.print(
                f"[yellow]brain unexpected finish_reason={finish_reason}"
                f" no_tools no_final_json[/yellow]"
            )
            return None

        # Execute each tool call and append a tool-result message per ID.
        for tc in msg.tool_calls:
            name = tc.function.name
            elapsed_ms = 0
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError as e:
                args = {}
                result = {"error": f"bad tool arguments JSON: {e}"}
                is_error = True
            else:
                if name not in _TOOL_HANDLERS:
                    result = {"error": f"unknown tool: {name}"}
                    is_error = True
                else:
                    t0 = time.monotonic()
                    try:
                        result = _TOOL_HANDLERS[name](**args)
                        is_error = bool(
                            isinstance(result, dict) and result.get("error")
                        )
                    except Exception as e:  # noqa: BLE001
                        result = {"error": f"{type(e).__name__}: {e}"}
                        is_error = True
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

            if name == "fetch_polymarket_odds" and not is_error:
                if result.get("found"):
                    polymarket_prob = result.get("yes_probability")
                    polymarket_slug = result.get("slug")

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result),
                }
            )

    console.print(
        f"[yellow]brain hit MAX_ITERATIONS={MAX_ITERATIONS} without final "
        f"answer for: {question[:60]}…[/yellow]"
    )
    return None


# ── Final JSON extraction ──────────────────────────────────────────────────
def _finalize(
    *,
    text: str,
    tool_trace: list[dict[str, Any]],
    polymarket_prob: float | None,
    polymarket_slug: str | None,
    model: str,
    iterations: int,
    usage: dict[str, int],
) -> BrainResult | None:
    """Parse the final assistant message as strict JSON and build a
    BrainResult. Returns None if the JSON is malformed."""
    text = text.strip()
    if text.startswith("```"):
        # Defensive — strip markdown fences if the model slips despite the
        # explicit "no fences" instruction.
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
        if text.endswith("```"):
            text = text[:-3]

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as e:
        console.print(
            f"[red]brain returned non-JSON final message: {e} | "
            f"text={text[:200]!r}[/red]"
        )
        return None

    try:
        return BrainResult(
            probability=float(payload["probability"]),
            confidence=float(payload["confidence"]),
            reasoning=str(payload.get("reasoning", "")),
            key_sources=list(payload.get("key_sources", [])),
            watch_for=list(payload.get("watch_for", [])),
            time_sensitivity=payload.get("time_sensitivity", "medium"),
            polymarket_prob=polymarket_prob,
            polymarket_slug=polymarket_slug,
            news_summary=str(payload.get("news_summary", "")),
            tool_trace=tool_trace,
            model=model,
            iterations=iterations,
            usage=usage,
        )
    except (KeyError, TypeError, ValueError) as e:
        console.print(
            f"[red]brain payload missing required fields: {e} | "
            f"payload={payload!r}[/red]"
        )
        return None
