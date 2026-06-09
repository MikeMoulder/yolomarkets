# Deploying the agent runner

The agent's watch loop must stay live during the judging window. The
runner is packaged as a single container (`agent/Dockerfile`) that runs
the loop in the foreground and exposes a health endpoint on `$PORT`.

## Environment variables (required)

Copy these from your local `.env`:

```
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
USDC_ADDRESS=0x3600000000000000000000000000000000000000
DATABASE_URL=postgres://…           # Neon or your hosted PG
AGENT_SESSION_PRIVATE_KEY=…         # session signer, must hold a sprinkle of USDC for gas
OPENROUTER_API_KEY=sk-or-v1-…       # turns on the agent brain (orchestrator + web search)
BRAIN_MODEL=anthropic/claude-sonnet-4.6   # optional; orchestrator model slug (OpenRouter)
BRAIN_SEARCH_MODEL=perplexity/sonar       # optional; web-search delegate
```

Optional:

```
RUNNER_INTERVAL_SECONDS=60          # gap between watch passes
RUNNER_LIVE=1                       # 0 to force paper-only mode
RUNNER_USER=0x…                     # only run for this address
RUNNER_MAX_CONSECUTIVE_FAILURES=5   # runner exits after N failed passes so Railway restarts it
```

## Railway (recommended for the hackathon)

```sh
# From the repo root
railway login
railway init
railway link
railway up --service yolo-agent --detach \
    --dockerfile agent/Dockerfile
# Then add the env vars in Railway's web UI under Variables.
```

Railway sets `$PORT` automatically; the runner picks it up.

## Fly.io

```sh
fly launch --dockerfile agent/Dockerfile --name yolo-agent
# Edit fly.toml: set [build] dockerfile = "agent/Dockerfile", expose
# internal_port = 8080, and configure secrets via:
fly secrets set OPENROUTER_API_KEY=… DATABASE_URL=… AGENT_SESSION_PRIVATE_KEY=…
fly deploy
```

## Render

1. Create a new **Web Service** → "Docker" type → repo connected.
2. Dockerfile path: `agent/Dockerfile`. Docker context: `.` (repo root).
3. Health Check Path: `/healthz`.
4. Add env vars under "Environment".

## VPS (Ubuntu + Docker + systemd)

If your Railway runtime is unstable, run the same agent container on a VPS
and supervise it with systemd + Docker Compose.

### 1) Provision host packages

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Docker Engine + Compose plugin (official repo)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

### 2) Copy deployment assets

Copy these files from this repo to your VPS home folder:

- `scripts/vps/docker-compose.agent.yml`
- `scripts/vps/yolo-agent.service`
- `scripts/vps/deploy-agent.sh`

### 3) Create runtime env on VPS

```sh
sudo mkdir -p /etc/yolo-agent
sudo cp scripts/vps/agent.env.example /etc/yolo-agent/agent.env
sudo chmod 600 /etc/yolo-agent/agent.env
sudo nano /etc/yolo-agent/agent.env
```

Fill real values for `DATABASE_URL`, `OPENROUTER_API_KEY`, and
`AGENT_SESSION_PRIVATE_KEY`.

### 4) Build and publish image

From your local machine (repo root):

```sh
docker build -t ghcr.io/<org>/yolo-agent:<tag> -f agent/Dockerfile .
docker push ghcr.io/<org>/yolo-agent:<tag>
```

### 5) Deploy and enable service

On VPS, from folder containing the copied files:

```sh
chmod +x deploy-agent.sh
sudo IMAGE=ghcr.io/<org>/yolo-agent:<tag> ./deploy-agent.sh
```

### 6) Validate

```sh
curl -sS http://127.0.0.1:8080/healthz | jq
sudo journalctl -u yolo-agent -n 100 --no-pager
sudo docker ps
```

### 7) Put behind HTTPS (recommended)

Terminate TLS with Caddy or Nginx and reverse proxy to `127.0.0.1:8080`.
Keep the container port bound to localhost only, as in
`scripts/vps/docker-compose.agent.yml`.

## Smoke-testing the container locally

```sh
docker build -t yolo-agent -f agent/Dockerfile .
docker run --rm -p 8080:8080 --env-file .env yolo-agent

# In another shell:
curl http://localhost:8080/healthz | jq
# {
#   "ok": true,
#   "started_at": "2026-05-25T22:14:00+00:00",
#   "last_pass_at": "2026-05-25T22:15:01+00:00",
#   "last_pass_ok": true,
#   "passes_total": 1,
#   "passes_failed": 0
# }
```

## Showing the status in the web app

Once deployed, set `NEXT_PUBLIC_AGENT_HEALTH_URL=https://yolo-agent.up.railway.app/healthz`
in `web/.env.local`. A small footer component can fetch this every 30s
and render "agent · last pass 47s ago" — judges see at a glance that
the runner is live. (Footer component: TODO; data is there as soon as
the URL is set.)
