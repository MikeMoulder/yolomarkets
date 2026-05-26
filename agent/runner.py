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

_HEALTH: dict[str, object] = {
    "ok": False,
    "started_at": datetime.now(timezone.utc).isoformat(),
    "last_pass_at": None,
    "last_pass_ok": None,
    "passes_total": 0,
    "passes_failed": 0,
}


def _mark_pass(success: bool) -> None:
    _HEALTH["last_pass_at"] = datetime.now(timezone.utc).isoformat()
    _HEALTH["last_pass_ok"] = success
    _HEALTH["passes_total"] = int(_HEALTH["passes_total"]) + 1  # type: ignore[arg-type]
    if not success:
        _HEALTH["passes_failed"] = int(_HEALTH["passes_failed"]) + 1  # type: ignore[arg-type]
    _HEALTH["ok"] = True


# ── HTTP handler ───────────────────────────────────────────────────────────
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib mixed-case method
        if self.path in ("/", "/health", "/healthz"):
            payload = json.dumps(_HEALTH).encode("utf-8")
            self.send_response(200 if _HEALTH["ok"] else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    # Silence the stdlib's default per-request stderr line — Railway etc.
    # already capture stdout fine and the access log adds noise.
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def _serve_health(port: int) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    print(f"[runner] health on :{port}", flush=True)
    server.serve_forever()


# ── Watch loop wrapper ─────────────────────────────────────────────────────
def _run_watch_loop(interval: int, live: bool, user: str | None) -> None:
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
            main_per_user(args)  # type: ignore[arg-type]
            _mark_pass(True)
        except Exception as e:  # noqa: BLE001
            print(f"[runner] pass failed: {e}", flush=True)
            _mark_pass(False)
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
    args = ap.parse_args()

    # Start the health server in a daemon thread so it never blocks shutdown.
    threading.Thread(
        target=_serve_health, args=(args.port,), daemon=True
    ).start()

    # Block on the watch loop in the main thread so signals (SIGTERM from
    # Railway/Fly during deploys) tear down cleanly.
    try:
        _run_watch_loop(args.interval, args.live, args.user)
    except KeyboardInterrupt:
        print("[runner] stopped", flush=True)
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
