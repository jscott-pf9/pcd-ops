#!/bin/sh
# PCD Ops HTTPS (APPLIANCE_STANDARD §7.9, §7.10). Runs as root.
#
#   tls.sh ensure       a self-signed certificate if there's none (OpenRC pcd-ops-tls, before
#                       nginx at boot)
#   tls.sh regenerate   a new self-signed certificate for this appliance's names, then reload
#                       nginx (console)
#   tls.sh show         the certificate in use
#   tls.sh enable       set up HTTPS on an appliance built before it: install nginx's HTTPS
#                       config and the boot service, make the certificate, reload nginx (console)
#
# The certificate work is the app's own (backend/app/appliance/tls.py), run as pcd-ops so the
# files in /var/lib/pcd-ops/tls stay the app's.
set -eu

APP_DIR="${PCD_OPS_DIR:-/opt/pcd-ops}"
STATE="/var/lib/pcd-ops"
NGINX_CONF="/etc/nginx/http.d/pcd-ops.conf"

as_app() {
  su -s /bin/sh pcd-ops -c "cd '$APP_DIR/backend' && PCD_OPS_STATE_DIR='$STATE' .venv/bin/python -m app.appliance.tls $1"
}

prepare_dirs() {
  mkdir -p "$STATE"
  chown pcd-ops:pcd-ops "$STATE"
  chmod 0700 "$STATE"
}

case "${1:-}" in
  ensure)
    prepare_dirs
    if ! as_app ensure; then
      # nginx won't start without a certificate, so never leave it without one
      echo "The app couldn't make the certificate; making one with openssl." >&2
      mkdir -p "$STATE/tls"
      if [ ! -s "$STATE/tls/cert.pem" ] || [ ! -s "$STATE/tls/key.pem" ]; then
        name=$(hostname)
        ip=$(ip -o -4 addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')
        openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=$name/O=PCD Ops" \
          -addext "subjectAltName=DNS:$name${ip:+,IP:$ip}" \
          -keyout "$STATE/tls/key.pem" -out "$STATE/tls/cert.pem" 2>/dev/null
      fi
      [ -f "$STATE/tls/http.conf" ] || printf 'location / {\n    return 301 https://$host$request_uri;\n}\n' > "$STATE/tls/http.conf"
      chown -R pcd-ops:pcd-ops "$STATE/tls"
      chmod 0700 "$STATE/tls"
      chmod 0600 "$STATE/tls"/*
    fi
    ;;
  regenerate)
    prepare_dirs
    as_app regenerate
    nginx -s reload
    ;;
  show)
    as_app show
    ;;
  enable)
    prepare_dirs
    as_app ensure
    if [ -f "$NGINX_CONF" ] && grep -q "listen 443" "$NGINX_CONF"; then
      echo "HTTPS is already set up."
    else
      [ -f "$NGINX_CONF" ] && cp "$NGINX_CONF" "$NGINX_CONF.pre-https"
      cp "$APP_DIR/deploy/nginx/pcd-ops.conf" "$NGINX_CONF"
      if ! nginx -t 2>&1; then
        echo "nginx rejected the HTTPS configuration; putting the old one back." >&2
        [ -f "$NGINX_CONF.pre-https" ] && cp "$NGINX_CONF.pre-https" "$NGINX_CONF"
        exit 1
      fi
    fi
    cp "$APP_DIR/deploy/openrc/pcd-ops-tls" /etc/init.d/pcd-ops-tls
    chmod 755 /etc/init.d/pcd-ops-tls "$APP_DIR/deploy/scripts/tls.sh"
    rc-update add pcd-ops-tls default >/dev/null 2>&1 || true
    nginx -s reload
    echo "HTTPS is on (port 443). Plain HTTP redirects to it; Settings → HTTPS can change that."
    echo "Allow TCP 443 in this VM's security group in PCD if it isn't already."
    ;;
  *)
    echo "usage: $0 ensure|regenerate|show|enable" >&2
    exit 2
    ;;
esac
