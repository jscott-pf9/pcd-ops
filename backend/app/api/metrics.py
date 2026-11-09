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
HOST_SERIES = ["cpu_pct", "mem_pct", "mem_incl_cache_pct", "swap_used_pct", "swap_in_pps",
               "swap_out_pps", "oom_kills", "hugepages_used_pct", "disk_pct", "disk_read_bps",
               "disk_write_bps", "net_rx_bps", "net_tx_bps"]
VM_SERIES = ["cpu_pct", "mem_pct", "mem_incl_cache_pct", "mem_total_bytes", "mem_available_bytes",
             "mem_used_bytes", "mem_cache_bytes", "major_faults_ps", "net_rx_bps", "net_tx_bps",
             "disk_iops", "disk_latency_ms", "cpu_wait_pct"]
STORAGE_SERIES = ["total_bytes", "used_bytes", "provisioned_bytes", "read_bps", "write_bps", "iops",
                  "latency_ms"]
CLUSTER_SERIES = HOST_SERIES
CLUSTER_ALLOC_SERIES = ["vcpu_alloc_pct", "mem_alloc_pct", "vms"]
VOLUME_SERIES = ["read_bps", "write_bps", "read_iops", "write_iops", "latency_ms",
                 "allocated_bytes", "capacity_bytes"]


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


async def _history(group: str, src: str, selector: str, metrics: list[str], range_: str,
                   extra: tuple[str, str, list[str]] | None = None) -> dict:
    """`extra`: another group from the local store (group, selector, metrics) over the same
    times, such as a cluster's allocation next to its hosts' metrics."""
    if range_ not in RANGES:
        raise HTTPException(400, detail=f"range must be one of {', '.join(RANGES)}")
    days = min(RANGES[range_], metrics_catalog.retention_days(src))
    end = datetime.utcnow()
    start = end - timedelta(days=days)
    step = f"{max(60, int(days * 86400 / POINTS))}s"
    try:
        series = await metrics_catalog.series(group, src, selector, metrics, start, end, step)
        if extra:
            group, sel, names = extra
            series |= await metrics_catalog.series(group, "local", sel, names, start, end, step)
    except (httpx.HTTPError, MetricsNotConfigured) as e:
        raise HTTPException(502, detail=f"Couldn't query {src} metrics: {e}") from None
    return {"source": src, "range": range_, "days": days, "step": step, "series": series}


def _local_store() -> bool:
    return local_metrics.available() and settings.metrics_local_enabled


def _quote(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


@router.get("/hosts/{hypervisor_id}")
async def host_history(hypervisor_id: str, range: str = "24h"):  # noqa: A002 (query name)
    """CPU, memory (used, with cache, swap, swapping, OOM kills, hugepages), disk and network
    history for one hypervisor. `range` is clamped to what the source keeps."""
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
    """CPU, memory (in use, with disk cache, bytes, major page faults), network, disk and
    CPU-wait history for one VM."""
    src = await _source()
    return await _history("vm", src, f'domain="{server_id}"', VM_SERIES, range)


@router.get("/storage/{backend}")
async def storage_history(backend: str, range: str = "24h"):  # noqa: A002
    """Capacity, used and provisioned history for one Cinder backend. Only PCD Ops' own store
    keeps it (written each inventory run), so this is 503 without it."""
    if not _local_store():
        raise HTTPException(503, detail={
            "code": "metrics_not_configured",
            "error": "Storage history is kept by PCD Ops' metrics store, which isn't running "
                     "here (Settings → Metrics)."})
    return await _history("storage", "local", f'backend="{_quote(backend)}"', STORAGE_SERIES, range)


@router.get("/clusters/{aggregate_id}")
async def cluster_history(aggregate_id: str, range: str = "24h"):  # noqa: A002
    """CPU, memory, disk and network over a cluster's (host aggregate's) hosts, and its vCPU,
    RAM and VM allocation over time (PCD Ops' metrics store only)."""
    src = await _source()
    aggs, _ = cache_get("inventory:clusters")
    agg = next((a for a in aggs or [] if str(a["id"]) == aggregate_id), None)
    if agg is None:
        raise HTTPException(404, detail="No such aggregate")
    hyps, _ = cache_get("inventory:hypervisors")
    ids = {h["hypervisor_id"] for h in agg["hosts"]}
    selector = metrics_catalog.cluster_selector(src, [h for h in hyps or [] if h["id"] in ids])
    if selector is None:
        raise HTTPException(404, detail="This aggregate has no hosts the metrics can name")
    extra = (("cluster_alloc", f'aggregate="{_quote(aggregate_id)}"', CLUSTER_ALLOC_SERIES)
             if _local_store() else None)
    return await _history("cluster", src, selector, CLUSTER_SERIES, range, extra)


@router.get("/volumes/{volume_id}")
async def volume_history(volume_id: str, range: str = "24h"):  # noqa: A002
    """Throughput, IOPS, latency and allocation for one volume: libvirt's stats for the VM disk
    it is attached as (PCD Ops' metrics store only; 404 when it isn't attached)."""
    if not _local_store():
        raise HTTPException(503, detail={
            "code": "metrics_not_configured",
            "error": "Volume metrics come from PCD Ops' metrics store, which isn't running here "
                     "(Settings → Metrics)."})
    vols, _ = cache_get("inventory:volumes")
    vol = next((v for v in vols or [] if v["id"] == volume_id), None)
    if vol is None:
        raise HTTPException(404, detail="No such volume")
    att = next((a for a in vol.get("attachments") or []
                if a.get("server_id") and a.get("device")), None)
    if att is None:
        raise HTTPException(404, detail={
            "code": "not_attached", "error": "Not attached to a VM, so there's no I/O to show."})
    dev = att["device"].rsplit("/", 1)[-1]
    selector = f'domain="{_quote(att["server_id"])}",target_device="{_quote(dev)}"'
    return await _history("volume", "local", selector, VOLUME_SERIES, range)
