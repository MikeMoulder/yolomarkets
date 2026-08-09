"""Per-decision metering fee for agent reasoning requests.

Before a live reasoning request is sent, the user's agent pays a USDC fee.
There are two settlement paths, and which one ran is recorded in the receipt's
`scheme` so the trail never overstates what happened:

  · `x402-nanopayment` — the real thing. The user's dedicated **payments EOA**
    signs an EIP-3009 authorization (key stays in Circle's MPC) and Circle's
    facilitator settles it on the batched Gateway rail. Sub-cent and gasless.

  · `x402` — the legacy fallback: a plain Circle wallet USDC transfer. Used
    when a profile has no payments wallet, or when the nanopay service is
    unreachable. It moves the money correctly but it is a transfer, not a
    protocol settlement, and it should not be described as x402 settlement.

Why a separate payments wallet exists at all: nanopayments require an EOA, the
trading wallets are SCA (and hold open positions, so they can't be swapped),
and Circle fixes account type at creation. See migration 0012.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
import os
import time
import uuid

import httpx

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


def _settle_via_nanopayments(
    receipt: X402Receipt,
    *,
    payments_wallet_id: str,
    payments_address: str,
) -> bool:
    """Settle the fee as a real Circle Nanopayment. True if it settled.

    The user's own payments EOA signs an EIP-3009 authorization (via Circle's
    MPC — no key leaves Circle) and Circle's facilitator settles it on the
    batched Gateway rail. Returns False rather than raising so the caller can
    fall back: a payment-rail change must never stop the agent trading.
    """
    try:
        import nanopay

        r = httpx.post(
            f"{nanopay._base_url()}/pay-fee",
            json={
                "walletId": payments_wallet_id,
                "address": payments_address,
                "payTo": receipt.pay_to,
                "amountMicro": str(receipt.amount_micro),
                "resource": receipt.resource,
                "description": f"reasoning fee · {receipt.request_id}",
            },
            headers=nanopay._headers(),
            timeout=90.0,
        )
        if r.status_code != 200:
            return False
        d = r.json()
        receipt.circle_tx_id = d.get("transaction")
        receipt.settled = True
        return True
    except Exception:
        return False


def settle_reasoning_request(
    *,
    wallet_id: str | None,
    user_addr: str,
    market_addr: str,
    model: str,
    payments_wallet_id: str | None = None,
    payments_address: str | None = None,
) -> X402Receipt:
    """Settle the x402 price before a live reasoning request.

    Preferred path is a real Circle Nanopayment from the user's dedicated
    payments EOA — actual x402 settlement on the batched Gateway rail, priced
    at cost rather than at the legacy $0.01.

    Fallback is the original Circle wallet USDC transfer, used when the profile
    has no payments wallet or the nanopay service is unavailable. That path
    works but is a plain transfer, not a protocol settlement.
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

    if payments_wallet_id and payments_address:
        if _settle_via_nanopayments(
            receipt,
            payments_wallet_id=payments_wallet_id,
            payments_address=payments_address,
        ):
            receipt.scheme = "x402-nanopayment"
            return receipt

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
