"""PCD Ops' own metrics store.

VictoriaMetrics single-node runs on the appliance (OpenRC service pcd-ops-metrics, listening on
127.0.0.1:8428 only) and scrapes node-exporter and libvirt-exporter on every hypervisor. PCD's
Grafana keeps 14 days of a reduced set of these; this keeps everything PCD Ops uses, at full
resolution, for as long as Settings says.

PCD Ops writes three files in the state dir, which the service reads:
- scrape.yml: the scrape jobs. VictoriaMetrics re-reads it every 30 s.
- targets/node.json, targets/libvirt.json: one target per hypervisor, from the inventory. Each
  carries hypervisor_id, hypervisor and host_ip labels, so the data joins to Nova directly.
- metrics.env: flags that need a restart (retention).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx

from app.appliance import state
from app.config import settings
from app.services.exporters import EXPORTERS

logger = logging.getLogger(__name__)

URL = "http://127.0.0.1:8428"
SERVICE = "pcd-ops-metrics"
RETENTION_CHOICES = (30, 90, 180, 365, 730)
INTERVAL_CHOICES = ("30s", "60s")

# Series kept unless metrics_keep_all_series is on: what PCD Ops shows and analyses, without
# the per-unit systemd states, ~50 rarely used memory counters and the exporters' own metrics.
KEEP = {
    "node": (
        "node_cpu_seconds_total"
        "|node_memory_(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree"
        "|Hugepagesize)_bytes|node_memory_HugePages_(Total|Free)"
        "|node_filesystem_(size|avail)_bytes"
        "|node_disk_(read|written)_bytes_total|node_disk_(reads|writes)_completed_total"
        "|node_disk_io_time_seconds_total"
        "|node_network_(receive|transmit)_(bytes|packets|errs|drop)_total"
        "|node_load(1|5|15)|node_boot_time_seconds"
        "|node_vmstat_(pswpin|pswpout|pgmajfault|oom_kill)"
    ),
    "libvirt": (
        "libvirt_up|libvirt_domain_info_.*"
        "|libvirt_domain_block_stats_(read|write)_(bytes|requests|time_seconds)_total"
        "|libvirt_domain_block_stats_(capacity|physicalsize)_bytes|libvirt_domain_block_stats_allocation"
        "|libvirt_domain_interface_stats_(receive|transmit)_(bytes|packets|drops|errors)_total"
        "|libvirt_domain_memory_stats_.*"
        "|libvirt_domain_vcpu_(time|delay|wait)_seconds_total"
    ),
}


def available() -> bool:
    """True on an appliance that has the metrics service (not in local development)."""
    return Path(f"/etc/init.d/{SERVICE}").exists()


def _dir() -> Path:
    return state.state_dir()


def _write(path: Path, text: str) -> bool:
    """Atomic write; True if the content changed."""
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
    return True


def scrape_config() -> dict:
    """The scrape jobs: one per exporter, targets from files, the allowlist unless keep-all.
    None while local metrics are off; what was collected stays until retention removes it."""
    if not settings.metrics_local_enabled:
        return {"scrape_configs": []}
    interval = settings.metrics_scrape_interval
    if interval not in INTERVAL_CHOICES:
        interval = "60s"
    jobs = []
    for job in EXPORTERS:
        j = {
            "job_name": job,
            "scrape_interval": interval,
            "scrape_timeout": "10s",
            "file_sd_configs": [{"files": [str(_dir() / "targets" / f"{job}.json")]}],
        }
        if not settings.metrics_keep_all_series:
            j["metric_relabel_configs"] = [
                {"source_labels": ["__name__"], "regex": KEEP[job], "action": "keep"}]
        jobs.append(j)
    return {"global": {"scrape_interval": interval}, "scrape_configs": jobs}


def retention_days() -> int:
    d = settings.metrics_retention_days
    return d if d in RETENTION_CHOICES else 90


def write_config() -> bool:
    """Write scrape.yml and metrics.env. True if metrics.env changed (the service must restart
    to pick it up; scrape.yml changes apply by themselves)."""
    # JSON is valid YAML, so no YAML library is needed.
    _write(_dir() / "scrape.yml", json.dumps(scrape_config(), indent=2) + "\n")
    env = f"METRICS_RETENTION={retention_days()}d\n"
    return _write(_dir() / "metrics.env", env)


def write_targets(hypervisors: list[dict]) -> int:
    """One target per hypervisor that has an IP, labelled with its Nova identity. Returns how
    many. A hypervisor that is down stays listed, so its `up` series shows the outage."""
    hosts = [h for h in hypervisors if h.get("host_ip")]
    for job, port in EXPORTERS.items():
        groups = [{"targets": [f"{h['host_ip']}:{port}"],
                   "labels": {"hypervisor_id": str(h.get("id", "")),
                              "hypervisor": h.get("hostname") or "",
                              "host_ip": h["host_ip"]}} for h in hosts]
        _write(_dir() / "targets" / f"{job}.json", json.dumps(groups, indent=2) + "\n")
    return len(hosts)


def restart() -> None:
    """Restart the metrics service (sudo rule set up by the image)."""
    if not available():
        return
    rc = shutil.which("rc-service") or "/sbin/rc-service"
    subprocess.run(["sudo", "-n", rc, SERVICE, "restart"], check=True, capture_output=True,
                   timeout=60)


_restart_error: str | None = None


def apply_settings() -> None:
    """After a Settings change (and at startup): rewrite the config, and restart the store if
    retention changed. A failed restart is logged and shown on the status, not raised: the
    setting is saved either way and applies at the store's next start."""
    global _restart_error
    if not (write_config() and settings.metrics_local_enabled):
        return
    try:
        restart()
        _restart_error = None
    except (subprocess.SubprocessError, OSError) as e:
        detail = getattr(e, "stderr", b"") or b""
        _restart_error = f"{e} {detail.decode(errors='replace').strip()}".strip()[:300]
        logger.error("Couldn't restart the metrics store: %s", _restart_error)


def _label(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def exposition(samples: list[tuple[str, dict, float]], ts_ms: int) -> str:
    """Prometheus text lines: name{label="value",...} value timestamp_ms."""
    lines = []
    for name, labels, value in samples:
        lab = ",".join(f'{k}="{_label(v)}"' for k, v in sorted(labels.items()))
        lines.append(f"{name}{{{lab}}} {float(value)!r} {ts_ms}")
    return "\n".join(lines) + "\n"


async def push(samples: list[tuple[str, dict, float]]) -> bool:
    """Write samples PCD Ops computes itself (not scraped) into the store. Does nothing where
    there's no store, or it's turned off; failures are logged, never raised."""
    if not samples or not available() or not settings.metrics_local_enabled:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{URL}/api/v1/import/prometheus",
                                  content=exposition(samples, int(time.time() * 1000)))
            r.raise_for_status()
        return True
    except httpx.HTTPError as e:
        logger.warning("Couldn't write %d samples to the metrics store: %s", len(samples), e)
        return False


async def _get(path: str, **params) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{URL}{path}", params=params or None)
        r.raise_for_status()
        return r.json()


async def status() -> dict:
    """What the store is doing: running, targets up/down, disk, and the projected size for the
    chosen retention."""
    out: dict = {"available": available(), "enabled": settings.metrics_local_enabled,
                 "running": False, "retention_days": retention_days(),
                 "scrape_interval": settings.metrics_scrape_interval,
                 "keep_all_series": settings.metrics_keep_all_series, "targets": [],
                 "disk": _disk(), "restart_error": _restart_error}
    try:
        targets = await _get("/api/v1/targets")
        out["running"] = True
    except (httpx.HTTPError, ValueError):
        return out
    for t in (targets.get("data") or {}).get("activeTargets", []):
        labels = t.get("labels") or {}
        out["targets"].append({
            "job": labels.get("job"), "hypervisor": labels.get("hypervisor"),
            "hypervisor_id": labels.get("hypervisor_id"), "url": t.get("scrapeUrl"),
            "health": t.get("health"), "last_error": t.get("lastError") or None,
            "last_scrape": t.get("lastScrape")})
    try:
        stats = await _get("/api/v1/status/tsdb")
        out["series"] = (stats.get("data") or {}).get("totalSeries")
    except (httpx.HTTPError, ValueError):
        pass
    out.update(_growth())
    return out


def _disk() -> dict:
    data = _dir() / "metrics"
    used = sum(f.stat().st_size for f in data.rglob("*") if f.is_file()) if data.exists() else 0
    total, _, free = shutil.disk_usage(_dir())
    return {"used_bytes": used, "free_bytes": free, "total_bytes": total}


def collecting_since() -> float | None:
    """When the store started collecting (its data directory's creation), or None."""
    try:
        return (_dir() / "metrics").stat().st_ctime
    except OSError:
        return None


def _growth() -> dict:
    """Since when the store has collected, bytes per day since then, and what the chosen
    retention will need at that rate."""
    first = collecting_since()
    if not first:
        return {}
    days = (time.time() - first) / 86400
    if days < 1 / 24:   # under an hour: too little to extrapolate from
        return {"collecting_since": first}
    per_day = _disk()["used_bytes"] / days
    return {"collecting_since": first, "bytes_per_day": round(per_day),
            "projected_bytes": round(per_day * retention_days())}
