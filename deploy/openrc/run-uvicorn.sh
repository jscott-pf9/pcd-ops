#!/bin/sh
# Sources /etc/pcd-app/config.env then /opt/pcd-ops/.env, then execs uvicorn as
# the pcd-ops service user. Called by the OpenRC init script. The `exec` is
# required — without it, start-stop-daemon writes the shell's PID to the pidfile
# and `rc-service stop` cannot signal uvicorn.
#
# Precedence (lowest to highest): PCD App Catalog install-form values
# (config.env, written by cloud-init; never contains secrets), then .env, then
# anything saved on the Settings page (settings.json, applied in app/config.py).
set -a
# Either file may be missing (non-catalog deploys; first boot before cloud-init)
[ -f /etc/pcd-app/config.env ] && . /etc/pcd-app/config.env
[ -f /opt/pcd-ops/.env ] && . /opt/pcd-ops/.env
set +a

export PCD_OPS_DIR=/opt/pcd-ops
cd /opt/pcd-ops/backend
exec /opt/pcd-ops/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
