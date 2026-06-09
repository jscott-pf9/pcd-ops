#!/bin/sh
# Sources /opt/pcd-ops/.env then execs uvicorn as the pcd-ops service user.
# Called by the OpenRC init script. The `exec` is required — without it,
# start-stop-daemon writes the shell's PID to the pidfile and `rc-service stop`
# cannot signal uvicorn.
set -a
# Ignore if .env is missing (first boot before cloud-init writes credentials)
[ -f /opt/pcd-ops/.env ] && . /opt/pcd-ops/.env
set +a

export PCD_OPS_DIR=/opt/pcd-ops
cd /opt/pcd-ops/backend
exec /opt/pcd-ops/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
