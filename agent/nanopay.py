"""Circle Nanopayments client — the agent's ability to buy services with USDC.

This is Leg B of the payment design (see ENCODE_PLAN.md): the platform's payer
EOA spends sub-cent USDC on real third-party x402 services, gaslessly, batched
through Circle Gateway on Arc. It is deliberately NOT the same thing as
`x402.py`, which is Leg A — the user's Circle wallet paying the platform.
Keeping them separate keeps the economics honest: one is revenue, one is cost.

Why this module is a thin HTTP client rather than an implementation:
`@circle-fin/x402-batching` is a TypeScript/viem package and nanopayments
settle as EIP-3009 signatures, which also means the payer must be an **EOA** —
a Circle SCA wallet cannot sign them. `web/scripts/nanopay-service.ts` owns the
key and the signing; this module just asks it to spend. Reimplementing EIP-3009
in Python would mean owning that security surface for no benefit.

Every function degrades to `None`/`False` rather than raising when the service
is unreachable. A payment rail being down must never stop the agent from
trading — same fail-safe posture as the planner.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import os
from typing import Any

import httpx

USDC_DECIMALS = 6
DEFAULT_TIMEOUT_S = 20.0


class NanopayError(RuntimeError):
    """Raised only by `pay_strict` — the normal helpers degrade quietly."""


@dataclass
class NanopayReceipt:
    """Settlement record for one nanopayment. Persisted with the decision."""

    url: str
    amount_micro: int
    amount_usdc: str
    network: str | None
    asset: str | None
    elapsed_ms: int | None
    result: Any = None

    def as_snapshot(self) -> dict:
        # `result` can be an arbitrary service payload; keep it out of the
        # snapshot so a chatty upstream can't bloat every decision row.
        d = asdict(self)
        d.pop("result", None)
        return d


def _base_url() -> str:
    return (
        os.environ.get("NANOPAY_SERVICE_URL")
        or f"http://127.0.0.1:{os.environ.get('NANOPAY_PORT', '8090')}"
    ).rstrip("/")


def _headers() -> dict[str, str]:
    secret = os.environ.get("NANOPAY_SHARED_SECRET")
    return {"x-nanopay-secret": secret} if secret else {}


def _enabled() -> bool:
    """Nanopayments are opt-in, like the planner. Default off."""
    return os.environ.get("AGENT_NANOPAY", "0") != "0"


def _get(path: str, params: dict | None = None, timeout: float = DEFAULT_TIMEOUT_S):
    try:
        r = httpx.get(
            f"{_base_url()}{path}",
            params=params,
            headers=_headers(),
            timeout=timeout,
        )
        return r
    except Exception:
        return None


def available() -> bool:
    """True when the nanopay service is up and holds a configured payer key."""
    if not _enabled():
        return False
    r = _get("/health", timeout=5.0)
    if r is None or r.status_code != 200:
        return False
    try:
        return bool(r.json().get("configured"))
    except Exception:
        return False


def balance() -> dict | None:
    """Wallet + Gateway balances, or None when unavailable."""
    r = _get("/balance")
    if r is None or r.status_code != 200:
        return None
    try:
        return r.json()
    except Exception:
        return None


def supports(url: str) -> dict | None:
    """Whether `url` will settle via Gateway batching on our chain.

    IMPORTANT: do not infer this from the Circle Discovery catalogue. That
    catalogue's `network` field understates reality — hosts that advertise only
    Base/Polygon there will still negotiate Arc when asked by an Arc client,
    and most hosts that look plausible refuse Arc outright. Probing is the only
    reliable test. The service caches the answer.
    """
    r = _get("/supports", params={"url": url})
    if r is None or r.status_code != 200:
        return None
    try:
        return r.json().get("result")
    except Exception:
        return None


def pay(
    url: str,
    *,
    method: str = "GET",
    body: Any = None,
    headers: dict[str, str] | None = None,
    max_amount_micro: int | None = None,
    timeout: float = 60.0,
) -> NanopayReceipt | None:
    """Pay for an x402 resource. Returns None on any failure.

    `max_amount_micro` is a ceiling the caller may *lower* to; the service's own
    per-payment and 24h caps always apply on top and cannot be widened here.
    """
    if not _enabled():
        return None
    payload: dict[str, Any] = {"url": url, "method": method}
    if body is not None:
        payload["body"] = body
    if headers:
        payload["headers"] = headers
    if max_amount_micro is not None:
        payload["maxAmountMicro"] = str(int(max_amount_micro))

    try:
        r = httpx.post(
            f"{_base_url()}/pay",
            json=payload,
            headers=_headers(),
            timeout=timeout,
        )
    except Exception:
        return None

    if r.status_code != 200:
        return None
    try:
        d = r.json()
    except Exception:
        return None

    return NanopayReceipt(
        url=d.get("url", url),
        amount_micro=int(d.get("amountMicro", 0)),
        amount_usdc=str(d.get("amountUsdc", "0")),
        network=d.get("network"),
        asset=d.get("asset"),
        elapsed_ms=d.get("elapsedMs"),
        result=d.get("result"),
    )


# ── Paid Arc RPC ───────────────────────────────────────────────────────────
# The service exposes a JSON-RPC passthrough that pays QuickNode $0.0001 per
# call. It matters because the FREE Arc endpoints are what keep breaking:
# quicknode rate-limits `eth_call` to ~1 per period (-32011), which is the
# single call every market read depends on. Measured: 4 consecutive eth_calls
# through the paid endpoint all succeeded where the free tier dies after one.

_health_cache: dict[str, Any] = {"at": 0.0, "ok": False}
_HEALTH_TTL_S = 60.0


def _healthy_cached() -> bool:
    """`available()` with a short TTL — get_web3() must not pay a round-trip."""
    import time

    now = time.time()
    if now - float(_health_cache["at"]) < _HEALTH_TTL_S:
        return bool(_health_cache["ok"])
    ok = available()
    _health_cache.update(at=now, ok=ok)
    return ok


def paid_rpc_url() -> str | None:
    """Provider URL for paid Arc RPC, or None when unavailable/disabled.

    Returns the raw-JSON-RPC passthrough, so it is a drop-in Web3 provider
    endpoint. Callers should keep the free RPCs as fallbacks behind it.
    """
    if not _enabled():
        return None
    if os.environ.get("AGENT_NANOPAY_RPC", "1") == "0":
        return None
    if not _healthy_cached():
        return None
    return f"{_base_url()}/rpc"


def rpc_request_kwargs(timeout: float = 20.0) -> dict:
    """`request_kwargs` for a Web3 HTTPProvider pointed at `paid_rpc_url()`."""
    return {"timeout": timeout, "headers": {"content-type": "application/json", **_headers()}}


def pay_strict(url: str, **kw) -> NanopayReceipt:
    """`pay` but raises instead of returning None. For scripts and tests."""
    receipt = pay(url, **kw)
    if receipt is None:
        raise NanopayError(f"nanopayment for {url} failed or is disabled")
    return receipt
