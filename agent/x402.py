"""x402-style payment wrapper for agent reasoning requests.

The trading agent used to call the reasoning system directly after passing
local quota gates. This module makes the payment requirement explicit: before
a live reasoning request is sent, the user's Circle agent wallet pays the
configured USDC price to the x402 receiver.

The reasoning call is still in-process today, but the payment contract around
it is represented as an x402 payment requirement and settlement receipt so it
can move behind an HTTP 402 endpoint later without changing the runner flow.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
import os
import time
import uuid

from circle_wallets import transfer_usdc, wait_for_transaction

USDC_DECIMALS = 6
DEFAULT_REASONING_FEE_USDC = "0.01"


class X402PaymentRequired(RuntimeError):
    """Raised when a reasoning request cannot satisfy the x402 payment."""


@dataclass
class X402Receipt:
    scheme: str
    network: str
    asset: str
    asset_decimals: int
    amount_micro: int
    amount_usdc: str
    pay_to: str | None
    resource: str
    payer: str
    request_id: str
    settled: bool
    circle_tx_id: str | None = None
    tx_hash: str | None = None

    def as_policy_snapshot(self) -> dict:
        return asdict(self)


def x402_reasoning_fee_micro() -> int:
    """Configured x402 reasoning price in USDC 6-dec units."""
    raw = (
        os.environ.get("AGENT_X402_REASONING_FEE_USDC")
        or os.environ.get("X402_REASONING_FEE_USDC")
        or DEFAULT_REASONING_FEE_USDC
    )
    try:
        amount = Decimal(raw)
    except InvalidOperation as e:
        raise X402PaymentRequired(f"invalid x402 reasoning fee: {raw!r}") from e
    if amount < 0:
        raise X402PaymentRequired("x402 reasoning fee cannot be negative")
    return int((amount * Decimal(10**USDC_DECIMALS)).to_integral_value())


def x402_reasoning_fee_usdc() -> float:
    return x402_reasoning_fee_micro() / 10**USDC_DECIMALS


def x402_pay_to_address() -> str | None:
    return (
        os.environ.get("AGENT_X402_PAY_TO_ADDRESS")
        or os.environ.get("X402_PAY_TO_ADDRESS")
        or os.environ.get("TREASURY_ADDRESS")
        or os.environ.get("AI_INSIGHT_FEE_RECIPIENT")
        or os.environ.get("NEXT_PUBLIC_AI_INSIGHT_FEE_RECIPIENT")
        or None
    )


def x402_payment_requirement(
    *,
    user_addr: str,
    market_addr: str,
    model: str,
) -> X402Receipt:
    amount_micro = x402_reasoning_fee_micro()
    amount_usdc = f"{amount_micro / 10**USDC_DECIMALS:.6f}".rstrip("0").rstrip(".")
    return X402Receipt(
        scheme="x402",
        network=os.environ.get("X402_NETWORK", "arc-testnet"),
        asset=os.environ.get("X402_ASSET", "USDC"),
        asset_decimals=USDC_DECIMALS,
        amount_micro=amount_micro,
        amount_usdc=amount_usdc,
        pay_to=x402_pay_to_address(),
        resource=os.environ.get("AGENT_X402_REASONING_RESOURCE", "yolo://agent/reasoning"),
        payer=user_addr.lower(),
        request_id=f"reasoning:{user_addr.lower()}:{market_addr.lower()}:{model}:{int(time.time())}",
        settled=False,
    )


def settle_reasoning_request(
    *,
    wallet_id: str | None,
    user_addr: str,
    market_addr: str,
    model: str,
) -> X402Receipt:
    """Settle the x402 price before a live reasoning request.

    Settlement currently uses a Circle Developer-Controlled wallet USDC
    transfer. Legacy AgentAccount sessions are buy-scoped, so they cannot
    satisfy this arbitrary USDC payment and the request is rejected.
    """
    receipt = x402_payment_requirement(
        user_addr=user_addr,
        market_addr=market_addr,
        model=model,
    )
    if receipt.amount_micro == 0:
        receipt.settled = True
        return receipt
    if not receipt.pay_to:
        raise X402PaymentRequired("x402 pay-to address is not configured")
    if not wallet_id:
        raise X402PaymentRequired(
            "x402 reasoning payment requires a Circle agent wallet"
        )

    circle_tx_id = transfer_usdc(
        wallet_id=wallet_id,
        destination_address=receipt.pay_to,
        amount_micro=receipt.amount_micro,
        idempotency_key=str(uuid.uuid5(uuid.NAMESPACE_URL, receipt.request_id)),
    )
    tx_hash = wait_for_transaction(circle_tx_id, max_wait=90.0)

    receipt.circle_tx_id = circle_tx_id
    receipt.tx_hash = tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
    receipt.settled = True
    return receipt
