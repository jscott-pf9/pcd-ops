#!/usr/bin/env bash
# Self-update script — called by the backend when the user triggers an update
# from the Settings UI. Runs as the pcd-ops service user.
set -euo pipefail

APP_DIR="${PCD_OPS_DIR:-/opt/pcd-ops}"

echo "=== Pulling latest code ==="
git -C "$APP_DIR" pull

echo "=== Updating Python dependencies ==="
"$APP_DIR/backend/.venv/bin/pip" install -e "$APP_DIR/backend"

echo "=== Rebuilding frontend ==="
cd "$APP_DIR/frontend"
export CI=true
npm ci --prefer-offline
npm run build

echo "=== Reloading nginx config ==="
# Apply any nginx config changes from the updated repo (e.g. new cache headers).
# -s reload is a graceful reload — no dropped connections.
if command -v rc-service >/dev/null 2>&1; then
  sudo nginx -s reload 2>/dev/null || true
else
  sudo nginx -s reload 2>/dev/null || true
fi

echo "=== Restarting backend service ==="
# sudo is allowed via /etc/sudoers.d/pcd-ops (set up during provisioning).
# Detect init system: OpenRC on Alpine, systemd on Ubuntu/Debian.
if command -v rc-service >/dev/null 2>&1; then
  sudo rc-service pcd-ops restart
else
  sudo systemctl restart pcd-ops
fi

echo "=== Done ==="
