#!/usr/bin/env bash
# Self-update script — called by the backend when the user triggers an update
# from the Settings UI. Runs as the pcd-ops service user.
set -euo pipefail

APP_DIR="${PCD_OPS_DIR:-/opt/pcd-ops}"

echo "=== Pulling latest code ==="
git -C "$APP_DIR" pull

echo "=== Updating Python dependencies ==="
"$APP_DIR/backend/.venv/bin/pip" install -e "$APP_DIR/backend" -q

echo "=== Rebuilding frontend ==="
cd "$APP_DIR/frontend"
npm ci --prefer-offline -q
npm run build

echo "=== Restarting service ==="
# sudo is allowed via /etc/sudoers.d/pcd-ops (set up during provisioning)
sudo systemctl restart pcd-ops

echo "=== Done ==="
