"""Host and VM metrics: the local store's status, and history for one hypervisor or VM."""
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, HTTPException

from app.config import settings
from app.services import local_metrics, metrics_catalog
from app.services.db import cache_get
from app.services.prometheus import MetricsNotConfigured

router = APIRouter(prefix="/metrics", tags=["metrics"])

RANGES = {"24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365, "2y": 730}
POINTS = 150   # per series, whatever the range
HOST_SERIES = ["cpu_pct", "mem_pct", "disk_pct", "disk_read_bps", "disk_write_bps",
               "net_rx_bps", "net_tx_bps"]
VM_SERIES = ["cpu_pct", "mem_pct", "net_rx_bps", "net_tx_bps", "disk_iops", "disk_latency_ms",
             "cpu_wait_pct"]
STORAGE_SERIES = ["total_bytes", "used_bytes", "provisioned_bytes"]


@router.get("/status")
async def status():
    """PCD Ops' own metrics store (running, targets, disk, projected size) and which source
    the host and VM views use: "local", "pcd" (PCD's Grafana, 14 days) or null."""
    src = await metrics_catalog.source()
    return {"source": src, "retention_days": metrics_catalog.retention_days(src) if src else None,
            "local": await local_metrics.status()}


async def _source() -> str:
    src = await metrics_catalog.source()
    if src is None:
        raise HTTPException(503, detail={
            "code": "metrics_not_configured",
            "error": "No metrics yet: PCD Ops' metrics store has no data and no Grafana token "
                     "is set (Settings → Metrics, Settings → Connection)."})
    return src


async def _history(group: str, src: str, selector: str, metrics: list[str], range_: str) -> dict:
    if range_ not in RANGES:
        raise HTTPException(400, detail=f"range must be one of {', '.join(RANGES)}")
    days = min(RANGES[range_], metrics_catalog.retention_days(src))
    end = datetime.utcnow()
    start = end - timedelta(days=days)
    step = f"{max(60, int(days * 86400 / POINTS))}s"
    try:
        series = await metrics_catalog.series(group, src, selector, metrics, start, end, step)
    except (httpx.HTTPError, MetricsNotConfigured) as e:
        raise HTTPException(502, detail=f"Couldn't query {src} metrics: {e}") from None
    return {"source": src, "range": range_, "days": days, "step": step, "series": series}


@router.get("/hosts/{hypervisor_id}")
async def host_history(hypervisor_id: str, range: str = "24h"):  # noqa: A002 (query name)
    """CPU, memory, disk and network history for one hypervisor. `range` is clamped to what
    the source keeps."""
    src = await _source()
    hyps, _ = cache_get("inventory:hypervisors")
    hyp = next((h for h in hyps or [] if h["id"] == hypervisor_id), None)
    if hyp is None:
        raise HTTPException(404, detail="No such hypervisor")
    selector = metrics_catalog.host_selector(src, hyp)
    if selector is None:
        raise HTTPException(404, detail="PCD's metrics don't identify this hypervisor")
    return await _history("host", src, selector, HOST_SERIES, range)


@router.get("/vms/{server_id}")
async def vm_history(server_id: str, range: str = "24h"):  # noqa: A002
    """CPU, memory, network, disk and CPU-wait history for one VM."""
    src = await _source()
    return await _history("vm", src, f'domain="{server_id}"', VM_SERIES, range)


@router.get("/storage/{backend}")
async def storage_history(backend: str, range: str = "24h"):  # noqa: A002
    """Capacity, used and provisioned history for one Cinder backend. Only PCD Ops' own store
    keeps it (written each inventory run), so this is 503 without it."""
    if not (local_metrics.available() and settings.metrics_local_enabled):
        raise HTTPException(503, detail={
            "code": "metrics_not_configured",
            "error": "Storage history is kept by PCD Ops' metrics store, which isn't running "
                     "here (Settings → Metrics)."})
    name = backend.replace("\\", "\\\\").replace('"', '\\"')
    return await _history("storage", "local", f'backend="{name}"', STORAGE_SERIES, range)
