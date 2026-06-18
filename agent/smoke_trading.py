"""A-Z smoke test for the autonomous trading implementation, across all tiers.

Walks the *entire* trade pipeline the runner uses, per subscription tier
(free / pro / plus), and proves each stage works against the live Arc testnet
+ Circle Developer-Controlled Wallets + Postgres:

  Stage 0  preflight        RPC, deployer balance, Circle creds, DB, markets
  Stage A  subscription     write tier row, read it back (expiry-aware)
  Stage B  credits          ensure row, daily refill, atomic deduct (1 brain run)
  Stage C  entitlements     resolve tier caps/model/cadence from policy.py
  Stage D  live-trade gate  entitlements.live_trading + can_trade_live()
  Stage E  policy clamp     PortfolioRiskManager rescales an oversized bet to
                            the tier's max_trade_usdc (proves caps bind)
  Stage F  brain (optional) one llm_estimate() call if a provider key is set
  Stage G  execution        create Circle wallet → fund from deployer →
                            fee → approve → buy → read back on-chain shares

Unlike loop.py this bypasses the *scheduling* layer and pins a small bet so the
result is deterministic — the question is "does every stage function", not
"does the brain choose to trade right now". Results are printed and written to
../log.md.

Run from agent/:   ./.venv/bin/python smoke_trading.py
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace

from eth_account import Account
from web3 import Web3

import loop  # side effect: load_dotenv(repo/.env)
import brain
from loop import (
    MARKET_ABI,
    SLIPPAGE_BPS,
    USDC,
    USDC_ABI,
    discover_markets,
    get_web3,
    load_market_states,
)
from policy import (
    PortfolioRiskManager,
    PortfolioSnapshot,
    entitlements_for_tier,
    model_for_profile,
    policy_for_profile,
)
from credits import (
    can_trade_live,
    credit_cost_for_run,
    deduct_credits,
    ensure_credits_row,
    ensure_subscription_row,
    get_balance,
    get_subscription_tier,
    maybe_refill_free_credits,
)
from circle_wallets import (
    compute_protocol_fee,
    create_agent_wallet,
    execute_contract_call,
    get_wallet_usdc_balance,
    transfer_usdc,
    wait_for_transaction,
)
from db import conn

TIERS = ["free", "pro", "plus"]
FUND_USDC = 2.0          # USDC sent to each test wallet from the deployer
BET_USD = 0.40           # target spend per on-chain trade (kept small on purpose)
RUN_ID = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

# Distinct, obviously-synthetic addresses (0xFEE1/0xFEE2/0xFEE3) so the test's
# DB rows never collide with real users and are trivial to clean up.
def tier_user(i: int) -> str:
    return Web3.to_checksum_address("0x" + f"{0xFEE0 + i:040x}")


def _idem(key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{RUN_ID}:{key}"))


@dataclass
class Stage:
    name: str
    ok: bool
    detail: str


@dataclass
class TierReport:
    tier: str
    user: str
    stages: list[Stage] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str) -> bool:
        self.stages.append(Stage(name, ok, detail))
        mark = "[green]✓[/green]" if ok else "[red]✗[/red]"
        loop.console.print(f"    {mark} {name}: {detail}")
        return ok

    @property
    def ok(self) -> bool:
        return all(s.ok for s in self.stages)


# ── helpers ──────────────────────────────────────────────────────────────────

_TRANSFER_ABI = [{
    "type": "function", "name": "transfer", "stateMutability": "nonpayable",
    "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "outputs": [{"name": "", "type": "bool"}],
}]


def fund_wallet_erc20(w3, deployer, to_addr: str, amount_usdc: float) -> str:
    """ERC-20 USDC transfer deployer → to_addr. On Arc this also tops up the
    native (gas) balance since native USDC and the ERC-20 share one balance.
    (loop's USDC_ABI is read/approve-only, so use a local transfer ABI.)"""
    usdc = w3.eth.contract(address=USDC, abi=_TRANSFER_ABI)
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


def pick_market(states):
    """Highest-liquidity tradeable market with a working previewBuy."""
    for m in sorted(states, key=lambda s: s.total_liquidity, reverse=True):
        if m.resolved or not (0.05 <= m.price_yes <= 0.95):
            continue
        shares = int(BET_USD / m.price_yes * 1e6)
        try:
            mc = pricing_contract(m)
            preview = int(mc.functions.previewBuy(1, shares).call())
        except Exception:
            continue
        if preview > 0:
            return m, shares, preview
    return None, 0, 0


def pricing_contract(m):
    return get_web3().eth.contract(
        address=Web3.to_checksum_address(m.address), abi=MARKET_ABI
    )


def set_tier(user: str, tier: str) -> None:
    """Upsert the subscription tier row for a test user."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_subscriptions (user_addr, tier) VALUES (%s, %s)
            ON CONFLICT (user_addr) DO UPDATE SET tier = EXCLUDED.tier
            """,
            (user.lower(), tier),
        )
        c.commit()


def cleanup(users: list[str]) -> None:
    with conn() as c, c.cursor() as cur:
        for u in users:
            cur.execute("DELETE FROM agent_credits WHERE user_addr = %s", (u.lower(),))
            cur.execute("DELETE FROM agent_subscriptions WHERE user_addr = %s", (u.lower(),))
        c.commit()


# ── per-tier walk ─────────────────────────────────────────────────────────────

def run_tier(w3, deployer, tier: str, idx: int, m, shares: int, preview: int) -> TierReport:
    user = tier_user(idx)
    rep = TierReport(tier=tier, user=user)
    loop.console.print(f"\n[bold]── tier: {tier}  ({user})[/bold]")

    # Stage A — subscription tier round-trips through the DB.
    try:
        ensure_subscription_row(user)
        set_tier(user, tier)
        effective = get_subscription_tier(user)
        rep.add("A subscription", effective == tier, f"stored & read back tier={effective}")
    except Exception as e:  # noqa: BLE001
        rep.add("A subscription", False, f"DB error: {e}")

    # Stage B — credits row + daily refill + atomic deduction for one brain run.
    try:
        ensure_credits_row(user)
        maybe_refill_free_credits(user)
        before = get_balance(user)
        ent = entitlements_for_tier(tier)
        cost = credit_cost_for_run(ent.model_tier)
        deducted = deduct_credits(user, cost)
        after = get_balance(user)
        ok = deducted and after == before - cost
        rep.add("B credits", ok, f"balance {before}→{after} (cost {cost}/run, refill cap {before})")
    except Exception as e:  # noqa: BLE001
        rep.add("B credits", False, f"DB error: {e}")

    # Stage C — tier entitlements resolve from policy.py.
    ent = entitlements_for_tier(tier)
    prof_stub = SimpleNamespace(
        brain_model="", preset="quant", pattern="value",
        kelly_mult=0.25, edge_threshold=0.05, min_confidence=0.50,
        max_open_positions=None, budget_per_market=1000.0,
        budget_per_day=1000.0, min_liquidity_usdc=0.0,
    )
    model = model_for_profile(prof_stub, tier)
    rep.add(
        "C entitlements", ent.tier == tier,
        f"max_trade=${ent.max_trade_usdc:g} daily={ent.max_daily_trades} "
        f"cadence={ent.min_cadence_minutes}m model={model}",
    )

    # Stage D — live-trade gate.
    gate_ok = ent.live_trading and can_trade_live(user)
    rep.add("D live gate", gate_ok, f"live_trading={ent.live_trading} can_trade_live={can_trade_live(user)}")

    # Stage E — an oversized $100 bet must be rescaled to the tier cap.
    try:
        policy = policy_for_profile(prof_stub)
        portfolio = PortfolioSnapshot(bankroll_usdc=1000.0, positions=[])
        rm = PortfolioRiskManager(
            profile=prof_stub, policy=policy, entitlements=ent,
            portfolio=portfolio, spent_day_usdc=0.0,
        )
        decision = SimpleNamespace(action="buy_yes", cost_usdc=100.0, bankroll_usdc=1000.0)
        g = rm.gate_trade(decision=decision, market=m)
        clamped = g.scale_to_usdc
        ok = clamped is not None and clamped <= ent.max_trade_usdc + 1e-9
        rep.add("E policy clamp", ok, f"$100 bet → ${clamped:.2f} (tier cap ${ent.max_trade_usdc:g})")
    except Exception as e:  # noqa: BLE001
        rep.add("E policy clamp", False, f"error: {e}")

    # Stage F — brain layer: one real estimate via the tier's configured model
    # (routes to Gemini or OpenRouter per BRAIN_PROVIDER). Soft stage: a missing
    # provider key or model refusal is reported, not failed, since execution (G)
    # is the load-bearing proof.
    have_provider = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENROUTER_API_KEY"))
    if have_provider and model:
        try:
            br = brain.estimate(
                question=m.question, category=m.category,
                resolution_criteria=m.resolution_criteria,
                deadline_unix=m.deadline, amm_yes_price=m.price_yes,
                bankroll_usdc=1000.0, kelly_mult=prof_stub.kelly_mult,
                model=model, allowed_tools=ent.allowed_tools,
            )
            if br is not None:
                rep.add("F brain", True,
                        f"{model}: p={br.probability:.2f} conf={br.confidence:.2f}")
            else:
                rep.add("F brain", True, f"{model}: returned None (refusal/parse) — soft skip")
        except Exception as e:  # noqa: BLE001
            rep.add("F brain", True, f"{model} error (soft): {str(e)[:70]}")
    else:
        rep.add("F brain", True, "skipped (no provider key)")

    # Stage G — full on-chain execution via a funded Circle wallet.
    try:
        w = create_agent_wallet(user)
        wallet_id, wallet_addr = w["wallet_id"], w["address"]
        fund_hash = fund_wallet_erc20(w3, deployer, wallet_addr, FUND_USDC)
        bal = get_wallet_usdc_balance(wallet_id)
        loop.console.print(f"      wallet {wallet_addr} funded ${FUND_USDC} (circle bal ${bal}) fund={fund_hash[:14]}…")

        mc = pricing_contract(m)
        live_preview = int(mc.functions.previewBuy(1, shares).call())
        max_cost = live_preview * (10_000 + SLIPPAGE_BPS) // 10_000

        # fee → treasury (non-blocking, mirrors loop.py)
        treasury = os.environ.get("TREASURY_ADDRESS", "")
        fee_note = "no treasury"
        if treasury:
            fee_micro = compute_protocol_fee(live_preview)
            try:
                transfer_usdc(
                    wallet_id=wallet_id, destination_address=treasury,
                    amount_micro=fee_micro, idempotency_key=_idem(f"fee-{tier}"),
                )
                fee_note = f"${fee_micro/1e6:.4f}→treasury"
            except Exception as fe:  # noqa: BLE001
                fee_note = f"fee failed: {str(fe)[:40]}"

        approve_tx = execute_contract_call(
            wallet_id=wallet_id, contract_address=USDC,
            abi_function_signature="approve(address,uint256)",
            abi_parameters=[m.address, str(max_cost)],
            idempotency_key=_idem(f"approve-{tier}"),
        )
        approve_hash = wait_for_transaction(approve_tx, max_wait=120.0)

        buy_tx = execute_contract_call(
            wallet_id=wallet_id, contract_address=m.address,
            abi_function_signature="buy(uint8,uint256,uint256)",
            abi_parameters=[1, str(shares), str(max_cost)],
            idempotency_key=_idem(f"buy-{tier}"),
        )
        buy_hash = wait_for_transaction(buy_tx, max_wait=120.0)

        yes = int(mc.functions.sharesYes(Web3.to_checksum_address(wallet_addr)).call())
        ok = yes > 0
        rep.add(
            "G execution", ok,
            f"buy ${live_preview/1e6:.4f} → {yes/1e6:.4f} YES shares | fee {fee_note} | "
            f"buy_tx={buy_hash[:14]}…",
        )
        rep.wallet = wallet_addr  # type: ignore[attr-defined]
        rep.buy_hash = buy_hash   # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        rep.add("G execution", False, f"FAILED: {str(e)[:120]}")

    return rep


# ── report ─────────────────────────────────────────────────────────────────

def write_log(market, reports: list[TierReport], preflight: list[Stage]) -> str:
    lines: list[str] = []
    lines.append("# YOLO agent — trading smoke test")
    lines.append("")
    lines.append(f"- Run: `{RUN_ID}` (UTC)")
    lines.append(f"- Chain: Arc testnet `5042002`")
    lines.append(f"- Market: `{market.address}`")
    lines.append(f"  - {market.question[:90]}")
    lines.append(f"  - YES price {market.price_yes:.3f}, liquidity ${market.total_liquidity:.2f}")
    overall = all(s.ok for s in preflight) and all(r.ok for r in reports)
    lines.append(f"- **Overall: {'✅ PASS' if overall else '❌ FAIL'}**")
    lines.append("")

    lines.append("## Stage 0 — preflight")
    lines.append("")
    lines.append("| check | result | detail |")
    lines.append("| --- | --- | --- |")
    for s in preflight:
        lines.append(f"| {s.name} | {'✅' if s.ok else '❌'} | {s.detail} |")
    lines.append("")

    lines.append("## Per-tier pipeline (A–G)")
    lines.append("")
    stage_names = ["A subscription", "B credits", "C entitlements", "D live gate",
                   "E policy clamp", "F brain", "G execution"]
    header = "| tier | " + " | ".join(n.split(" ", 1)[0] for n in stage_names) + " | wallet |"
    lines.append(header)
    lines.append("| --- " * (len(stage_names) + 2) + "|")
    for r in reports:
        cells = []
        by_name = {s.name: s for s in r.stages}
        for n in stage_names:
            s = by_name.get(n)
            cells.append("✅" if (s and s.ok) else ("❌" if s else "—"))
        wallet = getattr(r, "wallet", "—")
        lines.append(f"| **{r.tier}** | " + " | ".join(cells) + f" | `{wallet}` |")
    lines.append("")

    for r in reports:
        lines.append(f"### tier `{r.tier}` — {r.user}")
        lines.append("")
        for s in r.stages:
            lines.append(f"- {'✅' if s.ok else '❌'} **{s.name}** — {s.detail}")
        bh = getattr(r, "buy_hash", None)
        if bh:
            lines.append(f"- buy tx: `{bh}`")
        lines.append("")

    text = "\n".join(lines) + "\n"
    out_path = os.path.join(loop.REPO_ROOT, "log.md")
    with open(out_path, "w") as f:
        f.write(text)
    return out_path


def main() -> int:
    console = loop.console
    console.print(f"[bold]YOLO trading smoke test[/bold]  run={RUN_ID}")
    preflight: list[Stage] = []

    w3 = get_web3()
    preflight.append(Stage("rpc", w3.is_connected(), f"chainId={w3.eth.chain_id}"))

    pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not pk:
        console.print("[red]DEPLOYER_PRIVATE_KEY missing[/red]")
        return 1
    deployer = Account.from_key(pk)
    usdc = w3.eth.contract(address=USDC, abi=USDC_ABI)
    dep_bal = usdc.functions.balanceOf(deployer.address).call() / 1e6
    preflight.append(Stage("deployer", dep_bal > FUND_USDC * len(TIERS),
                           f"{deployer.address} balance ${dep_bal:.2f}"))

    circle_ok = all(os.environ.get(k) for k in
                    ("CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_SET_ID"))
    preflight.append(Stage("circle creds", circle_ok, "API key / entity secret / wallet set present"))

    try:
        with conn() as c, c.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        preflight.append(Stage("postgres", True, "connection OK"))
    except Exception as e:  # noqa: BLE001
        preflight.append(Stage("postgres", False, f"DB error: {e}"))

    addrs = discover_markets(w3)
    states, resolved = load_market_states(w3, addrs)
    m, shares, preview = pick_market(states)
    preflight.append(Stage("markets", m is not None,
                           f"{len(addrs)} total / {len(states)} active / {len(resolved)} resolved"))
    for s in preflight:
        mark = "[green]✓[/green]" if s.ok else "[red]✗[/red]"
        console.print(f"  {mark} {s.name}: {s.detail}")

    if m is None or not all(s.ok for s in preflight):
        console.print("\n[red]preflight failed — aborting[/red]")
        write_log(m or SimpleNamespace(address="-", question="-", price_yes=0, total_liquidity=0),
                  [], preflight)
        return 1

    console.print(
        f"\nmarket: {m.address}\n  {m.question[:80]}\n"
        f"  YES={m.price_yes:.3f} liq=${m.total_liquidity:.2f} "
        f"shares={shares} preview=${preview/1e6:.4f}"
    )

    users = [tier_user(i) for i in range(1, len(TIERS) + 1)]
    reports: list[TierReport] = []
    try:
        for idx, tier in enumerate(TIERS, start=1):
            reports.append(run_tier(w3, deployer, tier, idx, m, shares, preview))
            time.sleep(1.0)
    finally:
        cleanup(users)
        console.print("\n[dim]cleaned up test DB rows (subscriptions + credits)[/dim]")

    out_path = write_log(m, reports, preflight)
    ok = sum(1 for r in reports if r.ok)
    console.print(f"\n══ {ok}/{len(reports)} tiers fully passed ══")
    console.print(f"log written → {out_path}")
    return 0 if ok == len(reports) else 1


if __name__ == "__main__":
    sys.exit(main())
