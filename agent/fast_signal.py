"""Deterministic probability estimator for fast markets.

A fast market asks "Will BTC be UP in the next 15m? (Start: $64439.70)" and
resolves YES iff the close at the deadline exceeds the start price. An LLM
cannot answer that — and ours correctly refuses to pretend: every fast-market
estimate it has ever produced came back probability 0.50, confidence 0.10,
edge 0. That is the honest answer to "predict a 15-minute candle", and it is
also useless, so the agent never traded any of them.

But the question is not actually a forecasting problem. Everything needed to
price it is observable:

  · the start price is embedded in the market's own metadata
  · the current spot price is a public API call
  · the time left is arithmetic

Given a move of `m` with `t` seconds remaining and per-second volatility `σ`,
and assuming no drift over a sub-hour window (a reasonable assumption at this
horizon), the probability the price is still above the start at the deadline is

    P(up) = Φ( m / (σ·√t) )

So the agent stops guessing and starts measuring. Early in a window a small
move is noise and this returns ~0.5 — a genuine pass. Late in a window a move
that is large relative to the remaining volatility is decisive, and the agent
takes the bet. That is a real expiry/momentum strategy rather than a coin flip
dressed up as conviction.

Volatility is measured from recent 1-minute candles rather than assumed, so a
quiet market and a violent one are priced differently.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass

import httpx

AUTO_FAST_PREFIX = "AUTO_FAST:"

BINANCE_SYMBOL = {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT"}

# Spot and volatility are shared across every market on the same symbol, and a
# pass can score dozens at once — so cache briefly rather than hammering the API.
_SPOT_TTL_S = float(os.environ.get("FAST_SIGNAL_SPOT_TTL_S", "20"))
_VOL_TTL_S = float(os.environ.get("FAST_SIGNAL_VOL_TTL_S", "300"))
_spot_cache: dict[str, tuple[float, float]] = {}
_vol_cache: dict[str, tuple[float, float]] = {}

_TIMEOUT = float(os.environ.get("FAST_SIGNAL_TIMEOUT_S", "8"))


@dataclass
class FastEstimate:
    prob_yes: float
    confidence: float
    move_pct: float
    seconds_left: float
    spot: float
    start_price: float
    sigma_per_sqrt_s: float
    rationale: str


def parse_fast_meta(resolution_criteria: str | None) -> dict | None:
    """Pull the keeper's `AUTO_FAST:{...}` metadata off line 1, or None."""
    if not resolution_criteria:
        return None
    first = resolution_criteria.split("\n", 1)[0].strip()
    if not first.startswith(AUTO_FAST_PREFIX):
        return None
    try:
        meta = json.loads(first[len(AUTO_FAST_PREFIX):])
    except Exception:
        return None
    if not isinstance(meta, dict) or "startPrice" not in meta or "symbol" not in meta:
        return None
    return meta


def _get_spot(symbol: str) -> float | None:
    pair = BINANCE_SYMBOL.get(symbol.upper())
    if not pair:
        return None
    hit = _spot_cache.get(pair)
    now = time.time()
    if hit and now - hit[0] < _SPOT_TTL_S:
        return hit[1]
    try:
        r = httpx.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": pair},
            timeout=_TIMEOUT,
        )
        price = float(r.json()["price"])
    except Exception:
        # Binance is the keeper's primary source; CoinGecko is its documented
        # fallback, so mirror that rather than failing the whole estimate.
        try:
            cg = {"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana"}[symbol.upper()]
            r = httpx.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": cg, "vs_currencies": "usd"},
                timeout=_TIMEOUT,
            )
            price = float(r.json()[cg]["usd"])
        except Exception:
            return None
    _spot_cache[pair] = (now, price)
    return price


def _get_sigma_per_sqrt_s(symbol: str) -> float | None:
    """Per-√second volatility of log returns, from recent 1m candles."""
    pair = BINANCE_SYMBOL.get(symbol.upper())
    if not pair:
        return None
    hit = _vol_cache.get(pair)
    now = time.time()
    if hit and now - hit[0] < _VOL_TTL_S:
        return hit[1]
    try:
        r = httpx.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": pair, "interval": "1m", "limit": 120},
            timeout=_TIMEOUT,
        )
        closes = [float(k[4]) for k in r.json()]
    except Exception:
        return None
    if len(closes) < 20:
        return None
    rets = [
        math.log(closes[i] / closes[i - 1])
        for i in range(1, len(closes))
        if closes[i - 1] > 0
    ]
    if len(rets) < 20:
        return None
    mean = sum(rets) / len(rets)
    var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
    sigma_per_min = math.sqrt(var)
    if sigma_per_min <= 0:
        return None

    # Floor the volatility. The danger case is a two-hour window that happens to
    # be unusually quiet: measured sigma collapses, every small move looks like
    # many sigma, and the model turns a coin flip into 99% conviction right
    # before a regime change. The floor bounds that overconfidence; it never
    # makes the agent *more* aggressive, only less.
    sigma_per_min = max(
        sigma_per_min, float(os.environ.get("FAST_SIGNAL_MIN_SIGMA_PER_MIN", "0.0002"))
    )
    sigma = sigma_per_min / math.sqrt(60.0)  # per √second
    _vol_cache[pair] = (now, sigma)
    return sigma


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def estimate_fast_market(
    *,
    resolution_criteria: str | None,
    deadline_unix: int,
    now_ts: int | None = None,
) -> FastEstimate | None:
    """Price a fast market from live spot vs. its embedded start price.

    Returns None when this isn't a fast market, the feed is unavailable, or the
    window has effectively closed — the caller should fall back to its normal
    path rather than trade on a guess.
    """
    meta = parse_fast_meta(resolution_criteria)
    if not meta:
        return None

    symbol = str(meta.get("symbol", "")).upper()
    try:
        start_price = float(meta["startPrice"])
    except (TypeError, ValueError):
        return None
    if start_price <= 0:
        return None

    now = int(now_ts or time.time())
    seconds_left = float(deadline_unix - now)
    # Inside the last few seconds the estimate is dominated by settlement timing
    # rather than price, and there is no time to get filled. Refuse.
    if seconds_left < float(os.environ.get("FAST_SIGNAL_MIN_SECONDS", "20")):
        return None

    spot = _get_spot(symbol)
    sigma = _get_sigma_per_sqrt_s(symbol)
    if spot is None or sigma is None:
        return None

    move = (spot - start_price) / start_price
    denom = sigma * math.sqrt(seconds_left)
    if denom <= 0:
        return None

    prob_yes = _norm_cdf(move / denom)
    prob_yes = min(0.99, max(0.01, prob_yes))

    # Confidence is how far the signal is from a coin flip. At 0.50 we know
    # nothing and this is 0, which the risk gate rejects — exactly right for a
    # market that is genuinely undecided.
    confidence = min(0.95, abs(2.0 * prob_yes - 1.0))

    mins_left = seconds_left / 60.0
    rationale = (
        f"{symbol} spot ${spot:,.2f} vs start ${start_price:,.2f} "
        f"({move * 100:+.3f}%) with {mins_left:.1f} min left. "
        f"Realised 1m volatility implies a {denom * 100:.3f}% typical move over "
        f"the remaining window, so the current move is "
        f"{abs(move) / denom:.2f} sigma. Driftless model gives "
        f"P(close above start) = {prob_yes:.1%}."
    )

    return FastEstimate(
        prob_yes=prob_yes,
        confidence=confidence,
        move_pct=move * 100.0,
        seconds_left=seconds_left,
        spot=spot,
        start_price=start_price,
        sigma_per_sqrt_s=sigma,
        rationale=rationale,
    )
