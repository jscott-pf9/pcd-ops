#!/bin/sh
# PCD Ops' metrics store: VictoriaMetrics single-node, listening on localhost only. It scrapes
# node-exporter and libvirt-exporter on every hypervisor. PCD Ops writes its scrape config,
# targets and retention into the state dir (backend/app/services/local_metrics.py); the scrape
# config is re-read every 30 s, and a retention change restarts this service. Called by the
# OpenRC init script; the `exec` keeps the pidfile pointing at VictoriaMetrics.
STATE=/var/lib/pcd-ops

# metrics.env holds METRICS_RETENTION=<days>d. Parse it rather than sourcing it.
RETENTION=$(sed -n 's/^METRICS_RETENTION=\([0-9][0-9]*d\)$/\1/p' "$STATE/metrics.env" 2>/dev/null)
# Until PCD Ops has written a scrape config, scrape nothing.
[ -f "$STATE/scrape.yml" ] || echo '{"scrape_configs": []}' > "$STATE/scrape.yml"

exec /opt/victoria-metrics/victoria-metrics-prod \
  -httpListenAddr=127.0.0.1:8428 \
  -storageDataPath="$STATE/metrics" \
  -retentionPeriod="${RETENTION:-90d}" \
  -promscrape.config="$STATE/scrape.yml" \
  -promscrape.configCheckInterval=30s \
  -storage.minFreeDiskSpaceBytes=2GB \
  -memory.allowedPercent=20
