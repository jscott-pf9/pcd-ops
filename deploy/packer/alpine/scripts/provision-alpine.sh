#!/bin/sh
# Runs as root inside the Packer QEMU VM to bake the full pcd-ops stack
# into an Alpine Linux image. Executed via: sudo sh -c '{{ .Vars }} {{ .Path }}'
set -eu

GITHUB_REPO="${GITHUB_REPO:-https://github.com/jscott-pf9/pcd-ops.git}"
APP_DIR="/opt/pcd-ops"

echo "=== Enabling community repository ==="
# Alpine cloud images may ship with the community repo disabled or absent.
# Node.js lives in community; enable it unconditionally.
ALPINE_VER=$(. /etc/os-release && echo "$VERSION_ID" | cut -d. -f1-2)
if grep -q '^#.*community' /etc/apk/repositories; then
  # Uncomment the community line
  sed -i 's|^#\(.*community\)|\1|' /etc/apk/repositories
elif ! grep -q 'community' /etc/apk/repositories; then
  # Add it if missing entirely
  echo "http://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/community" >> /etc/apk/repositories
fi

echo "=== Installing system packages ==="
apk update
apk add --no-cache \
  nginx git curl bash sudo \
  python3 py3-pip \
  gcc musl-dev python3-dev libffi-dev openssl-dev \
  nodejs npm

echo "=== Creating pcd-ops service user ==="
# Create group first; busybox adduser -S does not auto-create a matching group.
addgroup -S pcd-ops
# -S = system user (uid < 1000), -D = no password, -h = home dir, -s = login shell
adduser -S -D -h "$APP_DIR" -s /sbin/nologin -G pcd-ops pcd-ops

echo "=== Cloning repository ==="
git clone "$GITHUB_REPO" "$APP_DIR"
chown -R pcd-ops:pcd-ops "$APP_DIR"

echo "=== Setting up Python virtual environment ==="
su -s /bin/sh pcd-ops -c "python3 -m venv $APP_DIR/backend/.venv"
su -s /bin/sh pcd-ops -c "$APP_DIR/backend/.venv/bin/pip install -e $APP_DIR/backend -q"

echo "=== Building frontend ==="
su -s /bin/sh pcd-ops -c "cd $APP_DIR/frontend && npm ci -q && npm run build"

echo "=== Installing OpenRC init script ==="
cp "$APP_DIR/deploy/openrc/pcd-ops" /etc/init.d/pcd-ops
chmod 755 /etc/init.d/pcd-ops
rc-update add pcd-ops default

echo "=== Installing nginx config ==="
# Alpine nginx uses http.d/ not sites-available/sites-enabled
cp "$APP_DIR/deploy/nginx/pcd-ops.conf" /etc/nginx/http.d/pcd-ops.conf
rm -f /etc/nginx/http.d/default.conf
rc-update add nginx default

echo "=== Configuring sudo for self-update ==="
chmod +x "$APP_DIR/deploy/scripts/update.sh"
chmod +x "$APP_DIR/deploy/scripts/appliance-console.sh"
printf 'pcd-ops ALL=(ALL) NOPASSWD: /sbin/rc-service pcd-ops restart\n' > /etc/sudoers.d/pcd-ops
printf 'pcd-ops ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload\n'        >> /etc/sudoers.d/pcd-ops
printf 'pcd-ops ALL=(ALL) NOPASSWD: /sbin/reboot\n'                     >> /etc/sudoers.d/pcd-ops
chmod 440 /etc/sudoers.d/pcd-ops

echo "=== Configuring appliance console on tty1 ==="
# Replace the standard getty on tty1 with the appliance TUI.
# 'respawn' means init restarts the script after it exits (e.g. after login shell).
sed -i "s|tty1::respawn:.*|tty1::respawn:$APP_DIR/deploy/scripts/appliance-console.sh|" /etc/inittab

echo "=== Writing empty .env template ==="
su -s /bin/sh pcd-ops -c "cp $APP_DIR/.env.example $APP_DIR/.env"

echo "=== Cleaning up ==="
rm -rf /var/cache/apk/*

# Lock the build-time password — SSH key is the only way in on deployed VMs
passwd -l alpine

echo "=== Provisioning complete ==="
