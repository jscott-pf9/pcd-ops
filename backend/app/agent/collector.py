"""
Data collection functions — one per domain.

Each function fetches from OpenStack/Prometheus/AI and writes results
to the SQLite cache via services.db.cache_set().

These run in the background agent, not in request handlers.
OpenStack SDK calls are blocking, so they run via asyncio.to_thread().
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta

from app.dependencies import get_ai_provider
from app.services import db
from app.services.openstack import get_connection
from app.services.prometheus import prometheus_client

logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_ips(addresses: dict) -> list[str]:
    ips = []
    for entries in (addresses or {}).values():
        for entry in entries:
            ips.append(entry.get("addr", ""))
    return ips


# ── Inventory ──────────────────────────────────────────────────────────────────

async def collect_inventory() -> None:
    logger.info("Collecting inventory…")
    conn = get_connection()

    (servers, hypervisors, volumes, networks, tenants,
     floating_ips, images, security_groups, ports, flavors_raw, keypairs_raw,
     aggregates) = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.compute.hypervisors(details=True))),
        asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.network.networks())),
        asyncio.to_thread(lambda: list(conn.identity.projects())),
        asyncio.to_thread(lambda: list(conn.network.ips())),
        asyncio.to_thread(lambda: list(conn.image.images())),
        asyncio.to_thread(lambda: list(conn.network.security_groups())),
        asyncio.to_thread(lambda: list(conn.network.ports(device_owner="compute:nova"))),
        asyncio.to_thread(lambda: list(conn.compute.flavors())),
        asyncio.to_thread(lambda: list(conn.compute.keypairs())),
        asyncio.to_thread(lambda: list(conn.compute.aggregates())),
    )

    db.cache_set("inventory:servers", [
        {
            "id": s.id,
            "name": s.name,
            "status": s.status,
            "flavor_name": (s.flavor or {}).get("original_name") or (s.flavor or {}).get("id", ""),
            "flavor_vcpus": (s.flavor or {}).get("vcpus"),
            "flavor_ram_mb": (s.flavor or {}).get("ram"),
            "image_id": (s.image or {}).get("id", "") if isinstance(s.image, dict) else "",
            "project_id": s.project_id,
            "ips": _extract_ips(s.addresses),
            "hypervisor_hostname": getattr(s, "hypervisor_hostname", None),
            "created_at": s.created_at,
            "updated_at": s.updated_at,
        }
        for s in servers
    ])

    # ── Per-hypervisor usage derived from server allocations ──────────────────
    # Nova API ≥ 2.88 removed vcpus/memory/running_vms from the hypervisor
    # detail endpoint; compute them from server flavor data as a fallback.
    from collections import defaultdict as _dd
    _hyp_vms: dict[str, int]   = _dd(int)
    _hyp_vcpus: dict[str, int] = _dd(int)
    _hyp_mem: dict[str, int]   = _dd(int)
    for s in servers:
        host = getattr(s, "hypervisor_hostname", None)
        if not host:
            continue
        _hyp_vms[host] += 1
        fl = s.flavor or {}
        _hyp_vcpus[host] += fl.get("vcpus") or 0
        _hyp_mem[host] += fl.get("ram") or 0

    # ── Fetch individual hypervisor details for cpu_info ──────────────────────
    # cpu_info is only returned by GET /os-hypervisors/{id} (the show endpoint),
    # not by GET /os-hypervisors/detail (the list endpoint).
    _hyp_detail_raw = await asyncio.gather(*[
        asyncio.to_thread(lambda hid=h.id: conn.compute.get_hypervisor(hid))
        for h in hypervisors
    ], return_exceptions=True)
    _hyp_detail: dict[str, any] = {
        h.id: d for h, d in zip(hypervisors, _hyp_detail_raw)
        if not isinstance(d, Exception)
    }

    # ── SSH hardware collection (NICs + physical RAM) ──────────────────────────
    from app.services.ssh import collect_host_hardware
    from app.config import settings as _cfg
    _ssh_user     = _cfg.hypervisor_ssh_user or "root"
    _ssh_key      = _cfg.hypervisor_ssh_key_path or ""
    _ssh_password = _cfg.hypervisor_ssh_password or ""
    # Only attempt SSH when credentials are present; avoids false "unreachable"
    # badges when SSH is simply not configured.
    _ssh_configured = bool(_ssh_key or _ssh_password)

    _up_hyps = [h for h in hypervisors if h.state == "up" and h.host_ip] if _ssh_configured else []
    _hw_results = await asyncio.gather(*[
        asyncio.to_thread(collect_host_hardware, h.host_ip, _ssh_user, _ssh_key, _ssh_password)
        for h in _up_hyps
    ], return_exceptions=True)
    _hw_by_host: dict[str, dict] = {
        h.name: (r if isinstance(r, dict) else {"connected": False, "nic_count": None, "ram_mb": None})
        for h, r in zip(_up_hyps, _hw_results)
    }
    _ssh_attempted: set[str] = {h.name for h in _up_hyps}

    # ── Parse cpu_info JSON ────────────────────────────────────────────────────
    def _parse_cpu_info(h) -> dict:
        # Prefer the individually-fetched detail which carries cpu_info
        src = _hyp_detail.get(h.id, h)
        raw = getattr(src, "cpu_info", None) or getattr(h, "cpu_info", None)
        if not raw:
            return {}
        if isinstance(raw, dict):
            return raw
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}

    hyp_records = []
    for h in hypervisors:
        ci    = _parse_cpu_info(h)
        topo  = ci.get("topology") or {}
        sockets = topo.get("sockets")
        cores   = topo.get("cores")
        threads = topo.get("threads")
        logical = (sockets * cores * threads) if (sockets and cores and threads) else None

        hw              = _hw_by_host.get(h.name, {})
        ssh_ok          = (hw.get("connected") if h.name in _ssh_attempted else None)
        nic_count       = hw.get("nic_count")
        ram_mb_ssh      = hw.get("ram_mb")
        os_version      = hw.get("os_version")
        pending_patches = hw.get("pending_patches")

        hyp_records.append({
            "id":               h.id,
            "hostname":         h.name,
            "state":            h.state,
            "status":           h.status,
            "host_ip":          h.host_ip,
            # Physical specs
            "cpu_vendor":       ci.get("vendor"),
            "cpu_model":        ci.get("model"),
            "cpu_arch":         ci.get("arch"),
            "cpu_sockets":      sockets,
            "cpu_cores":        cores,
            "cpu_threads":      threads,
            "cpu_logical":      logical,
            # Nova 2.88+ removed memory_mb from API; fall back to SSH /proc/meminfo
            "memory_mb_total":  h.memory_size or ram_mb_ssh or None,
            "nic_count":        nic_count,
            "ssh_ok":           ssh_ok,
            "os_version":       os_version,
            "pending_patches":  pending_patches,
            "hypervisor_type":  getattr(h, "hypervisor_type", None),
            "hypervisor_version": getattr(h, "hypervisor_version", None),
            # Utilisation (Nova 2.88+ may omit; derived from server data as fallback)
            "vcpus_total":      h.vcpus or logical or None,
            "vcpus_used":       h.vcpus_used if h.vcpus_used is not None else _hyp_vcpus.get(h.name),
            "memory_mb_used":   h.memory_used if h.memory_used is not None else _hyp_mem.get(h.name),
            "disk_gb_total":    h.local_disk_size or None,
            "disk_gb_used":     h.local_disk_used or None,
            "running_vms":      h.running_vms if h.running_vms is not None else _hyp_vms.get(h.name, 0),
        })
    db.cache_set("inventory:hypervisors", hyp_records)

    db.cache_set("inventory:volumes", [
        {
            "id": v.id,
            "name": v.name or "(unnamed)",
            "size_gb": v.size,
            "status": v.status,
            "volume_type": v.volume_type,
            "attached_to": [a.get("server_id") for a in (v.attachments or [])],
            "project_id": v.project_id,
            "created_at": v.created_at,
        }
        for v in volumes
    ])

    db.cache_set("inventory:networks", [
        {
            "id": n.id,
            "name": n.name,
            "status": n.status,
            "admin_state_up": n.is_admin_state_up,
            "shared": n.is_shared,
            "external": n.is_router_external,
            "project_id": n.project_id,
            "subnets": n.subnet_ids or [],
        }
        for n in networks
    ])

    db.cache_set("inventory:tenants", [
        {"id": p.id, "name": p.name} for p in tenants
    ])

    # ── Floating IPs — cross-referenced to server names via ports ─────────────
    port_to_server: dict[str, str] = {p.id: p.device_id for p in ports if p.device_id}
    server_name_by_id: dict[str, str] = {s.id: s.name for s in servers}
    db.cache_set("inventory:floating_ips", [
        {
            "id":                   fip.id,
            "floating_ip_address":  fip.floating_ip_address,
            "fixed_ip_address":     fip.fixed_ip_address,
            "status":               fip.status,
            "port_id":              fip.port_id,
            "server_id":            port_to_server.get(fip.port_id or "", ""),
            "server_name":          server_name_by_id.get(port_to_server.get(fip.port_id or "", ""), ""),
            "project_id":           fip.project_id,
        }
        for fip in floating_ips
    ])

    # ── Glance images — cross-referenced to show which VMs use each image ──────
    image_usage: dict[str, list[str]] = {}
    for s in servers:
        iid = (s.image or {}).get("id", "") if isinstance(s.image, dict) else ""
        if iid:
            image_usage.setdefault(iid, []).append(s.name)
    db.cache_set("inventory:images", [
        {
            "id":           img.id,
            "name":         img.name or "(unnamed)",
            "status":       img.status,
            "visibility":   img.visibility,
            "disk_format":  img.disk_format,
            "size_gb":      round((img.size or 0) / (1024**3), 2),
            "owner":        img.owner,
            "is_protected": img.is_protected,
            "created_at":   img.created_at,
            "used_by_vms":  image_usage.get(img.id, []),
        }
        for img in images
    ])

    # ── Security groups — flag overly permissive rules ─────────────────────────
    _tenant_name_map = {p.id: p.name for p in tenants}  # includes all tenants (admin, service, etc.)

    def _is_risky(rule: dict) -> bool:
        return (rule.get("remote_ip_prefix") in ("0.0.0.0/0", "::/0") and
                rule.get("direction") == "ingress")

    sg_list = []
    for sg in security_groups:
        rules = [
            {
                "id":               r.get("id", ""),
                "direction":        r.get("direction", ""),
                "protocol":         r.get("protocol") or "any",
                "port_range_min":   r.get("port_range_min"),
                "port_range_max":   r.get("port_range_max"),
                "remote_ip_prefix": r.get("remote_ip_prefix"),
                "ethertype":        r.get("ethertype", ""),
                "risky":            _is_risky(r),
            }
            for r in (sg.security_group_rules or [])
        ]
        sg_list.append({
            "id":           sg.id,
            "name":         sg.name,
            "description":  sg.description or "",
            "project_id":   sg.project_id,
            "tenant_name":  _tenant_name_map.get(sg.project_id, ""),
            "rules":        rules,
            "risky_rules":  sum(1 for r in rules if r["risky"]),
        })
    db.cache_set("inventory:security_groups", sg_list)

    db.cache_set("inventory:flavors", sorted([
        {"id": f.id, "name": f.name, "vcpus": f.vcpus, "ram_mb": f.ram, "disk_gb": f.disk or 0}
        for f in flavors_raw
    ], key=lambda f: (f["vcpus"], f["ram_mb"])))

    db.cache_set("inventory:keypairs", sorted([
        {"name": kp.name, "fingerprint": kp.fingerprint or "", "type": getattr(kp, "type", "ssh") or "ssh"}
        for kp in keypairs_raw
    ], key=lambda k: k["name"]))

    db.cache_set("inventory:clusters", sorted([
        {
            "id":                agg.id,
            "name":              agg.name,
            "availability_zone": agg.availability_zone,
            "hosts":             list(agg.hosts or []),
            "metadata":          {k: v for k, v in (agg.metadata or {}).items() if k != "availability_zone"},
            "created_at":        agg.created_at,
            "updated_at":        agg.updated_at,
        }
        for agg in aggregates
    ], key=lambda a: a["name"]))

    active = sum(1 for s in servers if s.status == "ACTIVE")
    vcpus_used = sum(h.vcpus_used or 0 for h in hypervisors)
    vcpus_total = sum(h.vcpus or 0 for h in hypervisors)
    mem_used_gb = sum((h.memory_used or 0) for h in hypervisors) // 1024
    mem_total_gb = sum((h.memory_size or 0) for h in hypervisors) // 1024
    volume_tb = sum((v.size or 0) for v in volumes) / 1024

    db.cache_set("inventory:summary", {
        "servers": {"total": len(servers), "active": active},
        "hypervisors": {"total": len(hypervisors)},
        "volumes": {"total": len(volumes), "total_tb": round(volume_tb, 2)},
        "networks": {"total": len(networks)},
        "clusters": {"total": len(aggregates)},
        "vcpus": {"used": vcpus_used, "total": vcpus_total},
        "memory_gb": {"used": mem_used_gb, "total": mem_total_gb},
    })

    logger.info("Inventory collected: %d servers, %d hypervisors, %d volumes, %d networks, "
                "%d floating_ips, %d images, %d security_groups",
                len(servers), len(hypervisors), len(volumes), len(networks),
                len(floating_ips), len(images), len(security_groups))


# ── Reclamation ────────────────────────────────────────────────────────────────

async def collect_reclamation() -> None:
    logger.info("Collecting reclamation candidates…")
    conn = get_connection()

    all_volumes = await asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True)))
    all_servers = await asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True)))
    all_fips = await asyncio.to_thread(lambda: list(conn.network.ips()))

    attached_gb: dict[str, int] = {}
    for v in all_volumes:
        for att in (v.attachments or []):
            sid = att.get("server_id")
            if sid:
                attached_gb[sid] = attached_gb.get(sid, 0) + (v.size or 0)

    stopped_servers = [
        {
            "id": s.id,
            "name": s.name,
            "status": s.status,
            "project_id": s.project_id,
            "updated_at": s.updated_at,
            "attached_disk_gb": attached_gb.get(s.id, 0),
        }
        for s in all_servers
        if s.status in ("SHUTOFF", "ERROR", "SHELVED_OFFLOADED")
    ]

    unattached_volumes = [
        {
            "id": v.id,
            "name": v.name or "(unnamed)",
            "size": v.size,
            "volume_type": v.volume_type,
            "availability_zone": v.availability_zone,
            "is_bootable": v.is_bootable,
            "description": v.description or "",
            "project_id": v.project_id,
            "created_at": v.created_at,
            "updated_at": v.updated_at,
        }
        for v in all_volumes
        if v.status == "available" and not v.attachments
    ]

    unused_floating_ips = [
        {"id": fip.id, "floating_ip_address": fip.floating_ip_address, "project_id": fip.project_id}
        for fip in all_fips
        if fip.port_id is None
    ]

    db.cache_set("reclamation:candidates", {
        "stopped_servers": stopped_servers,
        "unattached_volumes": unattached_volumes,
        "unused_floating_ips": unused_floating_ips,
    })

    logger.info("Reclamation: %d stopped, %d unattached vols, %d unused FIPs",
                len(stopped_servers), len(unattached_volumes), len(unused_floating_ips))


# ── Capacity ───────────────────────────────────────────────────────────────────

async def collect_capacity() -> None:
    logger.info("Collecting capacity…")
    conn = get_connection()

    servers_task = asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True)))

    # Prometheus gives us accurate cluster-wide totals and usage
    prom_queries = [
        prometheus_client.query("sum(openstack_nova_limits_vcpus_used)"),
        prometheus_client.query("sum(openstack_nova_limits_vcpus_max)"),
        prometheus_client.query("sum(openstack_nova_limits_memory_used)"),
        prometheus_client.query("sum(openstack_nova_limits_memory_max)"),
        prometheus_client.query("sum(openstack_cinder_limits_volume_used_gb)"),
        prometheus_client.query("sum(openstack_cinder_limits_volume_max_gb)"),
    ]

    servers, *prom_results = await asyncio.gather(servers_task, *prom_queries, return_exceptions=True)

    def _prom_val(result, fallback=None):
        if isinstance(result, Exception) or not result:
            return fallback
        try:
            return float(result[0]["value"][1])
        except (IndexError, KeyError, ValueError):
            return fallback

    # Prefer Prometheus values; fall back to server+flavor derivation if unavailable
    prom_vcpus_used  = _prom_val(prom_results[0])
    prom_vcpus_total = _prom_val(prom_results[1])
    prom_ram_used_mb = _prom_val(prom_results[2])
    prom_ram_total_mb= _prom_val(prom_results[3])
    prom_stor_used   = _prom_val(prom_results[4])
    prom_stor_total  = _prom_val(prom_results[5])

    used_vcpus   = prom_vcpus_used  if prom_vcpus_used  is not None else sum(s.flavor.get("vcpus", 0) or 0 for s in servers if s.status not in ("DELETED", "ERROR"))
    total_vcpus  = prom_vcpus_total if prom_vcpus_total is not None else None
    used_ram_gb  = (prom_ram_used_mb  / 1024) if prom_ram_used_mb  is not None else sum((s.flavor.get("ram", 0) or 0) / 1024 for s in servers if s.status not in ("DELETED", "ERROR"))
    total_ram_gb = (prom_ram_total_mb / 1024) if prom_ram_total_mb is not None else None
    used_stor_gb  = prom_stor_used  if prom_stor_used  is not None else 0
    total_stor_gb = prom_stor_total if prom_stor_total is not None else None

    def _resource(used, total):
        return {
            "used": round(used, 1),
            "total": round(total, 1) if total is not None else None,
            "free": round(total - used, 1) if total is not None else None,
        }

    db.cache_set("capacity:summary", {
        "vcpus":      _resource(used_vcpus,  total_vcpus),
        "ram_gb":     _resource(used_ram_gb,  total_ram_gb),
        "storage_gb": _resource(used_stor_gb, total_stor_gb),
    })
    logger.info("Capacity: %.0f/%.0f vCPUs, %.0f/%.0f GB RAM, %.0f/%.0f GB storage",
                used_vcpus, total_vcpus or 0, used_ram_gb, total_ram_gb or 0, used_stor_gb, total_stor_gb or 0)


# ── Capacity Trends & Forecast ────────────────────────────────────────────────

TREND_METRICS = {
    "vcpus": {
        "used":  "sum(openstack_nova_limits_vcpus_used)",
        "total": "sum(openstack_nova_limits_vcpus_max)",
    },
    "ram_gb": {
        "used":  "sum(openstack_nova_limits_memory_used) / 1024",
        "total": "sum(openstack_nova_limits_memory_max) / 1024",
    },
    "storage_gb": {
        "used":  "sum(openstack_cinder_limits_volume_used_gb)",
        "total": "sum(openstack_cinder_limits_volume_max_gb)",
    },
}

TREND_DAYS = 7
TREND_STEP = "1h"   # ~168 data points over 7 days


def _linear_regression(xs: list[float], ys: list[float]) -> tuple[float, float, float]:
    """Return (slope, intercept, r_squared). slope is units/day."""
    n = len(xs)
    if n < 3:
        return 0.0, 0.0, 0.0
    x_mean = sum(xs) / n
    y_mean = sum(ys) / n
    ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    ss_xx = sum((x - x_mean) ** 2 for x in xs)
    if ss_xx == 0:
        return 0.0, y_mean, 0.0
    slope = ss_xy / ss_xx
    intercept = y_mean - slope * x_mean
    y_pred = [slope * x + intercept for x in xs]
    ss_res = sum((y - yp) ** 2 for y, yp in zip(ys, y_pred))
    ss_tot = sum((y - y_mean) ** 2 for y in ys)
    r_sq = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return slope, intercept, max(0.0, r_sq)


def _days_until(slope: float, intercept: float, total: float, target_pct: float, now_day: float) -> int | None:
    """Days from now until usage hits target_pct of total. None if not trending there."""
    if slope <= 0 or total <= 0:
        return None
    target = target_pct * total
    t = (target - intercept) / slope
    days = t - now_day
    return int(days) if days > 0 else 0


async def collect_capacity_trends() -> None:
    logger.info("Collecting capacity trends from Prometheus…")
    ai = get_ai_provider()

    end = datetime.utcnow()
    start = end - timedelta(days=TREND_DAYS)

    trends: dict = {}
    for resource, queries in TREND_METRICS.items():
        try:
            used_series, total_series = await asyncio.gather(
                prometheus_client.query_range(queries["used"],  start, end, step=TREND_STEP),
                prometheus_client.query_range(queries["total"], start, end, step=TREND_STEP),
            )

            # Build aligned time-series list
            used_map  = {v[0]: float(v[1]) for r in used_series  for v in r.get("values", [])}
            total_map = {v[0]: float(v[1]) for r in total_series for v in r.get("values", [])}
            common_ts = sorted(set(used_map) & set(total_map))

            if not common_ts:
                trends[resource] = {"series": [], "trend": None, "forecast": None}
                continue

            # Normalise to "day index" (0 = start of window)
            t0 = common_ts[0]
            xs = [(t - t0) / 86400 for t in common_ts]  # days since start
            ys_used  = [used_map[t]  for t in common_ts]
            ys_total = [total_map[t] for t in common_ts]

            # Most recent total value as capacity
            latest_total = ys_total[-1] if ys_total else 0
            latest_used  = ys_used[-1]  if ys_used  else 0
            latest_day   = xs[-1]

            slope, intercept, r_sq = _linear_regression(xs, ys_used)

            forecast = {
                "days_to_80pct":  _days_until(slope, intercept, latest_total, 0.80, latest_day),
                "days_to_90pct":  _days_until(slope, intercept, latest_total, 0.90, latest_day),
                "days_to_100pct": _days_until(slope, intercept, latest_total, 1.00, latest_day),
            }

            # Down-sample series to ~60 points for the UI
            step = max(1, len(common_ts) // 60)
            series = [
                {
                    "ts": common_ts[i],
                    "label": datetime.utcfromtimestamp(common_ts[i]).strftime("%m/%d"),
                    "used": round(ys_used[i], 1),
                    "total": round(ys_total[i], 1),
                    "pct": round(ys_used[i] / ys_total[i] * 100, 1) if ys_total[i] > 0 else 0,
                }
                for i in range(0, len(common_ts), step)
            ]

            trends[resource] = {
                "series": series,
                "latest": {"used": round(latest_used, 1), "total": round(latest_total, 1),
                           "pct": round(latest_used / latest_total * 100, 1) if latest_total > 0 else 0},
                "trend": {"slope_per_day": round(slope, 4), "r_squared": round(r_sq, 3)},
                "forecast": forecast,
            }
        except Exception as e:
            logger.warning("Trend collection failed for %s: %s", resource, e)
            trends[resource] = {"series": [], "trend": None, "forecast": None}

    # AI interpretation
    forecast_summary = {
        r: {
            "current_pct": trends[r].get("latest", {}).get("pct"),
            "forecast": trends[r].get("forecast"),
            "slope_per_day": trends[r].get("trend", {}).get("slope_per_day") if trends[r].get("trend") else None,
        }
        for r in trends
    }
    try:
        analysis = await ai.analyze(
            "You are analyzing OpenStack cluster capacity trends. "
            "Based on the 30-day usage data below, identify: "
            "(1) resources trending toward saturation, "
            "(2) any concerning growth rates, "
            "(3) estimated runway before intervention is needed, "
            "(4) specific recommendations. Be concise and actionable.",
            forecast_summary,
        )
    except Exception as e:
        logger.warning("AI capacity analysis failed: %s", e)
        analysis = None

    db.cache_set("capacity:trends", {
        "window_days": TREND_DAYS,
        "resources": trends,
        "ai_analysis": analysis,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
    })
    logger.info("Capacity trends collected.")


# ── Hypervisor Log Collection (SSH) ───────────────────────────────────────────

MAX_RECENT_LOGS = 5000   # keep last N entries in the combined cache


async def collect_logs() -> None:
    from app.services.ssh import collect_host_logs
    from app.services.db import cache_get
    logger.info("Collecting hypervisor logs via SSH…")

    hypervisors_raw, _ = cache_get("inventory:hypervisors")
    if not hypervisors_raw:
        logger.info("No hypervisor cache yet — skipping log collection.")
        return

    # Only collect from UP hypervisors with a reachable IP
    targets = [
        h for h in hypervisors_raw
        if h.get("state") == "up" and h.get("host_ip")
    ]
    if not targets:
        logger.info("No active hypervisors found — skipping log collection.")
        return

    from app.config import settings
    user     = settings.hypervisor_ssh_user or "root"
    key_path = settings.hypervisor_ssh_key_path or ""
    password = settings.hypervisor_ssh_password or ""

    # SSH each hypervisor in parallel
    results = await asyncio.gather(*[
        asyncio.to_thread(collect_host_logs, h["host_ip"], user, key_path, password)
        for h in targets
    ], return_exceptions=True)

    all_entries: list[dict] = []
    for h, result in zip(targets, results):
        if isinstance(result, Exception):
            logger.warning("Log collection failed for %s: %s", h["hostname"], result)
        else:
            for entry in result:
                entry["hostname"] = h["hostname"]
            all_entries.extend(result)
            db.cache_set(f"logs:hypervisor:{h['host_ip']}", result)
            logger.info("Collected %d log entries from %s", len(result), h["hostname"])

    # Combined recent log cache — keep last MAX_RECENT_LOGS, error/warning first
    all_entries.sort(key=lambda e: (0 if e["level"] == "ERROR" else 1 if e["level"] == "WARNING" else 2))
    db.cache_set("logs:recent", all_entries[:MAX_RECENT_LOGS])
    logger.info("Log collection complete: %d total entries.", len(all_entries))


# ── Snapshots ──────────────────────────────────────────────────────────────────

async def collect_snapshots() -> None:
    logger.info("Collecting snapshots…")
    conn = get_connection()

    snapshots = await asyncio.to_thread(lambda: list(conn.block_storage.snapshots(all_projects=True)))

    db.cache_set("snapshots:list", [
        {
            "id": s.id,
            "name": s.name,
            "size": s.size,
            "status": s.status,
            "volume_id": s.volume_id,
            "project_id": s.project_id,
            "created_at": s.created_at,
        }
        for s in snapshots
    ])
    logger.info("Snapshots collected: %d", len(snapshots))


# ── Right-Sizing ───────────────────────────────────────────────────────────────
#
# PCD-native per-VM Prometheus metrics (from libvirt-exporter):
#   pcd:vm_cpu_usage / pcd:vm_cpu_total  → CPU utilisation %
#   pcd:vm_mem_usage / pcd:vm_mem_total  → RAM utilisation %
#   pcd:vm_read_iops + pcd:vm_write_iops → disk I/O activity
#   libvirt_domain_info_meta             → domain UUID → name/flavor/project
#
# Classification (7-day averages):
#   overprovisioned  — cpu_avg < LOW  AND  ram_avg < LOW
#   memory-pressure  — ram_avg >= HIGH (regardless of CPU)
#   cpu-pressure     — cpu_avg >= HIGH
#   right-sized      — both within LOW..HIGH band
#   idle             — cpu_avg < LOW, ram_avg < LOW, near-zero I/O
#   no-data          — no Prometheus series found

import re as _re


def _clean_analysis(text: str | None) -> str | None:
    """Strip AI preambles and raw markdown from an analysis string."""
    if not text:
        return None
    # 1. Strip markdown bold, italic, headers first so preamble detection
    #    catches patterns like "**Insight**: ..." after an outer preamble is removed
    text = _re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = _re.sub(r'\*(.+?)\*',     r'\1', text)
    text = _re.sub(r'^#{1,6}\s+',    '',    text, flags=_re.MULTILINE)
    # 2. Strip "Here is..." / "Insight:" / "Analysis:" preamble (may repeat
    #    once markdown is gone, e.g. "Here is...\n\nInsight: ...")
    _PREAMBLE = (
        r'^(?:here(?:\'s| is)[^:\n]*:|(?:\w+ )*insight[^:\n]*:|(?:\w+ )*analysis[^:\n]*:)\s*'
    )
    text = _re.sub(_PREAMBLE, '', text, flags=_re.IGNORECASE).strip()
    # Second pass catches "Insight: ..." left after outer preamble + blank lines removed
    text = _re.sub(_PREAMBLE, '', text, flags=_re.IGNORECASE).strip()
    # 3. Collapse excess blank lines
    text = _re.sub(r'\n{3,}', '\n\n', text)
    return text.strip() or None


RS_CPU_LOW  = 20.0   # % below → underutilised CPU
RS_CPU_HIGH = 80.0   # % above → CPU-pressured
RS_MEM_LOW  = 20.0   # % below → underutilised RAM
RS_MEM_HIGH = 80.0   # % above → RAM-pressured
RS_IO_IDLE  = 0.5    # avg IOPS below which disk is considered idle
RS_STEP     = "2h"   # ~84 data points over 7 days


import math as _math

def _series_from_range(data: list[dict]) -> list[dict]:
    """Flatten Prometheus range result → [{ts, v}], dropping non-finite values, ≤60 pts."""
    out = []
    for series in data:
        for ts, val in series.get("values", []):
            try:
                v = float(val)
                if not _math.isfinite(v):
                    continue
                out.append({"ts": int(ts), "v": round(v, 2)})
            except (ValueError, ZeroDivisionError):
                pass
    out.sort(key=lambda x: x["ts"])
    step = max(1, len(out) // 60)
    return out[::step]


def _prom_avg(series_list: list[dict], domain: str) -> float | None:
    """Return the mean value across all data points for a given domain."""
    vals = []
    for s in series_list:
        if s["metric"].get("domain") != domain:
            continue
        for _, v in s.get("values", []):
            try:
                f = float(v)
                if _math.isfinite(f):
                    vals.append(f)
            except ValueError:
                pass
    return round(sum(vals) / len(vals), 2) if vals else None


async def collect_rightsizing() -> None:
    logger.info("Collecting right-sizing (PCD pcd:vm_* metrics)…")
    conn = get_connection()
    ai = get_ai_provider()

    end = datetime.utcnow()
    start = end - timedelta(days=7)

    # Batch all Prometheus queries
    (
        meta_raw,
        cpu_series_raw, cpu_total_raw,
        mem_series_raw, mem_total_raw,
        io_series_raw,
    ) = await asyncio.gather(
        prometheus_client.query("libvirt_domain_info_meta"),
        prometheus_client.query_range("pcd:vm_cpu_usage / pcd:vm_cpu_total * 100",  start, end, step=RS_STEP),
        prometheus_client.query("pcd:vm_cpu_total"),
        prometheus_client.query_range("pcd:vm_mem_usage / pcd:vm_mem_total * 100",  start, end, step=RS_STEP),
        prometheus_client.query("pcd:vm_mem_total"),
        prometheus_client.query_range("pcd:vm_read_iops + pcd:vm_write_iops",       start, end, step=RS_STEP),
    )

    # Domain → metadata map (instance_name, project_name, flavor, host_name)
    domain_meta: dict[str, dict] = {m["metric"]["domain"]: m["metric"] for m in meta_raw}

    # Domain → current total (for labels)
    domain_cpu_total = {s["metric"]["domain"]: float(s["value"][1]) for s in cpu_total_raw if "domain" in s["metric"]}
    domain_mem_total = {s["metric"]["domain"]: float(s["value"][1]) for s in mem_total_raw if "domain" in s["metric"]}

    # Build per-domain series maps for sparklines
    cpu_series_by_domain = {s["metric"]["domain"]: _series_from_range([s]) for s in cpu_series_raw if "domain" in s["metric"]}
    mem_series_by_domain = {s["metric"]["domain"]: _series_from_range([s]) for s in mem_series_raw if "domain" in s["metric"]}
    io_series_by_domain  = {s["metric"]["domain"]: _series_from_range([s]) for s in io_series_raw  if "domain" in s["metric"]}

    servers, flavors_raw = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.compute.flavors())),
    )

    # Sort flavors ascending by vcpus then ram so we pick the smallest adequate fit
    all_flavors = sorted(
        [{"id": f.id, "name": f.name, "vcpus": f.vcpus, "ram_mb": f.ram} for f in flavors_raw],
        key=lambda f: (f["vcpus"], f["ram_mb"]),
    )

    recommendations = []
    for server in servers:
        uuid = server.id
        meta = domain_meta.get(uuid, {})

        fl = server.flavor or {}
        vcpus      = fl.get("vcpus") or 0
        ram_mb     = fl.get("ram")   or 0
        flavor_name = fl.get("original_name") or fl.get("id", "unknown")

        cpu_avg = _prom_avg(cpu_series_raw, uuid)
        mem_avg = _prom_avg(mem_series_raw, uuid)
        io_avg  = _prom_avg(io_series_raw,  uuid)

        cpu_series = cpu_series_by_domain.get(uuid, [])
        mem_series = mem_series_by_domain.get(uuid, [])
        io_series  = io_series_by_domain.get(uuid, [])

        has_data = cpu_avg is not None or mem_avg is not None

        # Classify
        if not has_data:
            classification = "no-data"
            risk = "unknown"
        elif mem_avg is not None and mem_avg >= RS_MEM_HIGH:
            classification = "memory-pressure"
            risk = "high" if mem_avg >= 90 else "medium"
        elif cpu_avg is not None and cpu_avg >= RS_CPU_HIGH:
            classification = "cpu-pressure"
            risk = "high" if cpu_avg >= 90 else "medium"
        elif (
            (cpu_avg is None or cpu_avg < RS_CPU_LOW) and
            (mem_avg is None or mem_avg < RS_MEM_LOW) and
            (io_avg  is None or io_avg  < RS_IO_IDLE)
        ):
            classification = "idle"
            risk = "low"
        elif (
            (cpu_avg is None or cpu_avg < RS_CPU_LOW) and
            (mem_avg is None or mem_avg < RS_MEM_LOW)
        ):
            classification = "overprovisioned"
            risk = "low"
        else:
            classification = "right-sized"
            risk = "low"

        # AI insight only for VMs that need attention — skip right-sized to save GPU
        _prompts = {
            "memory-pressure":  ("RAM is critically high. Identify the likely cause (memory leak, insufficient "
                                 "allocation, or genuine growth) and recommend the most urgent action."),
            "cpu-pressure":     ("CPU is consistently hitting its ceiling. Explain what workload pattern likely "
                                 "causes this and recommend whether to upsize or optimise the workload first."),
            "overprovisioned":  ("Both CPU and RAM are very lightly used. Assess whether this is a steady-state "
                                 "workload or seasonal, and recommend a specific smaller flavor if appropriate."),
            "idle":             ("The VM shows near-zero activity. Determine whether it's a cold-standby, "
                                 "misconfigured, or genuinely unused, and recommend the appropriate action."),
            # "right-sized" intentionally omitted — no action needed, saves GPU
        }
        analysis = None
        from app.config import settings as _settings
        if classification in _prompts and getattr(_settings, "ai_rightsizing_enabled", True):
            try:
                analysis = _clean_analysis(await ai.analyze(
                    f"Right-sizing analysis for this PCD VM — 2 plain sentences. {_prompts[classification]} "
                    "Start directly with the insight. No preamble ('Here is…'), no markdown, "
                    "no headers, no bullet points. Do not repeat the raw numbers.",
                    {
                        "vm": server.name,
                        "flavor": flavor_name,
                        "vcpus": vcpus,
                        "ram_mb": ram_mb,
                        "cpu_avg_pct": cpu_avg,
                        "ram_avg_pct": mem_avg,
                        "io_avg_iops": io_avg,
                        "classification": classification,
                    },
                ))
            except Exception as e:
                logger.warning("AI insight failed for %s: %s", server.name, e)

        # Compute suggested (smaller) flavor for overprovisioned/idle VMs
        suggested_flavor = None
        if classification in ("overprovisioned", "idle") and vcpus > 0 and ram_mb > 0:
            import math as _math
            need_vcpus = max(1, _math.ceil((cpu_avg or 5) / 100 * vcpus * 1.5))
            need_ram   = max(512, _math.ceil((mem_avg or 5) / 100 * ram_mb * 1.5))
            for f in all_flavors:
                if (f["vcpus"] >= need_vcpus and f["ram_mb"] >= need_ram
                        and (f["vcpus"] < vcpus or f["ram_mb"] < ram_mb)):
                    suggested_flavor = f
                    break

        recommendations.append({
            "server_id":    uuid,
            "server_name":  server.name,
            "server_status": server.status,
            "project_id":   server.project_id,
            "tenant_name":  meta.get("project_name"),
            "hypervisor":   meta.get("host_name"),
            "current_flavor":   {"name": flavor_name, "vcpus": vcpus, "ram_mb": ram_mb},
            "suggested_flavor": suggested_flavor,
            "classification": classification,
            "risk":           risk,
            "cpu_avg_pct":    cpu_avg,
            "mem_avg_pct":    mem_avg,
            "io_avg_iops":    io_avg,
            "cpu_series":     cpu_series,
            "mem_series":     mem_series,
            "io_series":      io_series,
            "analysis":       analysis,
        })

    db.cache_set("rightsizing:recommendations", recommendations)
    by_class = {}
    for r in recommendations:
        by_class.setdefault(r["classification"], 0)
        by_class[r["classification"]] += 1
    logger.info("Right-sizing complete: %s", by_class)


# ── Anomaly Detection (AI — slow) ─────────────────────────────────────────────

ANOMALY_METRICS = {
    "cpu_throttle":  "avg by (domain) (pcd:vm_cpu_throttling_percentage)",
    "mem_usage_pct": "avg by (domain) (pcd:vm_mem_usage / pcd:vm_mem_total * 100)",
    "read_iops":     "sum by (domain) (pcd:vm_read_iops)",
    "write_iops":    "sum by (domain) (pcd:vm_write_iops)",
}

LOOKBACK_HOURS = 24


def _parse_findings(text: str) -> list[dict]:
    """Extract structured findings from AI analysis text."""
    import re
    findings = []
    severity_pattern = re.compile(r'\b(critical|high|medium|low)\b', re.IGNORECASE)
    vm_pattern = re.compile(
        r'\b('
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        r'|instance-[\w-]+'
        r'|vm-[\w-]+'
        r'|[\w][\w-]*-\d+'
        r')\b',
        re.IGNORECASE,
    )

    for line in text.split('\n'):
        line = line.strip().lstrip('•-*0123456789. ')
        if not line or len(line) < 20:
            continue
        sev_match = severity_pattern.search(line)
        vm_match  = vm_pattern.search(line)
        if sev_match:
            findings.append({
                "description": line,
                "severity":    sev_match.group(1).lower(),
                "instance":    vm_match.group(1) if vm_match else None,
            })
    return findings[:10]  # cap at 10


async def collect_anomaly() -> None:
    from app.config import settings as _settings
    if not getattr(_settings, "ai_anomaly_enabled", True):
        logger.info("Anomaly AI analysis disabled — skipping.")
        return
    logger.info("Collecting anomaly analysis (AI)…")
    ai = get_ai_provider()
    from app.services.notifications import send_alert

    end = datetime.utcnow()
    start = end - timedelta(hours=LOOKBACK_HOURS)

    # Collect PCD-native metrics
    metric_results = await asyncio.gather(*[
        prometheus_client.query_range(query, start, end, step="15m")
        for query in ANOMALY_METRICS.values()
    ], return_exceptions=True)

    # Build summary stats per domain for AI context
    metric_data: dict = {}
    for name, result in zip(ANOMALY_METRICS.keys(), metric_results):
        if isinstance(result, Exception):
            metric_data[name] = []
            continue
        # Aggregate: max value per domain
        domain_maxes = {}
        for series in result:
            d = series.get("metric", {}).get("domain", "unknown")
            vals = [float(v[1]) for v in series.get("values", []) if _math.isfinite(float(v[1]))]
            if vals:
                domain_maxes[d] = max(vals)
        metric_data[name] = domain_maxes

    # Replace UUID domain keys with VM names so the AI outputs human-readable names
    server_list, _ = db.cache_get("inventory:servers")
    uuid_to_name = {s["id"]: s["name"] for s in (server_list or [])}
    for metric_name in list(metric_data.keys()):
        if isinstance(metric_data[metric_name], dict):
            metric_data[metric_name] = {
                uuid_to_name.get(d, d): v
                for d, v in metric_data[metric_name].items()
            }

    analysis = _clean_analysis(await ai.analyze(
        f"You are analyzing {LOOKBACK_HOURS}-hour PCD cluster metrics. "
        "Identify anomalies, unusual spikes, or concerning patterns. "
        "For each finding state: affected VM/domain, metric name, severity (low/medium/high/critical), "
        "and a brief description. Start each finding on a new line with '- '. "
        "Focus only on genuine anomalies, not normal low utilization.",
        metric_data,
    ))

    findings = _parse_findings(analysis or "")

    # Belt-and-suspenders: replace any UUID that slipped through in the instance field
    import re as _re
    _uuid_re = _re.compile(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        _re.IGNORECASE,
    )
    for f in findings:
        if f.get("instance") and _uuid_re.match(f["instance"]):
            f["instance"] = uuid_to_name.get(f["instance"], f["instance"])

    high_sev = [f for f in findings if f["severity"] in ("high", "critical")]

    # Alert if high-severity findings and notifications are configured
    if high_sev:
        subject = f"{len(high_sev)} anomaly finding(s) detected"
        body    = f"PCD Ops detected {len(high_sev)} high-severity anomalies:\n\n" + \
                  "\n".join(f"• {f['description']}" for f in high_sev)
        await send_alert(subject, body, severity="high", findings=high_sev)

    db.cache_set("anomaly:latest", {
        "lookback_hours": LOOKBACK_HOURS,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "analysis": analysis,
        "findings": findings,
        "metric_summary": {k: len(v) for k, v in metric_data.items() if isinstance(v, dict)},
    })
    logger.info("Anomaly analysis collected. %d findings (%d high-severity).", len(findings), len(high_sev))
