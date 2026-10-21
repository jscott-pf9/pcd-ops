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
  nodejs npm gum

echo "=== Installing GRUB for legacy BIOS boot ==="
# The Alpine UEFI cloud image ships GRUB for UEFI only (grubx64.efi) and has
# zeroed MBR boot code, so it won't boot when PCD launches it with SeaBIOS
# (the default, or when the hypervisor has no OVMF). Add a bios_grub partition
# in the free gap before the ESP (sectors 40-1023) and install the i386-pc
# target too, giving a hybrid BIOS+UEFI disk like the Ubuntu cloud images.
# grub.cfg is platform-agnostic, so both loaders share it.
ROOT_PART=$(awk '$2 == "/" { print $1 }' /proc/mounts)
ROOT_DISK=$(echo "$ROOT_PART" | sed 's/[0-9]*$//')
apk add --no-cache grub-bios sgdisk
sgdisk -a 1 -n 3:40:1023 -t 3:EF02 -c 3:BIOS "$ROOT_DISK"
grub-install --target=i386-pc --boot-directory=/boot "$ROOT_DISK"
apk del sgdisk

echo "=== Creating pcd-ops service user ==="
# Create group first; busybox adduser -S does not auto-create a matching group.
addgroup -S pcd-ops
# -S = system user (uid < 1000), -D = no password, -h = home dir, -s = login shell
adduser -S -D -h "$APP_DIR" -s /sbin/nologin -G pcd-ops pcd-ops

echo "=== Cloning repository ==="
git clone --branch "${GITHUB_BRANCH:-main}" "$GITHUB_REPO" "$APP_DIR"
chown -R pcd-ops:pcd-ops "$APP_DIR"

echo "=== Setting up Python virtual environment ==="
su -s /bin/sh pcd-ops -c "python3 -m venv $APP_DIR/backend/.venv"
su -s /bin/sh pcd-ops -c "$APP_DIR/backend/.venv/bin/pip install -e $APP_DIR/backend -q"
apk del gcc musl-dev python3-dev libffi-dev openssl-dev

echo "=== Building frontend ==="
su -s /bin/sh pcd-ops -c "cd $APP_DIR/frontend && npm ci -q && npm run build"
rm -rf "$APP_DIR/frontend/node_modules"
su -s /bin/sh pcd-ops -c "npm cache clean --force 2>/dev/null || true"

echo "=== Creating state directory ==="
# Per-install secrets (Fernet key, encrypted application credential) live here, created at
# first use — never in the image (APPLIANCE_STANDARD §7.5).
install -d -m 0700 -o pcd-ops -g pcd-ops /var/lib/pcd-ops

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
chmod +x "$APP_DIR/deploy/scripts/appliance-console-gum.sh"
chmod +x "$APP_DIR/deploy/scripts/reset-setup.sh"
printf 'pcd-ops ALL=(ALL) NOPASSWD: /sbin/rc-service pcd-ops restart\n' > /etc/sudoers.d/pcd-ops
printf 'pcd-ops ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload\n'        >> /etc/sudoers.d/pcd-ops
printf 'pcd-ops ALL=(ALL) NOPASSWD: /sbin/reboot\n'                     >> /etc/sudoers.d/pcd-ops
chmod 440 /etc/sudoers.d/pcd-ops

echo "=== Configuring appliance console on tty1 ==="
# Replace the standard getty on tty1 with the appliance TUI.
# 'respawn' means init restarts the script after it exits (e.g. after login shell).
sed -i "s|tty1::respawn:.*|tty1::respawn:$APP_DIR/deploy/scripts/appliance-console-gum.sh|" /etc/inittab

echo "=== Writing empty .env template ==="
# Every assignment is commented out: run-uvicorn.sh sources this AFTER the
# catalog's /etc/pcd-app/config.env, so a live KEY=value here would clobber it.
su -s /bin/sh pcd-ops -c "sed 's/^\([A-Z_][A-Z0-9_]*=\)/# \1/' $APP_DIR/.env.example > $APP_DIR/.env"

echo "=== Removing sshd (management is via TUI console, not SSH) ==="
apk del openssh 2>/dev/null || true

echo "=== Writing version file ==="
echo "${PCD_OPS_VERSION:-unknown}" > "$APP_DIR/version"
chown pcd-ops:pcd-ops "$APP_DIR/version"

echo "=== Fixing cloud-init datasource_list ==="
# Alpine 3.21's stock cloud.cfg repeats datasource_list and the last one
# ("NoCloud" only) wins, so on Nova cloud-init never reads the config drive and
# user-data (incl. the catalog's /etc/pcd-app/config.env) is ignored. A drop-in
# restores the OpenStack sources. Written now, so this Packer build (NoCloud
# seed) is unaffected; it applies from the image's first real boot.
cat > /etc/cloud/cloud.cfg.d/99_pcd_datasource.cfg <<'CLOUDCFG'
datasource_list: ['ConfigDrive', 'OpenStack', 'NoCloud', 'None']
CLOUDCFG
# Forget the Packer build's NoCloud instance so first boot starts clean.
cloud-init clean --logs

echo "=== Cleaning up ==="
rm -rf /var/cache/apk/*
# pip cache lives under pcd-ops HOME ($APP_DIR) — biggest single space consumer
rm -rf "$APP_DIR/.cache"
rm -rf /root/.cache
# npm caches
rm -rf /root/.npm /home/pcd-ops/.npm
# Python bytecode — regenerated on first run, saves ~30-50 MB
find "$APP_DIR/backend/.venv" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$APP_DIR/backend" -name "*.pyc" -delete 2>/dev/null || true
# Strip debug symbols from compiled extensions (~10-20 MB)
find "$APP_DIR/backend/.venv" -name "*.so" -exec strip --strip-debug {} \; 2>/dev/null || true
rm -rf /tmp/*

echo "=== Checking that no credentials are baked in ==="
# Only tracked files are cloned, so creds/ (gitignored) never gets here; fail loudly if that
# changes, or if any file carries an OpenStack password (an rc file, a filled-in .env).
if [ -e "$APP_DIR/creds" ] || [ -n "$(ls -A /var/lib/pcd-ops)" ]; then
  echo "ERROR: credentials or per-install state found in the image" >&2
  exit 1
fi
if grep -rIlE '^[[:space:]]*(export[[:space:]]+)?OS_PASSWORD=[^[:space:]]' "$APP_DIR" \
     --exclude-dir=.git --exclude-dir=.venv --exclude-dir=node_modules; then
  echo "ERROR: the files above contain an OpenStack password" >&2
  exit 1
fi

passwd -l alpine

echo "=== Provisioning complete ==="
