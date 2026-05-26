# Multi-stage build for the agent runner.
# Why multi-stage: uv installs deps in a virtualenv; the runtime image only
# needs Python + that venv, not uv itself or the wheels cache. The final
# image is ~120MB instead of ~450MB.
#
# Build:
#   docker build -t yolo-agent -f agent/Dockerfile .
# Run (paper):
#   docker run --rm --env-file .env yolo-agent
# Run (live, watch mode):
#   docker run --rm --env-file .env yolo-agent uv run python loop.py --live --watch

# ── builder ────────────────────────────────────────────────────────────────
FROM python:3.13-slim AS builder

# uv is the package manager the project's pyproject is set up for (see
# agent/pyproject.toml + agent/uv.lock).
RUN pip install --no-cache-dir uv==0.8.6

WORKDIR /app
# Copy lock + manifest first so deps cache invalidates only on lockfile
# changes — code edits don't trigger a full reinstall.
COPY agent/pyproject.toml agent/uv.lock ./
RUN uv sync --frozen --no-dev

# ── runtime ────────────────────────────────────────────────────────────────
FROM python:3.13-slim AS runtime

# Build deps that some pure-Python libs need at runtime (e.g. curl_cffi
# bundles a vendored curl; psycopg-binary doesn't need libpq). Keep slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy the prebuilt virtualenv from the builder. uv installs into .venv/
# relative to the project root.
COPY --from=builder /app/.venv /app/.venv
COPY agent/ /app/

# Put the venv binaries on PATH so `python loop.py` resolves correctly
# without needing to prefix with `uv run`.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Health endpoint runs on $PORT (Railway/Fly/Render convention).
# Defaults to 8080 if the platform doesn't set one.
ENV PORT=8080
EXPOSE 8080

# Default: launch the watch-loop and the health endpoint side-by-side.
# The agent's --watch flag uses an in-process scheduler so this is a
# single Python process; the health endpoint runs in a thread inside
# the same process via runner.py.
CMD ["python", "runner.py"]
