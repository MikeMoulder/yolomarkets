const nodeBin = "/root/.nvm/versions/node/v20.20.2/bin";

module.exports = {
  // NOTE: the web frontend runs on Vercel (production), not here. This VPS only
  // runs the background workers below. (yolo-web dev server removed 2026-07-21 —
  // it OOM-crash-looped on this box and served no users.)
  apps: [
    {
      name: "yolo-catalog-indexer",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run markets:catalog:indexer",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-catalog-indexer-out.log",
      error_file: "/root/yolomarkets/logs/yolo-catalog-indexer-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        CATALOG_INDEXER_POLL_SECONDS: "20",
      },
    },
    {
      name: "yolo-fast-markets",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run markets:fast:keeper",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-fast-markets-out.log",
      error_file: "/root/yolomarkets/logs/yolo-fast-markets-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        FAST_MARKET_POLL_SECONDS: "30",
      },
    },
    {
      name: "yolo-polymarket-resolver",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run markets:poly:resolver",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-polymarket-resolver-out.log",
      error_file: "/root/yolomarkets/logs/yolo-polymarket-resolver-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        POLYMARKET_RESOLUTION_POLL_SECONDS: "300",
      },
    },
    {
      name: "yolo-fast-swarm",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run markets:fast:swarm",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-fast-swarm-out.log",
      error_file: "/root/yolomarkets/logs/yolo-fast-swarm-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        FAST_SWARM_LIVE: "1",
        FAST_SWARM_POLL_SECONDS: "20",
      },
    },
    {
      // Telegram admin command center (/create …). Long-polls getUpdates, so it
      // owns the bot exclusively — the Vercel webhook is deleted on boot.
      // Lives here rather than on Vercel because market creation must outlive a
      // serverless response, and the root .env holds the real factory-admin key.
      name: "yolo-telegram-bot",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run telegram:bot -- --drop-pending",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-telegram-bot-out.log",
      error_file: "/root/yolomarkets/logs/yolo-telegram-bot-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        TELEGRAM_POLL_SECONDS: "30",
      },
    },
    {
      name: "yolo-agent",
      cwd: "/root/yolomarkets/agent",
      script: "/root/.local/bin/uv",
      args: "run python runner.py --port 8080",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-agent-out.log",
      error_file: "/root/yolomarkets/logs/yolo-agent-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:/root/.local/bin:${process.env.PATH}`,
        PORT: "8080",
        PYTHONUNBUFFERED: "1",
        RUNNER_LIVE: "1",
        RUNNER_INTERVAL_SECONDS: "180",
        RUNNER_MAX_CONSECUTIVE_FAILURES: "5",
      },
    },
    {
      // Circle Nanopayments bridge. Holds the payer EOA and signs EIP-3009
      // authorizations so the Python agent can buy x402 services (the SDK is
      // TypeScript-only, and SCA wallets cannot sign nanopayments).
      // Bound to 127.0.0.1 — never expose this; it can spend.
      // NOTE: needs a funded Gateway balance before it can pay anything.
      name: "yolo-nanopay",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run nanopay:service",
      interpreter: "none",
      out_file: "/root/yolomarkets/logs/yolo-nanopay-out.log",
      error_file: "/root/yolomarkets/logs/yolo-nanopay-error.log",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        NANOPAY_PORT: "8090",
      },
    },
  ],
};
