"""Production entrypoint for the agent runner.

Combines two responsibilities:
  1. Run the agent's watch loop (loop.py --live --watch) in the foreground.
  2. Serve a tiny HTTP health endpoint on $PORT so the hosting platform
     (Railway / Fly / Render) can detect liveness and so the web app can
     surface a "agent: up X minutes ago" status in the footer.

Why this is a separate file rather than baked into loop.py: the CLI runner
(`uv run python loop.py`) is the dev path — it's used in foreground mode,
shouldn't spawn an HTTP server, and shouldn't make the import graph
mention `http.server`. Production is sufficiently different to warrant a
shim.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── Health state ───────────────────────────────────────────────────────────
# Updated by the watch loop after each successful pass. Read by the HTTP
# handler. A dict is sufficient — we have one writer (the main thread)
# and one reader (the handler thread), and Python dict assignment is
# atomic w.r.t. the GIL for our purposes.

# `ok` is liveness — true the moment the HTTP server is serving requests.
# The platform healthcheck (Railway/Fly/Render) should always pass once
# the process is up; if the watch loop is stuck or failing, the symptoms
# surface through `last_pass_at` going stale and `passes_failed` rising,
# not through HTTP 503s that would cause Railway to kill a healthy process.
_HEALTH: dict[str, object] = {
    "ok": True,
    "started_at": datetime.now(timezone.utc).isoformat(),
    "last_pass_at": None,
    "last_pass_ok": None,
    "passes_total": 0,
    "passes_failed": 0,
    "consecutive_failures": 0,
    "last_error": None,
}


def _mark_pass(success: bool, error: str | None = None) -> None:
    _HEALTH["last_pass_at"] = datetime.now(timezone.utc).isoformat()
    _HEALTH["last_pass_ok"] = success
    _HEALTH["passes_total"] = int(_HEALTH["passes_total"]) + 1  # type: ignore[arg-type]
    if not success:
        _HEALTH["passes_failed"] = int(_HEALTH["passes_failed"]) + 1  # type: ignore[arg-type]
        _HEALTH["consecutive_failures"] = int(_HEALTH["consecutive_failures"]) + 1  # type: ignore[arg-type]
        _HEALTH["last_error"] = error
    else:
        _HEALTH["consecutive_failures"] = 0
        _HEALTH["last_error"] = None


# ── HTTP handler ───────────────────────────────────────────────────────────
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib mixed-case method
        if self.path in ("/", "/health", "/healthz"):
            payload = json.dumps(_HEALTH).encode("utf-8")
            # Always 200 once the server is serving. Staleness/failure is
            # surfaced in the JSON body, not via the status code, so the
            # platform healthcheck stays a pure liveness probe.
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:  # noqa: N802 — stdlib mixed-case method
        if self.path == "/chat":
            self._handle_chat()
        elif self.path == "/chat/record":
            self._handle_chat_record()
        else:
            self.send_response(404)
            self.end_headers()

    # ── Chat (Agent v2 · M2/M3) ─────────────────────────────────────────────
    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _auth_ok(self) -> bool:
        secret = os.environ.get("AGENT_CHAT_SHARED_SECRET")
        return not secret or self.headers.get("X-Agent-Secret") == secret

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _handle_chat_record(self) -> None:
        """Record a user-confirmed chat trade to the journal so the agent can
        explain it later and it shows in the activity narrative."""
        if not self._auth_ok():
            self._json_error(401, "unauthorized")
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_error(400, "invalid JSON body")
            return
        user_addr = (payload.get("user_addr") or "").strip()
        if not (user_addr.startswith("0x") and len(user_addr) == 42):
            self._json_error(400, "valid user_addr is required")
            return
        try:
            from db import insert_journal

            side = payload.get("side")
            shares = payload.get("shares_human")
            question = payload.get("question")
            cost = payload.get("cost_usdc")
            tx_hash = payload.get("tx_hash")
            body = (
                f"You confirmed a chat trade: bought {shares} {side} shares"
                + (f' in "{question}"' if question else "")
                + (f" for ~${cost}" if cost is not None else "")
                + " on your connected wallet."
            )
            jid = insert_journal(
                user_addr=user_addr,
                trigger="chat",
                kind="trade",
                title="Chat trade",
                body=body,
                market=payload.get("market"),
                meta={"tx_hash": tx_hash, "side": side, "shares": shares, "cost_usdc": cost},
            )
            self._json(200, {"ok": True, "id": jid})
        except Exception as e:  # noqa: BLE001
            self._json_error(500, f"{type(e).__name__}: {e}")

    def _handle_chat(self) -> None:
        # Internal auth: the Next.js proxy authenticates the user (SIWE) and
        # forwards with this shared secret. The Python service never faces the
        # browser directly. If the secret is unset (dev), allow.
        secret = os.environ.get("AGENT_CHAT_SHARED_SECRET")
        if secret and self.headers.get("X-Agent-Secret") != secret:
            self._json_error(401, "unauthorized")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json_error(400, "invalid JSON body")
            return

        message = (payload.get("message") or "").strip()
        user_addr = (payload.get("user_addr") or "").strip()
        history = payload.get("history") or []
        addresses = payload.get("addresses") or []
        # The market the user is currently viewing (from /markets/<address>).
        # Already isAddress-validated by the Next proxy; treat as an optional hint.
        current_market = (payload.get("current_market") or "").strip() or None
        if not message:
            self._json_error(400, "message is required")
            return
        if not (user_addr.startswith("0x") and len(user_addr) == 42):
            self._json_error(400, "valid user_addr is required")
            return

        # SSE stream. HTTP/1.0 (stdlib default) closes on completion, which is
        # exactly the single-turn lifecycle we want.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(evt: dict) -> bool:
            try:
                self.wfile.write(f"data: {json.dumps(evt)}\n\n".encode("utf-8"))
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError):
                return False  # client hung up

        try:
            from chat import build_chat_context, chat_turn

            ctx = build_chat_context(user_addr, addresses=addresses)
            for event in chat_turn(
                ctx=ctx,
                message=message,
                history=history,
                current_market=current_market,
            ):
                if not emit(event):
                    return
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "message": f"{type(e).__name__}: {e}"})

    # Silence the stdlib's default per-request stderr line — Railway etc.
    # already capture stdout fine and the access log adds noise.
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def _serve_health(port: int) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    print(f"[runner] health on :{port}", flush=True)
    server.serve_forever()


# ── Watch loop wrapper ─────────────────────────────────────────────────────
def _run_watch_loop(
    interval: int,
    live: bool,
    user: str | None,
    max_consecutive_failures: int,
) -> None:
    # Imported lazily so a port-already-bound failure surfaces before any
    # web3 / Postgres connection attempt.
    from loop import main_per_user

    class _Args:
        pass

    while True:
        args = _Args()
        args.live = live  # type: ignore[attr-defined]
        args.user = user  # type: ignore[attr-defined]
        args.watch = False  # we drive the loop ourselves so we can mark health
        args.watch_interval = interval  # type: ignore[attr-defined]

        try:
            rc = int(main_per_user(args))  # type: ignore[arg-type]
            if rc != 0:
                err = f"main_per_user exited with code {rc}"
                print(f"[runner] pass failed: {err}", flush=True)
                _mark_pass(False, err)
            else:
                _mark_pass(True)
        except Exception as e:  # noqa: BLE001
            print(f"[runner] pass failed: {e}", flush=True)
            _mark_pass(False, str(e))

        if int(_HEALTH["consecutive_failures"]) >= max_consecutive_failures:
            print(
                "[runner] too many consecutive failures "
                f"({int(_HEALTH['consecutive_failures'])}) — exiting for supervisor restart",
                flush=True,
            )
            raise RuntimeError("consecutive failure threshold reached")

        time.sleep(interval)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8080")),
        help="health endpoint port (defaults to $PORT)",
    )
    ap.add_argument(
        "--interval",
        type=int,
        default=int(os.environ.get("RUNNER_INTERVAL_SECONDS", "60")),
        help="seconds between watch-loop passes (default 60)",
    )
    ap.add_argument(
        "--live",
        action=argparse.BooleanOptionalAction,
        default=os.environ.get("RUNNER_LIVE", "1") != "0",
        help="broadcast trades on Arc (default: on in production)",
    )
    ap.add_argument(
        "--user",
        default=os.environ.get("RUNNER_USER"),
        help="if set, only run for this single user address",
    )
    ap.add_argument(
        "--max-consecutive-failures",
        type=int,
        default=int(os.environ.get("RUNNER_MAX_CONSECUTIVE_FAILURES", "5")),
        help="exit after N failed passes in a row so the platform can restart",
    )
    args = ap.parse_args()

    # Start the health server in a daemon thread so it never blocks shutdown.
    threading.Thread(
        target=_serve_health, args=(args.port,), daemon=True
    ).start()

    # Block on the watch loop in the main thread so signals (SIGTERM from
    # Railway/Fly during deploys) tear down cleanly.
    try:
        _run_watch_loop(
            args.interval,
            args.live,
            args.user,
            args.max_consecutive_failures,
        )
    except KeyboardInterrupt:
        print("[runner] stopped", flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[runner] fatal: {e}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
