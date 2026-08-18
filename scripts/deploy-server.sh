#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-mesh-splat-artifact-service}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cd "$APP_ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env. Create server-local configuration before deploying." >&2
  exit 1
fi

git pull --ff-only
npm ci
npm run db:generate
npm run db:seed
npm run build

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Mesh-Splat Artifact Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$APP_ROOT
EnvironmentFile=$APP_ROOT/.env
ExecStart=/usr/bin/node $APP_ROOT/dist/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=$APP_ROOT/data/assets

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager

echo "Deployed mesh-splat-artifact-service and restarted $SERVICE_NAME"
