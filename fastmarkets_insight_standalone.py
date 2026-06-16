#!/usr/bin/env python3
"""Standalone clone of the Fastmarkets insight reasoning path.

This ports the current logic from:
  - web/app/api/markets/[address]/insight/route.ts
  - web/lib/llm.ts

It builds the AUTO_FAST market context, sends the same insight prompt to Gemini
or OpenRouter, and normalizes the model output into the same Estimate shape.

Example:
    python fastmarkets_insight_standalone.py \
      --question "Will BTC be above the start price in 15m?" \
      --criteria-file criteria.txt \
      --deadline 2026-06-16T18:30:00Z \
      --market-prob 0.52
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


EstimateAction = Literal["buy_yes", "buy_no"]
SuggestedSize = Literal["none", "small", "medium"]
TimeSensitivity = Literal["low", "medium", "high"]

AUTO_FAST_PREFIX = "AUTO_FAST:"

FAST_ASSETS: dict[str, dict[str, str]] = {
    "BTC": {"binanceSymbol": "BTCUSDT", "coingeckoId": "bitcoin"},
    "ETH": {"binanceSymbol": "ETHUSDT", "coingeckoId": "ethereum"},
    "SOL": {"binanceSymbol": "SOLUSDT", "coingeckoId": "solana"},
}

SYSTEM = """You are a calibrated prediction-market copilot.
Output STRICT JSON only - no prose before or after. Reason from first principles,
but use the supplied market context as evidence when it is available. Do not
blindly anchor to the market price. When uncertain, lower confidence and reduce
position size, but still choose a side. Your output is consumed programmatically; any
deviation from the schema breaks it."""

USER_TEMPLATE = """MARKET: "{question}"
RESOLUTION CRITERIA: {criteria}
RESOLVES: {deadline}

CROWD SIGNAL:
  Current market YES price: {market_price}%

{context_block}ACTION RULES:
  - Recommend buy_yes only when your probability is meaningfully above the
    market YES price after fees/slippage.
  - Recommend buy_no only when your probability is meaningfully below the
    market YES price after fees/slippage.
  - For fast crypto markets, never overstate certainty. If live price context
    is unavailable, set low confidence and prefer smaller size.
  - Keep tips actionable: what to buy/sell, position sizing, and what
    signal would invalidate the trade.

OUTPUT FORMAT (strict JSON, no markdown fences):
{{
  "probability": 0.0,
  "confidence": 0.0,
  "action": "buy_yes" | "buy_no",
  "action_label": "Buy YES" | "Buy NO",
  "action_summary": "one sentence telling the user what to do and why",
  "suggested_size": "none" | "small" | "medium",
  "actionable_tips": ["specific next step", "risk control or exit note"],
  "reasoning": "3 to 5 sentences shown to the user",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal that would change this estimate", "another"],
  "time_sensitivity": "low" | "medium" | "high"
}}"""

ESTIMATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "probability": {"type": "number"},
        "confidence": {"type": "number"},
        "action": {"type": "string", "enum": ["buy_yes", "buy_no"]},
        "action_label": {"type": "string", "enum": ["Buy YES", "Buy NO"]},
        "action_summary": {"type": "string"},
        "suggested_size": {"type": "string", "enum": ["none", "small", "medium"]},
        "actionable_tips": {"type": "array", "items": {"type": "string"}},
        "reasoning": {"type": "string"},
        "key_sources": {"type": "array", "items": {"type": "string"}},
        "watch_for": {"type": "array", "items": {"type": "string"}},
        "time_sensitivity": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": [
        "probability",
        "confidence",
        "action",
        "action_label",
        "action_summary",
        "suggested_size",
        "actionable_tips",
        "reasoning",
        "key_sources",
        "watch_for",
        "time_sensitivity",
    ],
}


@dataclass
class AutoFastMeta:
    version: int
    symbol: Literal["BTC", "ETH", "SOL"]
    timeframe: Literal["15m", "1h"]
    source: Literal["coingecko", "binance"]
    startPrice: str
    startTs: int


@dataclass
class Estimate:
    probability: float
    confidence: float
    action: EstimateAction
    action_label: str
    action_summary: str
    suggested_size: SuggestedSize
    actionable_tips: list[str]
    reasoning: str
    key_sources: list[str]
    watch_for: list[str]
    time_sensitivity: TimeSensitivity


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> Any:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req_headers = {
        "accept": "application/json",
        **(headers or {}),
    }
    if payload is not None:
        req_headers["content-type"] = "application/json"

    req = Request(url, data=payload, headers=req_headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else None


def parse_auto_fast_meta(criteria: str) -> AutoFastMeta | None:
    first = (criteria.split("\n", 1)[0] if criteria else "").strip()
    if not first.startswith(AUTO_FAST_PREFIX):
        return None

    try:
        parsed = json.loads(first[len(AUTO_FAST_PREFIX) :])
    except json.JSONDecodeError:
        return None

    if (
        isinstance(parsed, dict)
        and parsed.get("version") == 1
        and parsed.get("symbol") in {"BTC", "ETH", "SOL"}
        and parsed.get("timeframe") in {"15m", "1h"}
        and parsed.get("source") in {"coingecko", "binance"}
        and isinstance(parsed.get("startPrice"), str)
        and isinstance(parsed.get("startTs"), (int, float))
    ):
        return AutoFastMeta(
            version=1,
            symbol=parsed["symbol"],
            timeframe=parsed["timeframe"],
            source=parsed["source"],
            startPrice=parsed["startPrice"],
            startTs=int(parsed["startTs"]),
        )
    return None


def parse_deadline_seconds(deadline: str | int | float) -> int:
    if isinstance(deadline, (int, float)):
        return int(deadline)

    raw = str(deadline).strip()
    if re.fullmatch(r"\d+", raw):
        return int(raw)

    normalized = raw.replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(normalized).timestamp())
    except ValueError:
        pass

    for fmt in ("%a, %d %b %Y %H:%M:%S GMT", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue

    raise ValueError(f"could not parse deadline: {deadline!r}")


def build_market_context(resolution_criteria: str, deadline: str | int | float) -> str | None:
    meta = parse_auto_fast_meta(resolution_criteria)
    if not meta:
        return None

    asset = FAST_ASSETS[meta.symbol]
    now_sec = int(time.time())
    deadline_sec = parse_deadline_seconds(deadline)
    window_sec = 15 * 60 if meta.timeframe == "15m" else 60 * 60
    start_price = float(meta.startPrice)

    spot: float | None
    closes: list[float]
    try:
        spot = fetch_spot_price(asset)
    except Exception:
        spot = None
    try:
        closes = fetch_recent_binance_closes(asset["binanceSymbol"], meta.timeframe)
    except Exception:
        closes = []

    lines = [
        f"Fast crypto market detected at {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}.",
        (
            f"Instrument: {meta.symbol}/USD; window: {meta.timeframe}; "
            f"resolution source declared by market: {meta.source}."
        ),
        f"Start price: ${meta.startPrice} at {iso_from_seconds(meta.startTs)}.",
        "Resolution rule: YES iff the close at deadline is strictly above the start price.",
        (
            f"Deadline: {iso_from_seconds(deadline_sec)}; time remaining: "
            f"{max(0, deadline_sec - now_sec)} seconds of about {window_sec} seconds."
        ),
    ]

    if spot is not None and math.isfinite(start_price) and start_price > 0:
        diff = spot - start_price
        lines.append(
            f"Current spot: ${spot:.4f} ({format_signed(diff)} USD, "
            f"{format_signed_pct(diff / start_price)} vs start)."
        )
    else:
        lines.append("Current spot: unavailable from Binance/CoinGecko during this request.")

    if closes:
        momentum = [
            item
            for item in (
                format_momentum("1m", closes, spot, 1),
                format_momentum("5m", closes, spot, 5),
                format_momentum("15m", closes, spot, 15),
            )
            if item
        ]
        if momentum:
            lines.append(f"Recent momentum: {'; '.join(momentum)}.")

    return "\n".join(lines)


def fetch_spot_price(asset: dict[str, str]) -> float:
    params = urlencode({"symbol": asset["binanceSymbol"]})
    try:
        json_body = request_json(f"https://api.binance.com/api/v3/ticker/price?{params}")
        price = float(json_body.get("price"))
        if math.isfinite(price) and price > 0:
            return price
    except Exception:
        pass

    params = urlencode({"ids": asset["coingeckoId"], "vs_currencies": "usd"})
    json_body = request_json(f"https://api.coingecko.com/api/v3/simple/price?{params}")
    price = json_body.get(asset["coingeckoId"], {}).get("usd")
    if isinstance(price, (int, float)) and math.isfinite(price) and price > 0:
        return float(price)
    raise RuntimeError(f"missing price for {asset['coingeckoId']}")


def fetch_recent_binance_closes(symbol: str, timeframe: str) -> list[float]:
    limit = 20 if timeframe == "15m" else 70
    params = urlencode({"symbol": symbol, "interval": "1m", "limit": str(limit)})
    rows = request_json(f"https://api.binance.com/api/v3/klines?{params}")
    closes: list[float] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, list) or len(row) <= 4:
            continue
        try:
            close = float(row[4])
        except (TypeError, ValueError):
            continue
        if math.isfinite(close) and close > 0:
            closes.append(close)
    return closes


def format_momentum(
    label: str,
    closes: list[float],
    current_spot: float | None,
    lookback: int,
) -> str | None:
    current = current_spot if current_spot is not None else (closes[-1] if closes else None)
    previous = closes[-1 - lookback] if len(closes) > lookback else None
    if not current or not previous:
        return None
    return f"{label} {format_signed_pct((current - previous) / previous)}"


def format_signed(value: float) -> str:
    return f"{'+' if value >= 0 else ''}{value:.4f}"


def format_signed_pct(value: float) -> str:
    return f"{'+' if value >= 0 else ''}{value * 100:.3f}%"


def iso_from_seconds(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def user_prompt(
    *,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None,
) -> str:
    return USER_TEMPLATE.format(
        question=question,
        criteria=criteria or "(none provided)",
        deadline=deadline or "(unknown)",
        market_price=f"{market_prob * 100:.2f}",
        context_block=f"MARKET CONTEXT:\n{context}\n\n" if context else "",
    )


def estimate(
    *,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None = None,
) -> Estimate | None:
    provider = os.environ.get("AI_INSIGHT_PROVIDER", "").lower()
    if provider != "openrouter" and os.environ.get("GEMINI_API_KEY"):
        gemini_estimate = estimate_with_gemini(
            question=question,
            criteria=criteria,
            deadline=deadline,
            market_prob=market_prob,
            context=context,
        )
        if gemini_estimate or provider == "gemini":
            return gemini_estimate
    return estimate_with_openrouter(
        question=question,
        criteria=criteria,
        deadline=deadline,
        market_prob=market_prob,
        context=context,
    )


def estimate_with_gemini(
    *,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None,
) -> Estimate | None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None

    base = os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
    model = (
        os.environ.get("GEMINI_INSIGHT_MODEL")
        or os.environ.get("GEMINI_FREE_MODEL")
        or "gemini-3.1-flash-lite"
    )
    model_name = re.sub(r"^models/", "", model)

    body = gemini_request_body(
        question=question,
        criteria=criteria,
        deadline=deadline,
        market_prob=market_prob,
        context=context,
        use_google_search=os.environ.get("GEMINI_INSIGHT_GOOGLE_SEARCH") == "1",
    )

    try:
        json_body = request_json(
            f"{base}/models/{model_name}:generateContent",
            method="POST",
            headers={"x-goog-api-key": api_key},
            body=body,
        )
        return parse_gemini_estimate(json_body, market_prob)
    except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
        print(f"[llm/gemini] request failed: {safe_error_message(exc)}", file=sys.stderr)
        if body.get("tools"):
            return estimate_with_gemini_no_search(
                api_key=api_key,
                base=base,
                model_name=model_name,
                question=question,
                criteria=criteria,
                deadline=deadline,
                market_prob=market_prob,
                context=context,
            )
        return None


def estimate_with_gemini_no_search(
    *,
    api_key: str,
    base: str,
    model_name: str,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None,
) -> Estimate | None:
    try:
        json_body = request_json(
            f"{base}/models/{model_name}:generateContent",
            method="POST",
            headers={"x-goog-api-key": api_key},
            body=gemini_request_body(
                question=question,
                criteria=criteria,
                deadline=deadline,
                market_prob=market_prob,
                context=context,
                use_google_search=False,
            ),
        )
        return parse_gemini_estimate(json_body, market_prob)
    except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
        print(f"[llm/gemini] no-search retry failed: {safe_error_message(exc)}", file=sys.stderr)
        return None


def gemini_request_body(
    *,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None,
    use_google_search: bool,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "system_instruction": {"parts": [{"text": SYSTEM}]},
        "contents": [
            {
                "parts": [
                    {
                        "text": user_prompt(
                            question=question,
                            criteria=criteria,
                            deadline=deadline,
                            market_prob=market_prob,
                            context=context,
                        )
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": float(os.environ.get("GEMINI_INSIGHT_TEMPERATURE", "0.15")),
            "maxOutputTokens": int(os.environ.get("AI_INSIGHT_MAX_TOKENS", "1200")),
            "responseMimeType": "application/json",
            "responseSchema": ESTIMATE_SCHEMA,
            "thinkingConfig": {
                "thinkingLevel": (
                    os.environ.get("GEMINI_INSIGHT_THINKING_LEVEL")
                    or os.environ.get("GEMINI_THINKING_LEVEL")
                    or "low"
                )
            },
        },
    }
    if use_google_search:
        body["tools"] = [{"google_search": {}}]
    return body


def parse_gemini_estimate(json_body: Any, market_prob: float) -> Estimate | None:
    candidate = (json_body.get("candidates") or [None])[0] if isinstance(json_body, dict) else None
    parts = (
        candidate.get("content", {}).get("parts")
        if isinstance(candidate, dict)
        else None
    )
    text = "\n".join(
        part.get("text", "")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ).strip() if isinstance(parts, list) else ""
    if not text:
        return None

    raw = extract_json_payload(text)
    parsed = normalize_estimate(raw, market_prob) if raw is not None else None
    if not parsed:
        return None

    grounding_sources = extract_gemini_sources(candidate)
    if grounding_sources:
        parsed.key_sources = unique_strings([*grounding_sources, *parsed.key_sources])
    return parsed


def estimate_with_openrouter(
    *,
    question: str,
    criteria: str,
    deadline: str,
    market_prob: float,
    context: str | None,
) -> Estimate | None:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return None

    base = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    model = (
        os.environ.get("OPENROUTER_INSIGHT_MODEL")
        or os.environ.get("OPENROUTER_MODEL")
        or "perplexity/sonar"
    )
    body = {
        "model": model,
        "max_tokens": int(os.environ.get("AI_INSIGHT_MAX_TOKENS", "1200")),
        "messages": [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": user_prompt(
                    question=question,
                    criteria=criteria,
                    deadline=deadline,
                    market_prob=market_prob,
                    context=context,
                ),
            },
        ],
    }

    try:
        json_body = request_json(
            f"{base}/chat/completions",
            method="POST",
            headers={
                "authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://github.com/yolo-markets",
                "X-Title": "YOLO Markets web",
            },
            body=body,
        )
    except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
        print(f"[llm/openrouter] request failed: {safe_error_message(exc)}", file=sys.stderr)
        return None

    message = (((json_body or {}).get("choices") or [{}])[0].get("message") or {})
    text = message.get("content")
    if not isinstance(text, str):
        return None

    raw = extract_json_payload(text)
    parsed = normalize_estimate(raw, market_prob) if raw is not None else None
    if not parsed:
        return None

    live_citations: list[str] = []
    if isinstance(json_body.get("citations"), list):
        live_citations.extend(item for item in json_body["citations"] if isinstance(item, str))
    if isinstance(message.get("annotations"), list):
        for annotation in message["annotations"]:
            if not isinstance(annotation, dict):
                continue
            url = annotation.get("url")
            url_citation = annotation.get("url_citation")
            if isinstance(url, str):
                live_citations.append(url)
            elif isinstance(url_citation, dict) and isinstance(url_citation.get("url"), str):
                live_citations.append(url_citation["url"])

    if live_citations:
        parsed.key_sources = unique_strings([*live_citations, *parsed.key_sources])
    return parsed


def normalize_estimate(raw: Any, market_prob: float) -> Estimate | None:
    if not isinstance(raw, dict):
        return None

    probability = clamp01(to_float(raw.get("probability")))
    confidence = clamp01(to_float(raw.get("confidence")))
    if probability is None or confidence is None:
        return None

    edge = probability - market_prob
    fallback_action: EstimateAction = "buy_yes" if edge >= 0 else "buy_no"
    action = raw.get("action") if raw.get("action") in {"buy_yes", "buy_no"} else fallback_action

    action_label = clean_string(raw.get("action_label"))
    if not action_label:
        action_label = "Buy YES" if action == "buy_yes" else "Buy NO"

    raw_size = raw.get("suggested_size")
    if raw_size in {"none", "small", "medium"}:
        suggested_size: SuggestedSize = raw_size
    elif confidence < 0.45:
        suggested_size = "none"
    elif confidence > 0.7 and abs(edge) > 0.08:
        suggested_size = "medium"
    else:
        suggested_size = "small"

    raw_time = raw.get("time_sensitivity")
    time_sensitivity: TimeSensitivity = (
        raw_time if raw_time in {"low", "medium", "high"} else "medium"
    )

    return Estimate(
        probability=probability,
        confidence=confidence,
        action=action,
        action_label=action_label,
        action_summary=clean_string(raw.get("action_summary"))
        or fallback_action_summary(action, edge),
        suggested_size=suggested_size,
        actionable_tips=clean_string_array(raw.get("actionable_tips")),
        reasoning=clean_string(raw.get("reasoning")),
        key_sources=clean_string_array(raw.get("key_sources")),
        watch_for=clean_string_array(raw.get("watch_for")),
        time_sensitivity=time_sensitivity,
    )


def extract_json_payload(text: str) -> Any | None:
    raw = text.strip()
    if not raw:
        return None

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except json.JSONDecodeError:
            pass

    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None

    return None


def extract_gemini_sources(candidate: Any) -> list[str]:
    if not isinstance(candidate, dict):
        return []
    grounding = candidate.get("groundingMetadata")
    if not isinstance(grounding, dict):
        return []
    chunks = grounding.get("groundingChunks")
    if not isinstance(chunks, list):
        return []

    sources: list[str] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        web = chunk.get("web")
        if isinstance(web, dict) and isinstance(web.get("uri"), str) and web["uri"]:
            sources.append(web["uri"])
    return sources


def to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def clamp01(value: float) -> float | None:
    if not math.isfinite(value):
        return None
    return min(1.0, max(0.0, value))


def clean_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def clean_string_array(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()][:6]


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def fallback_action_summary(action: EstimateAction, edge: float) -> str:
    edge_pts = f"{abs(edge * 100):.1f}"
    if action == "buy_yes":
        return (
            "Buy YES only if execution stays near the displayed price; "
            f"estimated edge is about {edge_pts} points."
        )
    return (
        "Buy NO only if execution stays near the displayed price; "
        f"estimated edge is about {edge_pts} points."
    )


def safe_error_message(exc: BaseException) -> str:
    if isinstance(exc, HTTPError):
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        detail = re.sub(r"\s+", " ", body).strip()[:300]
        return f"{exc.code} {detail}".strip()
    return str(exc)[:300]


def read_text_arg(value: str | None, file_value: str | None, *, name: str) -> str:
    if file_value:
        return Path(file_value).read_text(encoding="utf-8")
    if value is not None:
        return value
    raise SystemExit(f"--{name} or --{name}-file is required")


def load_market_json(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("--market-json must point to a JSON object")
    return data


def main() -> int:
    load_dotenv(Path(__file__).resolve().parent / ".env")

    parser = argparse.ArgumentParser(
        description="Run the standalone Fastmarkets insight reasoning clone."
    )
    parser.add_argument("--market-json", help="Optional JSON object with question/criteria/deadline/marketProb")
    parser.add_argument("--question")
    parser.add_argument("--question-file")
    parser.add_argument("--criteria")
    parser.add_argument("--criteria-file")
    parser.add_argument("--deadline", help="ISO datetime, unix seconds, or UTC string")
    parser.add_argument("--market-prob", type=float, help="Current YES probability, 0..1")
    parser.add_argument("--context", help="Override generated market context")
    parser.add_argument("--context-file")
    parser.add_argument(
        "--no-fast-context",
        action="store_true",
        help="Do not build AUTO_FAST live price context from criteria.",
    )
    parser.add_argument(
        "--print-context-only",
        action="store_true",
        help="Build and print Fastmarkets context without calling an LLM.",
    )
    args = parser.parse_args()

    market = load_market_json(args.market_json) if args.market_json else {}
    question = read_text_arg(
        args.question if args.question is not None else market.get("question"),
        args.question_file,
        name="question",
    )
    criteria = read_text_arg(
        args.criteria
        if args.criteria is not None
        else market.get("criteria") or market.get("resolutionCriteria"),
        args.criteria_file,
        name="criteria",
    )
    deadline = args.deadline or market.get("deadline")
    if deadline is None:
        raise SystemExit("--deadline is required")

    market_prob = args.market_prob
    if market_prob is None:
        market_prob = market.get("marketProb")
    if market_prob is None:
        raise SystemExit("--market-prob is required")
    market_prob = float(market_prob)
    if not 0 <= market_prob <= 1:
        raise SystemExit("--market-prob must be between 0 and 1")

    context = read_text_arg(args.context, args.context_file, name="context") if (
        args.context is not None or args.context_file
    ) else None
    if context is None and not args.no_fast_context:
        context = build_market_context(criteria, deadline)

    if args.print_context_only:
        print(context or "")
        return 0

    result = estimate(
        question=question,
        criteria=criteria,
        deadline=str(deadline),
        market_prob=market_prob,
        context=context,
    )
    if result is None:
        print("estimate unavailable", file=sys.stderr)
        return 1

    print(json.dumps(asdict(result), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
