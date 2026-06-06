#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   IMAGE=ghcr.io/<org>/yolo-agent:<tag> sudo bash deploy-agent.sh
# Requires:
#   - /etc/yolo-agent/agent.env present
#   - docker + docker compose plugin installed

IMAGE="${IMAGE:-ghcr.io/REPLACE_ME/yolo-agent:latest}"
APP_DIR="/opt/yolo-agent"

if [[ ! -f /etc/yolo-agent/agent.env ]]; then
  echo "Missing /etc/yolo-agent/agent.env"
  exit 1
fi

mkdir -p "$APP_DIR"
cp docker-compose.agent.yml "$APP_DIR/docker-compose.agent.yml"
cp yolo-agent.service /etc/systemd/system/yolo-agent.service

# Pin image tag in the compose file.
sed -i "s|ghcr.io/REPLACE_ME/yolo-agent:latest|$IMAGE|g" "$APP_DIR/docker-compose.agent.yml"

systemctl daemon-reload
systemctl enable yolo-agent
systemctl restart yolo-agent
systemctl status yolo-agent --no-pager

echo "Deployed yolo-agent with image: $IMAGE"
