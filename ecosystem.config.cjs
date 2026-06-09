const nodeBin = "/root/.nvm/versions/node/v20.20.2/bin";

module.exports = {
  apps: [
    {
      name: "yolo-fast-markets",
      cwd: "/root/yolomarkets/web",
      script: "npm",
      args: "run markets:fast:keeper",
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_ENV: "production",
        FAST_MARKET_POLL_SECONDS: "120",
      },
    },
    {
      name: "yolo-agent",
      cwd: "/root/yolomarkets/agent",
      script: "/root/.local/bin/uv",
      args: "run python runner.py --port 8080",
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        PATH: `${nodeBin}:/root/.local/bin:${process.env.PATH}`,
        PORT: "8080",
        RUNNER_LIVE: "1",
        RUNNER_INTERVAL_SECONDS: "180",
        RUNNER_MAX_CONSECUTIVE_FAILURES: "5",
      },
    },
  ],
};
