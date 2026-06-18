"""Smoke test: prove Circle Developer-Controlled wallets can actually trade.

Steps:
  1. Create N Circle wallets (one per dummy user address).
  2. Fund each from the deployer EOA via an ERC-20 USDC transfer.
  3. Pick one live, tradeable market.
  4. For each wallet, run the SAME execution path the agent uses
     (loop.py Circle branch): protocol fee -> treasury, approve, buy,
     then read back the on-chain share balance to confirm the position.

This bypasses the LLM/policy machinery on purpose — the question here is
strictly "can a funded Circle wallet place a trade on Arc", not "does the
brain decide to". Run from agent/:

    ./.venv/bin/python smoke_circle.py
"""

from __future__ import annotations

import os
import sys
import time
import uuid


def _idem(key: str) -> str:
    """Circle requires idempotencyKey in UUID format — derive a deterministic
    UUID from a human-readable key so retries stay idempotent."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, key))

from eth_account import Account
from web3 import Web3

import loop  # noqa: F401 — import side effect: loads .env
from loop import (
    MARKET_ABI,
    SLIPPAGE_BPS,
    USDC,
    USDC_ABI,
    discover_markets,
    get_web3,
    read_market_state,
)
from circle_wallets import (
    compute_protocol_fee,
    create_agent_wallet,
    execute_contract_call,
    get_wallet_usdc_balance,
    transfer_usdc,
    wait_for_transaction,
)

N_WALLETS = 3
FUND_USDC = 3.0          # USDC sent to each wallet from the deployer
BET_USD = 0.40           # target spend per trade
DUMMY_USERS = [
    "0x000000000000000000000000000000000000C001",
    "0x000000000000000000000000000000000000C002",
    "0x000000000000000000000000000000000000C003",
]


def fund_wallet_erc20(w3: Web3, deployer, to_addr: str, amount_usdc: float) -> str:
    """ERC-20 USDC transfer deployer -> to_addr. On Arc this also tops up the
    native (gas) balance since native USDC and the ERC-20 share one balance."""
    transfer_abi = [{
        "type": "function", "name": "transfer", "stateMutability": "nonpayable",
        "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    }]
    usdc = w3.eth.contract(address=USDC, abi=transfer_abi)
    amount_micro = int(round(amount_usdc * 1e6))
    tx = usdc.functions.transfer(
        Web3.to_checksum_address(to_addr), amount_micro
    ).build_transaction({
        "from": deployer.address,
        "nonce": w3.eth.get_transaction_count(deployer.address),
        "gasPrice": w3.eth.gas_price,
        "gas": 120_000,
    })
    signed = deployer.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    if rcpt.status != 1:
        raise RuntimeError(f"funding transfer reverted ({h.hex()})")
    return h.hex()


def pick_tradeable_market(w3: Web3, addrs: list[str]):
    """First non-resolved market with a sane YES price and a working preview."""
    for addr in addrs:
        try:
            m = read_market_state(w3, addr)
        except Exception:
            continue
        if m.resolved:
            continue
        if not (0.05 <= m.price_yes <= 0.95):
            continue
        try:
            shares = int(BET_USD / m.price_yes * 1e6)
            mc = w3.eth.contract(
                address=Web3.to_checksum_address(addr), abi=MARKET_ABI
            )
            preview = int(mc.functions.previewBuy(1, shares).call())
            if preview <= 0:
                continue
        except Exception:
            continue
        return m, shares, preview
    return None, 0, 0


def trade_one(w3: Web3, wallet_id: str, wallet_addr: str, m, shares: int) -> dict:
    """Mirror loop.py's Circle execution branch: fee -> approve -> buy -> verify."""
    side_id = 1  # buy YES
    mc = w3.eth.contract(address=Web3.to_checksum_address(m.address), abi=MARKET_ABI)
    preview = int(mc.functions.previewBuy(side_id, shares).call())
    max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
    treasury = os.environ.get("TREASURY_ADDRESS", "")

    result: dict = {"wallet": wallet_addr, "preview_usdc": preview / 1e6}

    # Step 1: protocol fee -> treasury (non-blocking like the agent).
    if treasury:
        fee_micro = compute_protocol_fee(preview)
        result["fee_usdc"] = fee_micro / 1e6
        try:
            fee_tx = transfer_usdc(
                wallet_id=wallet_id,
                destination_address=treasury,
                amount_micro=fee_micro,
                idempotency_key=_idem(f"smoke-fee-{wallet_addr}-{m.address}"),
            )
            result["fee_tx_id"] = fee_tx
        except Exception as e:  # noqa: BLE001
            result["fee_error"] = str(e)[:200]

    # Step 2: approve USDC for the market.
    approve_tx = execute_contract_call(
        wallet_id=wallet_id,
        contract_address=USDC,
        abi_function_signature="approve(address,uint256)",
        abi_parameters=[m.address, str(max_cost)],
        idempotency_key=_idem(f"smoke-approve-{wallet_addr}-{m.address}"),
    )
    result["approve_hash"] = wait_for_transaction(approve_tx, max_wait=120.0)

    # Step 3: buy().
    buy_tx = execute_contract_call(
        wallet_id=wallet_id,
        contract_address=m.address,
        abi_function_signature="buy(uint8,uint256,uint256)",
        abi_parameters=[side_id, str(shares), str(max_cost)],
        idempotency_key=_idem(f"smoke-buy-{wallet_addr}-{m.address}"),
    )
    result["buy_hash"] = wait_for_transaction(buy_tx, max_wait=120.0)

    # Step 4: verify on-chain position.
    yes = int(mc.functions.sharesYes(Web3.to_checksum_address(wallet_addr)).call())
    result["shares_yes"] = yes / 1e6
    result["ok"] = yes > 0
    return result


def main() -> int:
    w3 = get_web3()
    if not w3.is_connected():
        print("not connected to Arc")
        return 1

    pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not pk:
        print("DEPLOYER_PRIVATE_KEY missing")
        return 1
    deployer = Account.from_key(pk)
    print(f"deployer: {deployer.address}")
    print(f"treasury: {os.environ.get('TREASURY_ADDRESS', '(unset)')}")

    # 1 + 2: create and fund wallets.
    wallets = []
    for user in DUMMY_USERS[:N_WALLETS]:
        w = create_agent_wallet(user)
        print(f"\n· wallet for {user[:10]}…  id={w['wallet_id']}  addr={w['address']}")
        fh = fund_wallet_erc20(w3, deployer, w["address"], FUND_USDC)
        print(f"  funded {FUND_USDC} USDC  tx={fh[:18]}…")
        usdc = w3.eth.contract(address=USDC, abi=USDC_ABI)
        onchain = usdc.functions.balanceOf(
            Web3.to_checksum_address(w["address"])
        ).call() / 1e6
        native = w3.eth.get_balance(Web3.to_checksum_address(w["address"])) / 1e18
        circle_bal = get_wallet_usdc_balance(w["wallet_id"])
        print(f"  balanceOf(erc20)={onchain}  native(gas)={native}  circleAPI={circle_bal}")
        wallets.append(w)

    # 3: pick a market.
    addrs = discover_markets(w3)
    m, shares, preview = pick_tradeable_market(w3, addrs)
    if m is None:
        print("\nno tradeable market found")
        return 1
    print(
        f"\nmarket: {m.address}\n  {m.question[:80]}\n"
        f"  price_yes={m.price_yes:.3f}  shares={shares}  preview=${preview/1e6:.4f}"
    )

    # 4: trade from each wallet.
    print("\n── trading ──")
    results = []
    for w in wallets:
        print(f"\n· {w['address']}")
        try:
            r = trade_one(w3, w["wallet_id"], w["address"], m, shares)
            for k, v in r.items():
                print(f"    {k}: {v}")
            results.append(r)
        except Exception as e:  # noqa: BLE001
            print(f"    FAILED: {e}")
            results.append({"wallet": w["address"], "ok": False, "error": str(e)})
        time.sleep(1.0)

    ok = sum(1 for r in results if r.get("ok"))
    print(f"\n══ {ok}/{len(results)} wallets traded successfully ══")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
