#!/usr/bin/env bash
# Runs as root inside the Packer QEMU VM to bake the full pcd-ops stack
# into the image. Executed via: sudo bash -c '{{ .Vars }} {{ .Path }}'
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-https://github.com/your-org/pcd-ops.git}"
APP_DIR="/opt/pcd-ops"

echo "=== Installing system packages ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq nginx git python3-venv python3-pip curl

# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -yq nodejs

echo "=== Creating pcd-ops service user ==="
useradd -r -m -d "$APP_DIR" -s /bin/bash pcd-ops

echo "=== Cloning repository ==="
git clone "$GITHUB_REPO" "$APP_DIR"
chown -R pcd-ops:pcd-ops "$APP_DIR"

echo "=== Setting up Python environment ==="
sudo -u pcd-ops python3 -m venv "$APP_DIR/backend/.venv"
sudo -u pcd-ops "$APP_DIR/backend/.venv/bin/pip" install -e "$APP_DIR/backend" -q

echo "=== Building frontend ==="
sudo -u pcd-ops bash -c "cd $APP_DIR/frontend && npm ci -q && npm run build"

echo "=== Installing systemd service ==="
cp "$APP_DIR/deploy/systemd/pcd-ops.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable pcd-ops

echo "=== Installing nginx config ==="
cp "$APP_DIR/deploy/nginx/pcd-ops.conf" /etc/nginx/sites-available/pcd-ops.conf
ln -sf /etc/nginx/sites-available/pcd-ops.conf /etc/nginx/sites-enabled/pcd-ops.conf
rm -f /etc/nginx/sites-enabled/default
systemctl enable nginx

echo "=== Configuring sudo for self-update ==="
chmod +x "$APP_DIR/deploy/scripts/update.sh"
echo "pcd-ops ALL=(ALL) NOPASSWD: /bin/systemctl restart pcd-ops" > /etc/sudoers.d/pcd-ops
chmod 440 /etc/sudoers.d/pcd-ops

echo "=== Writing empty .env template ==="
sudo -u pcd-ops cp "$APP_DIR/.env.example" "$APP_DIR/.env"

echo "=== Cleaning up ==="
apt-get clean
rm -rf /var/lib/apt/lists/*

# Lock the build-time ubuntu password — SSH key is the only way in on deployed VMs
passwd -l ubuntu

echo "=== Provisioning complete ==="
