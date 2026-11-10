"""Host and VM metrics, from whichever source has them.

Each metric is defined twice:
- local: raw node-exporter / libvirt-exporter series in PCD Ops' own store
  (services/local_metrics.py). Hosts are keyed by our `hypervisor_id` label (the Nova id).
- pcd: the reduced `pcd:*` series PCD remote-writes to its Grafana (14 days). Hosts are keyed
  by `host`, the PCD host UUID, which is Nova's compute service host (`service_host` in the
  inventory).

VMs are keyed by `domain`, the Nova server UUID, in both.

Templates carry SEL where label matchers go; series() puts a host or VM selector there, and
instant queries leave it empty.
"""
# ruff: noqa: E501  (PromQL reads best on one line)
from __future__ import annotations

import asyncio
import re
import time

import httpx

from app.config import settings
from app.services import local_metrics
from app.services.prometheus import MetricsNotConfigured, PrometheusClient, prometheus_client

R = "[5m]"
# Local disks only: NFS mounts are shared storage and would be counted once per host.
FS = 'fstype=~"xfs|ext[234]|btrfs|zfs",mountpoint!~"/boot.*"'
# Whole disks, not the device-mapper volumes on top of them.
DISK = 'device!~"dm-.*|loop.*|sr.*"'
# Physical NICs only: bonds, VLANs, OVS bridges, taps and vxlan carry the same traffic again.
NIC = 'device=~"en.*|eth.*|ib.*"'

HOST: dict[str, dict[str, str | None]] = {
    "cpu_pct": {
        "local": f'100 * (1 - avg by (hypervisor_id) (rate(node_cpu_seconds_total{{mode="idle",SEL}}{R})))',
        "pcd": "100 * sum by (host) (pcd:hyp_cpu_usage{SEL}) / sum by (host) (pcd:hyp_cpu_total{SEL})",
    },
    "cpu_cores": {
        "local": 'count by (hypervisor_id) (node_cpu_seconds_total{mode="idle",SEL})',
        "pcd": "sum by (host) (pcd:hyp_cpu_total{SEL})",
    },
    "mem_total_bytes": {
        "local": "sum by (hypervisor_id) (node_memory_MemTotal_bytes{SEL})",
        "pcd": "sum by (host) (pcd:hyp_mem_total{SEL})",
    },
    "mem_used_bytes": {
        "local": "sum by (hypervisor_id) (node_memory_MemTotal_bytes{SEL} - node_memory_MemAvailable_bytes{SEL})",
        "pcd": "sum by (host) (pcd:hyp_mem_usage{SEL})",
    },
    "mem_pct": {
        "local": "100 * (1 - sum by (hypervisor_id) (node_memory_MemAvailable_bytes{SEL}) / sum by (hypervisor_id) (node_memory_MemTotal_bytes{SEL}))",
        "pcd": "100 * sum by (host) (pcd:hyp_mem_usage{SEL}) / sum by (host) (pcd:hyp_mem_total{SEL})",
    },
    "disk_total_bytes": {
        "local": f"sum by (hypervisor_id) (node_filesystem_size_bytes{{{FS},SEL}})",
        "pcd": "sum by (host) (pcd:hyp_disk_space{SEL})",
    },
    "disk_used_bytes": {
        "local": f"sum by (hypervisor_id) (node_filesystem_size_bytes{{{FS},SEL}} - node_filesystem_avail_bytes{{{FS},SEL}})",
        "pcd": "sum by (host) (pcd:hyp_disk_usage{SEL})",
    },
    "disk_pct": {
        "local": f"100 * (1 - sum by (hypervisor_id) (node_filesystem_avail_bytes{{{FS},SEL}}) / sum by (hypervisor_id) (node_filesystem_size_bytes{{{FS},SEL}}))",
        "pcd": "100 * sum by (host) (pcd:hyp_disk_usage{SEL}) / sum by (host) (pcd:hyp_disk_space{SEL})",
    },
    "disk_read_bps": {
        "local": f"sum by (hypervisor_id) (rate(node_disk_read_bytes_total{{{DISK},SEL}}{R}))",
        "pcd": "sum by (host) (pcd:hyp_disk_read_throughput{SEL})",
    },
    "disk_write_bps": {
        "local": f"sum by (hypervisor_id) (rate(node_disk_written_bytes_total{{{DISK},SEL}}{R}))",
        "pcd": "sum by (host) (pcd:hyp_disk_write_throughput{SEL})",
    },
    "net_rx_bps": {
        "local": f"sum by (hypervisor_id) (rate(node_network_receive_bytes_total{{{NIC},SEL}}{R}))",
        "pcd": "sum by (host) (pcd:hyp_net_rx_throughput{SEL})",
    },
    "net_tx_bps": {
        "local": f"sum by (hypervisor_id) (rate(node_network_transmit_bytes_total{{{NIC},SEL}}{R}))",
        "pcd": "sum by (host) (pcd:hyp_net_tx_throughput{SEL})",
    },
    # Pages read back from swap per second: memory pressure, not just swap that sits there.
    "swap_in_pps": {
        "local": f"sum by (hypervisor_id) (rate(node_vmstat_pswpin{{SEL}}{R}))",
        "pcd": None,
    },
    "swap_out_pps": {
        "local": f"sum by (hypervisor_id) (rate(node_vmstat_pswpout{{SEL}}{R}))",
        "pcd": None,
    },
    # Memory not free, page cache included (mem_pct leaves out what the kernel can reclaim)
    "mem_incl_cache_pct": {
        "local": "100 * (1 - sum by (hypervisor_id) (node_memory_MemFree_bytes{SEL}) / sum by (hypervisor_id) (node_memory_MemTotal_bytes{SEL}))",
        "pcd": None,
    },
    # Hosts without swap have no series (SwapTotal 0 is filtered out), nor without hugepages
    "swap_used_pct": {
        "local": "100 * (1 - sum by (hypervisor_id) (node_memory_SwapFree_bytes{SEL}) / (sum by (hypervisor_id) (node_memory_SwapTotal_bytes{SEL}) > 0))",
        "pcd": None,
    },
    "hugepages_used_pct": {
        "local": "100 * (1 - sum by (hypervisor_id) (node_memory_HugePages_Free{SEL}) / (sum by (hypervisor_id) (node_memory_HugePages_Total{SEL}) > 0))",
        "pcd": None,
    },
    # Processes the kernel killed for want of memory, per hour
    "oom_kills": {
        "local": "sum by (hypervisor_id) (increase(node_vmstat_oom_kill{SEL}[1h]))",
        "pcd": None,
    },
}

VM: dict[str, dict[str, str | None]] = {
    "cpu_pct": {
        "local": f"100 * sum by (domain) (rate(libvirt_domain_info_cpu_time_seconds_total{{SEL}}{R})) / sum by (domain) (libvirt_domain_info_virtual_cpus{{SEL}})",
        "pcd": "100 * sum by (domain) (pcd:vm_cpu_usage{SEL}) / sum by (domain) (pcd:vm_cpu_total{SEL})",
    },
    # What the guest really uses: libvirt's used % leaves out disk cache, which the guest gives
    # back on demand. PCD's figure counts that cache as used, so it reads higher (a caching VM
    # looks full); right-sizing doesn't call that memory pressure (services/rightsizing.py).
    "mem_pct": {
        "local": "max by (domain) (libvirt_domain_memory_stats_used_percent{SEL})",
        "pcd": "100 * sum by (domain) (pcd:vm_mem_usage{SEL}) / sum by (domain) (pcd:vm_mem_total{SEL})",
    },
    # Memory not free in the guest, its disk cache included
    "mem_incl_cache_pct": {
        "local": "100 * (1 - max by (domain) (libvirt_domain_memory_stats_unused_bytes{SEL}) / max by (domain) (libvirt_domain_memory_stats_available_bytes{SEL}))",
        "pcd": None,
    },
    # Memory the guest sees, what it uses, and its disk cache (bytes)
    "mem_available_bytes": {
        "local": "max by (domain) (libvirt_domain_memory_stats_available_bytes{SEL})",
        "pcd": None,
    },
    "mem_used_bytes": {
        "local": "max by (domain) (libvirt_domain_memory_stats_available_bytes{SEL} - libvirt_domain_memory_stats_usable_bytes{SEL})",
        "pcd": None,
    },
    "mem_cache_bytes": {
        "local": "max by (domain) (libvirt_domain_memory_stats_disk_cache_bytes{SEL})",
        "pcd": None,
    },
    # Pages the guest had to read back from disk (swap or files it dropped from cache)
    "major_faults_ps": {
        "local": f"sum by (domain) (rate(libvirt_domain_memory_stats_major_fault_total{{SEL}}{R}))",
        "pcd": None,
    },
    "mem_total_bytes": {
        "local": "max by (domain) (libvirt_domain_info_maximum_memory_bytes{SEL})",
        "pcd": "sum by (domain) (pcd:vm_mem_total{SEL})",
    },
    "net_rx_bps": {
        "local": f"sum by (domain) (rate(libvirt_domain_interface_stats_receive_bytes_total{{SEL}}{R}))",
        "pcd": "sum by (domain) (pcd:vm_rx_bytes{SEL})",
    },
    "net_tx_bps": {
        "local": f"sum by (domain) (rate(libvirt_domain_interface_stats_transmit_bytes_total{{SEL}}{R}))",
        "pcd": "sum by (domain) (pcd:vm_tx_bytes{SEL})",
    },
    "read_iops": {
        "local": f"sum by (domain) (rate(libvirt_domain_block_stats_read_requests_total{{SEL}}{R}))",
        "pcd": "sum by (domain) (pcd:vm_read_iops{SEL})",
    },
    "write_iops": {
        "local": f"sum by (domain) (rate(libvirt_domain_block_stats_write_requests_total{{SEL}}{R}))",
        "pcd": "sum by (domain) (pcd:vm_write_iops{SEL})",
    },
    "disk_iops": {
        "local": f"sum by (domain) (rate(libvirt_domain_block_stats_read_requests_total{{SEL}}{R})) + sum by (domain) (rate(libvirt_domain_block_stats_write_requests_total{{SEL}}{R}))",
        "pcd": "sum by (domain) (pcd:vm_read_iops{SEL}) + sum by (domain) (pcd:vm_write_iops{SEL})",
    },
    # Milliseconds per request. PCD's latency series have no documented unit, so none from it.
    "disk_latency_ms": {
        "local": f"1000 * (sum by (domain) (rate(libvirt_domain_block_stats_read_time_seconds_total{{SEL}}{R})) + sum by (domain) (rate(libvirt_domain_block_stats_write_time_seconds_total{{SEL}}{R}))) / (sum by (domain) (rate(libvirt_domain_block_stats_read_requests_total{{SEL}}{R})) + sum by (domain) (rate(libvirt_domain_block_stats_write_requests_total{{SEL}}{R})))",
        "pcd": None,
    },
    # Time the VM's vCPUs waited for a host CPU (steal), as % of its vCPUs.
    "cpu_wait_pct": {
        "local": f"100 * sum by (domain) (rate(libvirt_domain_vcpu_delay_seconds_total{{SEL}}{R})) / sum by (domain) (libvirt_domain_info_virtual_cpus{{SEL}})",
        "pcd": "avg by (domain) (pcd:vm_cpu_throttling_percentage{SEL})",
    },
}

# Cinder backend capacity, which PCD Ops writes into its own store each inventory run
# (storage.samples); every 15 minutes, so each step takes the latest sample (MetricsQL's
# last_over_time without a window looks back one step).
STORAGE: dict[str, dict[str, str | None]] = {
    "total_bytes": {"local": "max(last_over_time(pcd_ops_storage_total_bytes{SEL}))", "pcd": None},
    "used_bytes": {
        "local": "max(last_over_time(pcd_ops_storage_total_bytes{SEL})) - max(last_over_time(pcd_ops_storage_free_bytes{SEL}))",
        "pcd": None,
    },
    "provisioned_bytes": {"local": "max(last_over_time(pcd_ops_storage_provisioned_bytes{SEL}))", "pcd": None},
}

# A cluster (host aggregate): the host metrics over all its hosts. SEL matches several hosts
# (hypervisor_id=~"…" locally, host=~"…" in Grafana); CPU is averaged over every core.
CLUSTER: dict[str, dict[str, str | None]] = {
    k: {src: t and t.replace(" by (hypervisor_id)", "").replace(" by (host)", "") for src, t in v.items()}
    for k, v in HOST.items()
}
# Allocation, which PCD Ops writes into its own store each inventory run; SEL is aggregate="<id>".
CLUSTER_ALLOC: dict[str, dict[str, str | None]] = {
    "vcpu_alloc_pct": {"local": "100 * max(last_over_time(pcd_ops_cluster_vcpus_used{SEL})) / max(last_over_time(pcd_ops_cluster_vcpus_total{SEL}))", "pcd": None},
    "mem_alloc_pct": {"local": "100 * max(last_over_time(pcd_ops_cluster_memory_used_bytes{SEL})) / max(last_over_time(pcd_ops_cluster_memory_total_bytes{SEL}))", "pcd": None},
    # Against what the allocation ratios allow (Placement: (total - reserved) × ratio), from the
    # overcommit collection
    "vcpu_ratio_pct": {"local": "100 * max(last_over_time(pcd_ops_cluster_vcpus_allocated{SEL})) / max(last_over_time(pcd_ops_cluster_vcpus_capacity{SEL}))", "pcd": None},
    "mem_ratio_pct": {"local": "100 * max(last_over_time(pcd_ops_cluster_memory_allocated_bytes{SEL})) / max(last_over_time(pcd_ops_cluster_memory_capacity_bytes{SEL}))", "pcd": None},
    "vms": {"local": "max(last_over_time(pcd_ops_cluster_vms{SEL}))", "pcd": None},
}

# One volume: libvirt's stats for the VM disk it is attached as (SEL: domain + target_device).
# PCD's Grafana only has per-VM disk series, so local only.
_BLK = "libvirt_domain_block_stats_"
VOLUME: dict[str, dict[str, str | None]] = {
    "read_bps": {"local": f"sum(rate({_BLK}read_bytes_total{{SEL}}{R}))", "pcd": None},
    "write_bps": {"local": f"sum(rate({_BLK}write_bytes_total{{SEL}}{R}))", "pcd": None},
    "read_iops": {"local": f"sum(rate({_BLK}read_requests_total{{SEL}}{R}))", "pcd": None},
    "write_iops": {"local": f"sum(rate({_BLK}write_requests_total{{SEL}}{R}))", "pcd": None},
    "latency_ms": {
        "local": f"1000 * (sum(rate({_BLK}read_time_seconds_total{{SEL}}{R})) + sum(rate({_BLK}write_time_seconds_total{{SEL}}{R}))) / (sum(rate({_BLK}read_requests_total{{SEL}}{R})) + sum(rate({_BLK}write_requests_total{{SEL}}{R})))",
        "pcd": None,
    },
    # What the host sees written (file-backed volumes, e.g. NFS); network disks (RBD) report 0
    "allocated_bytes": {"local": f"max({_BLK}allocation{{SEL}})", "pcd": None},
    "capacity_bytes": {"local": f"max({_BLK}capacity_bytes{{SEL}})", "pcd": None},
}


def _on_backend(metric: str) -> str:
    """A libvirt disk counter's rate, summed over the disks that are volumes on one backend:
    joined through pcd_ops_volume_disk, which PCD Ops writes each inventory run."""
    return (f"sum(rate({_BLK}{metric}{R}) * on (domain, target_device) group_left "
            "max by (domain, target_device) (last_over_time(pcd_ops_volume_disk{SEL}[30m])))")


STORAGE.update({
    "read_bps": {"local": _on_backend("read_bytes_total"), "pcd": None},
    "write_bps": {"local": _on_backend("write_bytes_total"), "pcd": None},
    "iops": {"local": f"{_on_backend('read_requests_total')} + {_on_backend('write_requests_total')}", "pcd": None},
    "latency_ms": {
        "local": f"1000 * ({_on_backend('read_time_seconds_total')} + {_on_backend('write_time_seconds_total')}) / ({_on_backend('read_requests_total')} + {_on_backend('write_requests_total')})",
        "pcd": None,
    },
})

GROUPS = {"host": HOST, "vm": VM, "storage": STORAGE, "cluster": CLUSTER,
          "cluster_alloc": CLUSTER_ALLOC, "volume": VOLUME}
# The label each source keys a group by.
KEY = {("host", "local"): "hypervisor_id", ("host", "pcd"): "host",
       ("vm", "local"): "domain", ("vm", "pcd"): "domain", ("storage", "local"): "backend"}
PCD_RETENTION_DAYS = 14
PCD_STALE_S = 600   # two of the host agent's 5-minute writes

local_client = PrometheusClient(local_metrics.URL)

_source_cache: dict[str, tuple[float, str | None]] = {}


def promql(group: str, metric: str, source: str, selector: str = "") -> str | None:
    """The query for a metric from a source, with `selector` (e.g. 'domain="…"') applied."""
    t = GROUPS[group][metric][source]
    if t is None:
        return None
    if selector:
        return t.replace("SEL", selector)
    return t.replace(",SEL}", "}").replace("{SEL}", "")


def client(source: str) -> PrometheusClient:
    return local_client if source == "local" else prometheus_client


async def _local_ok() -> bool:
    """The local store is on, running, and has scraped at least one exporter."""
    if not settings.metrics_local_enabled:
        return False
    try:
        return bool(await local_client.query("count(up == 1)"))
    except (httpx.HTTPError, ValueError, MetricsNotConfigured):
        return False


async def source(min_days: float = 0) -> str | None:
    """Where metrics come from: "local" when PCD Ops' own store has data for at least
    `min_days` (or has any and Grafana isn't set up), else "pcd" when Grafana is set up, else
    None. Decided at most once a minute."""
    key = f"{min_days}"
    hit = _source_cache.get(key)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    local = await _local_ok()
    grafana = bool(settings.grafana_token or settings.prometheus_url)
    chosen = None
    if local and (_collected_days() >= min_days or not grafana):
        chosen = "local"
    elif grafana:
        chosen = "pcd"
    _source_cache[key] = (time.monotonic(), chosen)
    return chosen


def forget_source() -> None:
    """Choose the source afresh on the next query (after a Settings change)."""
    _source_cache.clear()


def _collected_days() -> float:
    since = local_metrics.collecting_since()
    return (time.time() - since) / 86400 if since else 0


def retention_days(source: str) -> int:
    return local_metrics.retention_days() if source == "local" else PCD_RETENTION_DAYS


def cluster_selector(source: str, hypervisors: list[dict]) -> str | None:
    """Label matcher for several hypervisors in a source; None if it can name none of them."""
    if source == "local":
        ids = [h["id"] for h in hypervisors]
        label = "hypervisor_id"
    else:
        ids = [h["service_host"] for h in hypervisors if h.get("service_host")]
        label = "host"
    # Nova IDs and PCD host UUIDs: nothing a regex or a PromQL string would read specially
    ids = [i for i in map(str, ids) if re.fullmatch(r"[\w.-]+", i)]
    return f'{label}=~"{"|".join(ids)}"' if ids else None


def host_selector(source: str, hypervisor: dict) -> str | None:
    """Label matcher for one hypervisor in a source; None if the source can't name it."""
    if source == "local":
        return f'hypervisor_id="{hypervisor["id"]}"'
    uuid = hypervisor.get("service_host")
    return f'host="{uuid}"' if uuid else None


async def instant(group: str, src: str, metrics: list[str] | None = None) -> dict[str, dict]:
    """Current value of each metric, keyed by the source's key label: {key: {metric: value}}."""
    names = [m for m in (metrics or GROUPS[group]) if GROUPS[group][m][src]]
    label = KEY[(group, src)]
    out: dict[str, dict] = {}
    results = await _gather(client(src).query(promql(group, m, src)) for m in names)
    for m, res in zip(names, results):
        for s in res or []:
            k = s["metric"].get(label)
            v = _num(s["value"][1])
            if k and v is not None:
                out.setdefault(k, {})[m] = v
    return out


async def host_health(src: str) -> dict[str, dict]:
    """Per host: locally, whether each exporter answered its last scrape; through Grafana, the
    age of the newest sample. `stale` when the data can't be trusted as current."""
    out: dict[str, dict] = {}
    if src == "local":
        for s in await local_client.query("up"):
            k, job = s["metric"].get("hypervisor_id"), s["metric"].get("job")
            if k and job:
                out.setdefault(k, {"exporters": {}})["exporters"][job] = s["value"][1] == "1"
        for v in out.values():
            v["stale"] = not v["exporters"].get("node", False)
        return out
    for s in await prometheus_client.query("time() - max by (host) (timestamp(pcd:hyp_cpu_usage))"):
        age = _num(s["value"][1])
        if s["metric"].get("host") and age is not None:
            out[s["metric"]["host"]] = {"age_s": round(age), "stale": age > PCD_STALE_S}
    return out


async def series(group: str, src: str, selector: str, metrics: list[str],
                 start, end, step: str) -> dict[str, list[dict]]:
    """{metric: [{ts, v}]} for one host or VM."""
    names = [m for m in metrics if GROUPS[group][m][src]]
    prom = client(src)
    results = await _gather(prom.query_range(promql(group, m, src, selector), start, end, step)
                            for m in names)
    out: dict[str, list[dict]] = {}
    for m, res in zip(names, results):
        pts = []
        for s in res or []:
            for ts, v in s.get("values", []):
                n = _num(v)
                if n is not None:
                    pts.append({"ts": int(float(ts)), "v": round(n, 3)})
        out[m] = sorted(pts, key=lambda p: p["ts"])
    return out


async def _gather(coros):
    return await asyncio.gather(*coros)


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None
