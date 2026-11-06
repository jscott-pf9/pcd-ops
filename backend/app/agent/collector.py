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
import math as _math
from collections import Counter
from datetime import datetime, timedelta

from app.dependencies import get_ai_provider
from app.services import (
    capacity,
    db,
    local_metrics,
    metrics_catalog,
    overcommit,
    reclamation,
    rightsizing,
    server_groups,
    storage,
)
from app.services.openstack import get_connection
from app.services.prometheus import MetricsNotConfigured

logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_ips(addresses: dict) -> list[str]:
    ips = []
    for entries in (addresses or {}).values():
        for entry in entries:
            ips.append(entry.get("addr", ""))
    return ips


# ── Inventory ──────────────────────────────────────────────────────────────────

def _cinder_get(conn, path: str, default):
    """A Cinder API call whose failure (missing extension, policy) leaves just that field out."""
    try:
        r = conn.block_storage.get(path)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logger.debug("Cinder %s unavailable: %s", path, e)
        return default


def _cinder_storage(conn) -> dict:
    """Pools, volume types and their QoS, default, encryption and project access (blocking)."""
    pools = _cinder_get(conn, "/scheduler-stats/get_pools?detail=True", {}).get("pools", [])
    types = _cinder_get(conn, "/types?is_public=None", {}).get("volume_types", [])
    default = _cinder_get(conn, "/types/default", {}).get("volume_type", {}).get("id")
    qos = _cinder_get(conn, "/qos-specs", {}).get("qos_specs", [])
    qos_of_type = {}
    for q in qos:
        for a in _cinder_get(conn, f"/qos-specs/{q['id']}/associations", {}).get(
                "qos_associations", []):
            if a.get("association_type") == "volume_type":
                qos_of_type[a["id"]] = {"id": q["id"], "name": q.get("name"),
                                        "consumer": q.get("consumer"), "specs": q.get("specs")}
    extra = {}
    for t in types:
        enc = _cinder_get(conn, f"/types/{t['id']}/encryption", {})
        access = None
        if not t.get("os-volume-type-access:is_public", t.get("is_public", True)):
            access = [a["project_id"] for a in _cinder_get(
                conn, f"/types/{t['id']}/os-volume-type-access", {}).get("volume_type_access", [])]
        extra[t["id"]] = {"encrypted": bool(enc.get("provider") or enc.get("encryption_id")),
                          "access_projects": access}
    return {"pools": pools, "types": types, "default": default, "qos": qos_of_type,
            "extra": extra}


def _image_kind(props: dict) -> dict:
    """Snapshots in Glance: Nova instance snapshots carry image_type=snapshot; snapshots of
    volume-backed VMs carry a block_device_mapping (the data is in Cinder snapshots)."""
    if props.get("block_device_mapping"):
        kind, snap = "snapshot", "volume-backed"
    elif props.get("image_type") == "snapshot":
        kind, snap = "snapshot", "instance"
    else:
        kind, snap = "image", None
    return {"kind": kind, "snapshot_type": snap, "base_image_ref": props.get("base_image_ref"),
            "instance_uuid": props.get("instance_uuid")}


def _volume_types(cinder: dict, volumes: list[dict]) -> list[dict]:
    out = []
    for t in cinder["types"]:
        specs = t.get("extra_specs") or {}
        mine = [v for v in volumes if v["volume_type"] in (t["name"], t["id"])]
        extra = cinder["extra"].get(t["id"], {})
        out.append({
            "id": t["id"],
            "name": t["name"],
            "description": t.get("description"),
            "public": t.get("os-volume-type-access:is_public", t.get("is_public", True)),
            "default": t["id"] == cinder["default"],
            "backend": specs.get("volume_backend_name"),
            "extra_specs": specs,
            "qos": cinder["qos"].get(t["id"]),
            "encrypted": extra.get("encrypted", False),
            "access_projects": extra.get("access_projects"),
            "volumes": len(mine),
            "volume_gb": sum(v["size_gb"] or 0 for v in mine),
        })
    return sorted(out, key=lambda t: t["name"])


async def collect_inventory() -> None:
    logger.info("Collecting inventory…")
    conn = get_connection()

    (servers, hypervisors, volumes, networks, tenants,
     floating_ips, images, security_groups, ports, flavors_raw, keypairs_raw,
     aggregates, groups_raw, cinder) = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.compute.hypervisors(details=True))),
        asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.network.networks())),
        asyncio.to_thread(lambda: list(conn.identity.projects())),
        asyncio.to_thread(lambda: list(conn.network.ips())),
        asyncio.to_thread(lambda: list(conn.image.images())),
        asyncio.to_thread(lambda: list(conn.network.security_groups())),
        # VM ports: device_owner is compute:<availability zone>, e.g. compute:nova
        asyncio.to_thread(lambda: [p for p in conn.network.ports()
                                   if (p.device_owner or "").startswith("compute:")]),
        asyncio.to_thread(lambda: list(conn.compute.flavors())),
        asyncio.to_thread(lambda: list(conn.compute.keypairs())),
        asyncio.to_thread(lambda: list(conn.compute.aggregates())),
        asyncio.to_thread(lambda: list(conn.compute.server_groups(all_projects=True))),
        asyncio.to_thread(_cinder_storage, conn),
    )

    _group_of = {
        m: {"id": g.id, "name": g.name} for g in groups_raw for m in (g.member_ids or [])
    }
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
            "security_groups": sorted({g.get("name") for g in (s.security_groups or [])
                                       if g.get("name")}),
            "server_group": _group_of.get(s.id),
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

    # ── Hypervisor details that Nova 2.88 dropped ───────────────────────────────
    # cpu_info, memory_mb, vcpus and local_gb are gone from the API since microversion
    # 2.88, which openstacksdk negotiates; 2.87 still returns them, for all hosts at once.
    def _legacy_detail() -> dict[str, dict]:
        r = conn.compute.get("/os-hypervisors/detail", microversion="2.87")
        r.raise_for_status()
        return {str(d.get("id")): d for d in r.json().get("hypervisors", [])}

    try:
        _hyp_detail = await asyncio.to_thread(_legacy_detail)
    except Exception as e:
        logger.warning("Hypervisor details (microversion 2.87) unavailable: %s", e)
        _hyp_detail = {}

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
        raw = _hyp_detail.get(str(h.id), {}).get("cpu_info") or getattr(h, "cpu_info", None)
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
        hw    = _hw_by_host.get(h.name, {})
        old   = _hyp_detail.get(str(h.id), {})
        # The host's own lscpu when SSH works; Nova's view otherwise
        sockets = hw.get("cpu_sockets") or topo.get("sockets")
        cores   = hw.get("cpu_cores") or topo.get("cores")
        threads = hw.get("cpu_threads") or topo.get("threads")
        logical = (sockets * cores * threads) if (sockets and cores and threads) else None

        ssh_ok          = (hw.get("connected") if h.name in _ssh_attempted else None)
        nic_count       = hw.get("nic_count")
        ram_mb_ssh      = hw.get("ram_mb")
        os_version      = hw.get("os_version")
        pending_patches = hw.get("pending_patches")

        svc_host = (h.service_details or {}).get("host")
        hyp_records.append({
            "id":               h.id,
            "hostname":         h.name,
            "state":            h.state,
            "status":           h.status,
            "host_ip":          h.host_ip,
            # Nova's compute service host: in PCD, the host UUID that pcd:* metrics carry
            "service_host":     svc_host,
            "aggregates":       sorted(a.name for a in aggregates
                                       if svc_host in (a.hosts or []) or h.name in (a.hosts or [])),
            # Physical specs
            "cpu_vendor":       ci.get("vendor"),
            # Nova has libvirt's CPU model name (e.g. "EPYC-Rome-v5"); lscpu has the real one
            "cpu_model":        hw.get("cpu_model") or ci.get("model"),
            "cpu_arch":         ci.get("arch"),
            "cpu_sockets":      sockets,
            "cpu_cores":        cores,
            "cpu_threads":      threads,
            "cpu_logical":      logical,
            # Usable by Linux (MemTotal); installed DIMMs are more (firmware, iGPU, crash kernel)
            "memory_mb_total":  h.memory_size or old.get("memory_mb") or ram_mb_ssh or None,
            "memory_mb_installed": hw.get("ram_mb_installed"),
            "nic_count":        nic_count,
            "ssh_ok":           ssh_ok,
            "os_version":       os_version,
            "pending_patches":  pending_patches,
            "hypervisor_type":  getattr(h, "hypervisor_type", None),
            "hypervisor_version": getattr(h, "hypervisor_version", None),
            # Utilisation (Nova 2.88+ may omit; derived from server data as fallback)
            "vcpus_total":      h.vcpus or old.get("vcpus") or logical or None,
            "vcpus_used":       h.vcpus_used if h.vcpus_used is not None else _hyp_vcpus.get(h.name),
            "memory_mb_used":   h.memory_used if h.memory_used is not None else _hyp_mem.get(h.name),
            "disk_gb_total":    h.local_disk_size or old.get("local_gb") or None,
            "disk_gb_used":     h.local_disk_used or old.get("local_gb_used") or None,
            "running_vms":      h.running_vms if h.running_vms is not None else _hyp_vms.get(h.name, 0),
        })
    db.cache_set("inventory:hypervisors", hyp_records)
    # PCD Ops' own metrics store scrapes every hypervisor; keep its target list current.
    local_metrics.write_targets(hyp_records)

    host_names = {h["service_host"]: h["hostname"] for h in hyp_records if h["service_host"]}
    pools = [storage.pool_record(p, host_names) for p in cinder["pools"]]
    backend_of_pool = {p["name"]: p["backend"] for p in pools}
    vol_records = [
        {
            "id": v.id,
            "name": v.name or "(unnamed)",
            "size_gb": v.size,
            "status": v.status,
            "volume_type": v.volume_type,
            "host": v.host,
            "backend": backend_of_pool.get(v.host or ""),
            # VMs only: Glance's cinder store attaches image volumes with no server ("glance_store")
            "attached_to": [a["server_id"] for a in (v.attachments or []) if a.get("server_id")],
            # The VM disk each attachment is (/dev/vdb → libvirt's target_device "vdb")
            "attachments": [{"server_id": a.get("server_id"), "device": a.get("device")}
                            for a in (v.attachments or [])],
            "bootable": str(v.is_bootable).lower() == "true",
            "project_id": v.project_id,
            "created_at": v.created_at,
        }
        for v in volumes
    ]
    db.cache_set("inventory:volumes", vol_records)

    type_records = _volume_types(cinder, vol_records)
    db.cache_set("inventory:storage_types", type_records)
    backends = storage.group_pools(pools, vol_records, type_records)
    db.cache_set("inventory:storage_backends", backends)
    # Cinder only reports the current capacity: keep its history in PCD Ops' metrics store.
    await local_metrics.push(storage.samples(backends) + storage.volume_disks(vol_records))

    server_by_id = {s.id: s for s in servers}
    group_records = []
    for g in groups_raw:
        members = [
            {"id": m, "name": getattr(server_by_id.get(m), "name", None),
             "host": getattr(server_by_id.get(m), "hypervisor_hostname", None),
             "status": getattr(server_by_id.get(m), "status", None)}
            for m in (g.member_ids or [])
        ]
        policy = g.policy or (g.policies or [None])[0]
        rules = g.rules or {}
        group_records.append({
            "id": g.id,
            "name": g.name,
            "policy": policy,
            "rules": rules,
            "project_id": g.project_id,
            "members": members,
            "hosts": sorted({m["host"] for m in members if m["host"]}),
            **server_groups.check(policy, members, rules),
        })
    db.cache_set("inventory:server_groups", sorted(group_records, key=lambda g: g["name"] or ""))

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
    # Volumes made from an image use it too (boot-from-volume VMs show no image in Nova)
    volume_image_use = Counter((v.volume_image_metadata or {}).get("image_id") for v in volumes)
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
            "used_by_volumes": volume_image_use.get(img.id, 0),
            **_image_kind({**(img.properties or {}), "instance_uuid": img.instance_uuid}),
            "min_disk_gb":  img.min_disk,
            "min_ram_mb":   img.min_ram,
            "container_format": img.container_format,
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
                "remote_group_id":  r.get("remote_group_id"),
                "description":      r.get("description") or "",
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

    flavor_vms: dict[str, int] = {}
    for s in servers:
        name = (s.flavor or {}).get("original_name")
        if name:
            flavor_vms[name] = flavor_vms.get(name, 0) + 1
    db.cache_set("inventory:flavors", sorted([
        {"id": f.id, "name": f.name, "vcpus": f.vcpus, "ram_mb": f.ram, "disk_gb": f.disk or 0,
         "ephemeral_gb": f.ephemeral or 0, "swap_mb": f.swap or 0, "public": f.is_public,
         "disabled": bool(f.is_disabled), "rxtx_factor": f.rxtx_factor,
         "description": f.description, "extra_specs": f.extra_specs or {},
         "vms": flavor_vms.get(f.name, 0)}
        for f in flavors_raw
    ], key=lambda f: (f["vcpus"], f["ram_mb"])))

    db.cache_set("inventory:keypairs", sorted([
        {"name": kp.name, "fingerprint": kp.fingerprint or "", "type": getattr(kp, "type", "ssh") or "ssh"}
        for kp in keypairs_raw
    ], key=lambda k: k["name"]))

    # Aggregates name hosts by Nova's compute service host (in PCD, the host UUID)
    hyp_by_host = {h["service_host"]: h for h in hyp_records if h["service_host"]}
    hyp_by_host.update({h["hostname"]: h for h in hyp_records})
    agg_records = []
    for agg in aggregates:
        meta = {k: v for k, v in (agg.metadata or {}).items() if k != "availability_zone"}
        members = [hyp_by_host.get(h) for h in agg.hosts or []]
        known = [h for h in members if h]
        agg_records.append({
            "id":                agg.id,
            "name":              agg.name,
            "kind":              "cluster" if str(meta.get("pf9-managed")).lower() == "true"
                                 else "aggregate",
            "availability_zone": agg.availability_zone,
            "hosts": [
                {"service_host": h, "hypervisor_id": m and m["id"], "hostname": m and m["hostname"]}
                for h, m in zip(agg.hosts or [], members)
            ],
            "vms":               sum(h["running_vms"] or 0 for h in known),
            "vcpus_total":       sum(h["vcpus_total"] or 0 for h in known),
            "vcpus_used":        sum(h["vcpus_used"] or 0 for h in known),
            "memory_mb_total":   sum(h["memory_mb_total"] or 0 for h in known),
            "memory_mb_used":    sum(h["memory_mb_used"] or 0 for h in known),
            "metadata":          meta,
            "created_at":        agg.created_at,
            "updated_at":        agg.updated_at,
        })
    db.cache_set("inventory:clusters", sorted(agg_records, key=lambda a: a["name"]))
    # Allocation is only reported now; keep its history in the metrics store.
    await local_metrics.push([
        (f"pcd_ops_cluster_{k}", {"aggregate": str(a["id"])}, float(a[field] or 0) * scale)
        for a in agg_records
        for k, field, scale in (
            ("vcpus_used", "vcpus_used", 1), ("vcpus_total", "vcpus_total", 1),
            ("memory_used_bytes", "memory_mb_used", 1024**2),
            ("memory_total_bytes", "memory_mb_total", 1024**2), ("vms", "vms", 1))
    ])

    active = sum(1 for s in servers if s.status == "ACTIVE")
    # From the records: Nova 2.88+ left these out of the hypervisor objects
    vcpus_used = sum(h["vcpus_used"] or 0 for h in hyp_records)
    vcpus_total = sum(h["vcpus_total"] or 0 for h in hyp_records)
    mem_used_gb = sum(h["memory_mb_used"] or 0 for h in hyp_records) // 1024
    mem_total_gb = sum(h["memory_mb_total"] or 0 for h in hyp_records) // 1024
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

IDLE_REFRESH_S = 3600   # idle VMs are worked out from up to weeks of data: at most hourly


async def _idle_stats(src: str | None) -> tuple[dict[str, dict], dict]:
    """95th percentile of each VM's CPU %, network bytes/s and IOPS over the idle window, by
    server id, and the rule's settings. Recomputed at most hourly or when the settings change."""
    from app.config import settings as _s
    days = _s.reclamation_idle_days
    rule = {"days": days, "cpu_pct": _s.reclamation_idle_cpu_pct,
            "net_kbps": _s.reclamation_idle_net_kbps, "iops": _s.reclamation_idle_iops,
            "source": src}
    cached, at = db.cache_get("reclamation:idle_stats")
    if (cached and at and cached.get("key") == rule
            and (datetime.utcnow() - datetime.fromisoformat(at)).total_seconds() < IDLE_REFRESH_S):
        return cached["stats"], cached["rule"]
    key = dict(rule)
    rule["note"] = None
    stats: dict[str, dict] = {}
    if src is None:
        rule["note"] = ("No VM metrics: PCD Ops' metrics store has no data and no Grafana "
                        "token is set.")
    elif src == "local" and metrics_catalog._collected_days() < days:
        rule["note"] = (f"Needs {days} days of metrics; PCD Ops' store has "
                        f"{metrics_catalog._collected_days():.1f}.")
    elif src == "pcd" and days > metrics_catalog.PCD_RETENTION_DAYS:
        rule["note"] = (f"PCD's Grafana keeps {metrics_catalog.PCD_RETENTION_DAYS} days, less "
                        f"than the {days}-day window.")
    else:
        def p95(expr: str) -> str:
            return f"quantile_over_time(0.95, ({expr})[{days}d:1h])"
        vm = lambda m: metrics_catalog.promql("vm", m, src)  # noqa: E731
        exprs = {"cpu_pct": vm("cpu_pct"), "iops": vm("disk_iops"),
                 "net_bps": f"({vm('net_rx_bps')}) + ({vm('net_tx_bps')})"}
        prom = metrics_catalog.client(src)
        results = await asyncio.gather(*(prom.query(p95(e)) for e in exprs.values()),
                                       return_exceptions=True)
        for name, res in zip(exprs, results):
            if isinstance(res, Exception):
                rule["note"] = f"Couldn't query VM metrics: {res}"
                stats = {}
                break
            for row in res:
                dom = row["metric"].get("domain")
                try:
                    v = float(row["value"][1])
                except (TypeError, ValueError):
                    continue
                if dom and _math.isfinite(v):
                    stats.setdefault(dom, {})[name] = round(v, 3)
    db.cache_set("reclamation:idle_stats", {"key": key, "stats": stats, "rule": rule})
    return stats, rule


async def _libvirt_domains(
        src: str | None) -> tuple[list[dict] | None, set[str] | None, str | None]:
    """Every domain each hypervisor's libvirt exporter reports, and the hypervisors whose
    exporter answered its last scrape. Only PCD Ops' own store labels them by hypervisor."""
    if src != "local":
        return None, None, ("Comparing PCD's VMs with what the hosts run needs PCD Ops' "
                            "metrics store.")
    try:
        meta, up = await asyncio.gather(
            metrics_catalog.local_client.query("libvirt_domain_info_meta"),
            metrics_catalog.local_client.query('up{job="libvirt"}'),
        )
    except Exception as e:
        return None, None, f"Couldn't read libvirt data from PCD Ops' metrics store: {e}"
    hosts_up = {r["metric"]["hypervisor_id"] for r in up
                if r["value"][1] == "1" and r["metric"].get("hypervisor_id")}
    return [r["metric"] for r in meta if r["metric"].get("domain")], hosts_up, None


def _deleted_users(conn, user_ids: set[str]) -> set[str]:
    """User IDs Keystone says don't exist. Looked up one by one: SSO users may be missing from a
    user list but still resolve by ID."""
    from openstack.exceptions import ResourceNotFound
    gone = set()
    for uid in user_ids:
        try:
            conn.identity.get_user(uid)
        except ResourceNotFound:
            gone.add(uid)
        except Exception as e:  # can't tell: don't call it deleted
            logger.debug("User lookup %s failed: %s", uid, e)
    return gone


async def collect_reclamation() -> None:
    """Reclamation & Warnings: what could be freed, and what looks wrong
    (services/reclamation.py has the rules)."""
    logger.info("Collecting reclamation candidates…")
    conn = get_connection()
    run_start = datetime.utcnow().isoformat()
    notes: dict[str, str] = {}

    async def optional(name: str, fn):
        try:
            return await asyncio.to_thread(fn)
        except Exception as e:
            logger.warning("Reclamation: couldn't list %s: %s", name, e)
            notes[name] = f"Couldn't list {name} from PCD: {e}"
            return None

    (servers_raw, volumes_raw, fips_raw, projects_raw, ports_raw, routers_raw, networks_raw,
     images_raw, groups_raw, sgs_raw, snaps_raw, roles_raw) = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True))),
        optional("floating IPs", lambda: list(conn.network.ips())),
        optional("projects", lambda: list(conn.identity.projects())),
        optional("ports", lambda: list(conn.network.ports())),
        optional("routers", lambda: list(conn.network.routers())),
        optional("networks", lambda: list(conn.network.networks())),
        optional("images", lambda: list(conn.image.images())),
        optional("server groups", lambda: list(conn.compute.server_groups(all_projects=True))),
        optional("security groups", lambda: list(conn.network.security_groups())),
        optional("snapshots", lambda: list(conn.block_storage.snapshots(all_projects=True))),
        optional("role assignments", lambda: list(conn.identity.role_assignments())),
    )

    servers = [reclamation.server_record(s) for s in servers_raw]
    volumes = [reclamation.volume_record(v) for v in volumes_raw]
    fips = None if fips_raw is None else [{
        "id": f.id, "floating_ip_address": f.floating_ip_address, "project_id": f.project_id,
        "port_id": f.port_id, "router_id": f.router_id, "updated_at": f.updated_at,
    } for f in fips_raw]
    ports = None if ports_raw is None else [reclamation.port_record(p) for p in ports_raw]
    routers = None if routers_raw is None else [{
        "id": r.id, "name": r.name, "status": r.status, "project_id": r.project_id,
        "gateway": bool(r.external_gateway_info),
    } for r in routers_raw]
    networks = None if networks_raw is None else [{
        "id": n.id, "name": n.name, "project_id": n.project_id, "shared": bool(n.is_shared),
        "external": bool(n.is_router_external), "subnet_ids": n.subnet_ids or [],
        "created_at": n.created_at,
    } for n in networks_raw]
    images = None if images_raw is None else [{
        "id": i.id, "name": i.name or "(unnamed)", "visibility": i.visibility, "status": i.status,
        "size_gb": round((i.size or 0) / (1024**3), 2), "is_protected": bool(i.is_protected),
        "owner": i.owner, "created_at": i.created_at, "updated_at": i.updated_at,
        **_image_kind({**(i.properties or {}), "instance_uuid": i.instance_uuid}),
    } for i in images_raw]
    groups = None if groups_raw is None else [{
        "id": g.id, "name": g.name, "project_id": g.project_id,
        "policy": g.policy or (g.policies or [None])[0], "members": g.member_ids or [],
    } for g in groups_raw]

    # VMs against what the hosts run, and who owns them
    src = await metrics_catalog.source()
    domains, hosts_up, libvirt_note = await _libvirt_domains(src)
    if libvirt_note:
        notes["libvirt"] = libvirt_note
    hyps, _ = db.cache_get("inventory:hypervisors")
    host_of = {}
    for h in hyps or []:
        for key in (h.get("service_host"), h.get("hostname")):
            if key:
                host_of[key] = str(h["id"])
    project_ids = None if projects_raw is None else {p.id for p in projects_raw}
    deleted_users = await asyncio.to_thread(
        _deleted_users, conn, {s["user_id"] for s in servers if s["user_id"]})
    orphans = reclamation.orphaned_vms(
        servers, domains, hosts_up, host_of,
        project_ids if project_ids is not None else {s["project_id"] for s in servers},
        deleted_users)
    idle_stats, idle_rule = await _idle_stats(await metrics_catalog.source(
        min_days=idle_rule_days()))
    if idle_rule["note"]:
        notes["idle"] = idle_rule["note"]
    th = {"cpu_pct": idle_rule["cpu_pct"], "net_kbps": idle_rule["net_kbps"],
          "iops": idle_rule["iops"],
          "window_start": (datetime.utcnow() - timedelta(days=idle_rule["days"])).isoformat()}

    cats: dict[str, list[dict] | None] = {
        "stopped_servers": reclamation.stopped_servers(servers, volumes),
        "idle_servers": reclamation.idle_servers(servers, idle_stats, th),
        "orphaned_vms": orphans,
        "empty_server_groups": None if groups is None else reclamation.empty_server_groups(groups),
        "unattached_volumes": reclamation.unattached_volumes(
            volumes, None if images is None else {i["id"] for i in images}),
        "unused_images": None if images is None else reclamation.unused_images(
            images, reclamation.image_use(servers, volumes, domains)),
        "unused_floating_ips": None if fips is None else reclamation.unused_floating_ips(fips),
        "orphaned_ports": None if ports is None or routers is None else reclamation.orphaned_ports(
            ports, {s["id"] for s in servers}, {r["id"] for r in routers}),
        "unused_routers": None if None in (routers, ports, fips) else reclamation.unused_routers(
            routers, ports, fips),
        "unused_networks": None if None in (networks, ports) else reclamation.unused_networks(
            networks, ports),
    }
    if None in (projects_raw, ports_raw, routers_raw, networks_raw, images_raw, sgs_raw,
                snaps_raw, fips_raw):
        cats["empty_tenants"] = None
    else:
        owned = Counter()
        for coll in (servers, volumes, fips, ports, routers, networks):
            owned.update(r["project_id"] for r in coll)
        owned.update(s.project_id for s in snaps_raw)
        owned.update(i["owner"] for i in images)
        owned.update(g.project_id for g in sgs_raw if g.name != "default")
        roles = Counter((a.scope or {}).get("project", {}).get("id") for a in roles_raw or [])
        cats["empty_tenants"] = reclamation.empty_tenants([{
            "id": p.id, "name": p.name, "enabled": p.is_enabled, "description": p.description,
            "domain_id": p.domain_id, "is_domain": p.is_domain,
        } for p in projects_raw], owned, roles)

    data: dict = {"notes": notes, "idle_rule": idle_rule,
                  "orphan_check": {"source": src, "hosts_compared": len(hosts_up or ())}}
    for name, items in cats.items():
        if items is None:   # its source failed: keep first-seen ages for next time
            data[name] = []
            notes.setdefault(name, "Not checked this time: a list it needs couldn't be read.")
            continue
        first = db.seen_update(name, [c["id"] for c in items])
        for c in items:
            c["first_seen"] = first.get(c["id"])
            c["since"] = reclamation.earliest(c["first_seen"], c.pop("since_hint", None))
        data[name] = items
    # A VM that looks orphaned for one run only is usually mid-migration or just deleted.
    pending = [c for c in data["orphaned_vms"] if (c["first_seen"] or "") >= run_start]
    data["orphaned_vms"] = [c for c in data["orphaned_vms"] if c not in pending]
    data["orphan_check"]["pending"] = len(pending)

    db.cache_set("reclamation:candidates", data)
    logger.info("Reclamation: %s", {k: len(data[k]) for k in reclamation.CATEGORIES})


def idle_rule_days() -> int:
    from app.config import settings as _s
    return _s.reclamation_idle_days


# ── Capacity ───────────────────────────────────────────────────────────────────

# ── Host and VM metrics ───────────────────────────────────────────────────────

async def collect_host_metrics() -> None:
    """Current CPU, memory, disk and network per hypervisor and per VM, from PCD Ops' own
    metrics store or else PCD's Grafana (services/metrics_catalog.py)."""
    src = await metrics_catalog.source()
    if src is None:
        logger.info("Host metrics skipped: no local metrics store and no Grafana token.")
        return
    hyps, _ = db.cache_get("inventory:hypervisors")
    # The source's key for each hypervisor → Nova id.
    nova_id = {(h["id"] if src == "local" else h.get("service_host")): h["id"] for h in hyps or []}
    host_vals, vms, health = await asyncio.gather(
        metrics_catalog.instant("host", src),
        metrics_catalog.instant("vm", src),
        metrics_catalog.host_health(src),
    )
    hosts: dict[str, dict] = {}
    for key in set(host_vals) | set(health):
        if key in nova_id:
            hosts[nova_id[key]] = {**host_vals.get(key, {}), **health.get(key, {})}
    db.cache_set("metrics:hosts", {"source": src, "hosts": hosts})
    db.cache_set("metrics:vms", {"source": src, "vms": vms})
    logger.info("Host metrics from %s: %d hosts, %d VMs", src, len(hosts), len(vms))


# ── Overcommit ─────────────────────────────────────────────────────────────────

OVERCOMMIT_DAYS = 7
OVERCOMMIT_LOAD_REFRESH_S = 3600   # percentiles over days of data: at most hourly


def _placement(conn, hyp_ids: list[str]) -> dict[str, dict]:
    """Placement's VCPU/MEMORY_MB inventories and usages per compute node (its resource
    provider UUID is the Nova hypervisor id). A host Placement doesn't know is left out."""
    def get(path: str) -> dict | None:
        r = conn.placement.get(path)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    out = {}
    for hid in hyp_ids:
        inv = get(f"/resource_providers/{hid}/inventories")
        use = inv and get(f"/resource_providers/{hid}/usages")
        if inv and use:
            out[hid] = {"inventories": inv["inventories"], "usages": use["usages"]}
        else:
            logger.debug("No Placement resource provider for hypervisor %s", hid)
    return out


async def _overcommit_load(src: str | None, hyps: list[dict]) -> tuple[dict, dict, dict]:
    """95th percentile of host CPU %, memory %, swap-in and each VM's CPU wait over up to
    OVERCOMMIT_DAYS: ({hypervisor id: {...}}, {server id: wait %}, {source, hours, note}).
    Recomputed at most hourly."""
    cached, at = db.cache_get("capacity:overcommit_load")
    if (cached and at and cached["info"].get("source") == src
            and (datetime.utcnow() - datetime.fromisoformat(at)).total_seconds()
            < OVERCOMMIT_LOAD_REFRESH_S):
        return cached["hosts"], cached["waits"], cached["info"]
    info: dict = {"source": src, "hours": 0, "note": None}
    hosts: dict[str, dict] = {}
    waits: dict[str, float] = {}
    if src is None:
        info["note"] = ("No load data: PCD Ops' metrics store has no data and no Grafana token "
                        "is set, so hosts are judged on allocation only.")
    else:
        days = OVERCOMMIT_DAYS
        if src == "local":
            days = min(days, metrics_catalog._collected_days())
        hours = max(1, int(days * 24))
        info["hours"] = hours
        if hours < OVERCOMMIT_DAYS * 24:
            span = "hour" if hours == 1 else f"{hours} hours"
            info["note"] = (f"Load is the 95th percentile over the {span} of metrics so far; "
                            f"it will cover {OVERCOMMIT_DAYS} days.")
        # Coarse steps over a long window; fine ones while the store is new, or none fall in it
        step = "1h" if hours >= 48 else "5m" if hours >= 6 else "1m"
        nova_id = {(h["id"] if src == "local" else h.get("service_host")): h["id"] for h in hyps}
        prom = metrics_catalog.client(src)
        queries = {("host", m): metrics_catalog.promql("host", m, src)
                   for m in ("cpu_pct", "mem_pct", "swap_in_pps")}
        queries[("vm", "cpu_wait_pct")] = metrics_catalog.promql("vm", "cpu_wait_pct", src)
        queries = {k: q for k, q in queries.items() if q}
        results = await asyncio.gather(
            *(prom.query(f"quantile_over_time(0.95, ({q})[{hours}h:{step}])")
              for q in queries.values()), return_exceptions=True)
        for (group, m), res in zip(queries, results):
            if isinstance(res, Exception):
                info["note"] = f"Couldn't query load ({m}): {res}"
                continue
            for row in res:
                try:
                    v = float(row["value"][1])
                except (TypeError, ValueError):
                    continue
                if not _math.isfinite(v):
                    continue
                if group == "vm":
                    if row["metric"].get("domain"):
                        waits[row["metric"]["domain"]] = round(v, 3)
                elif (hid := nova_id.get(row["metric"].get(metrics_catalog.KEY[("host", src)]))):
                    hosts.setdefault(hid, {})[m] = round(v, 2)
    db.cache_set("capacity:overcommit_load", {"hosts": hosts, "waits": waits, "info": info})
    return hosts, waits, info


async def collect_overcommit() -> None:
    """CPU and memory overcommit per host and cluster: Placement's allocation against real
    load (services/overcommit.py). Runs after inventory, whose hosts and VMs it reads."""
    hyps, _ = db.cache_get("inventory:hypervisors")
    clusters, _ = db.cache_get("inventory:clusters")
    servers, _ = db.cache_get("inventory:servers")
    if not hyps:
        return
    conn = get_connection()
    src = await metrics_catalog.source()
    placement, (load, waits, info) = await asyncio.gather(
        asyncio.to_thread(_placement, conn, [h["id"] for h in hyps]),
        _overcommit_load(src, hyps),
    )
    hyp_of_name = {h["hostname"]: h["id"] for h in hyps}
    vms = [{"id": s["id"], "name": s["name"], "vcpus": s.get("flavor_vcpus"),
            "host": hyp_of_name.get(s.get("hypervisor_hostname"))}
           for s in servers or [] if s.get("status") == "ACTIVE"]
    hosts = overcommit.host_rows(hyps, placement, load, overcommit.vm_wait_by_host(vms, waits))
    db.cache_set("capacity:overcommit", {
        "hosts": hosts,
        "clusters": overcommit.cluster_rows(clusters or [], hosts),
        "totals": overcommit.totals(hosts),
        "load": info,
        "thresholds": overcommit.THRESHOLDS,
    })
    t = overcommit.totals(hosts)
    logger.info("Overcommit: %d hosts (CPU %s; memory %s)", len(hosts), t["cpu_counts"], t["mem_counts"])


async def collect_capacity() -> None:
    """What the cloud can allocate and what is allocated (services/capacity.py): Placement for
    vCPUs and RAM, Cinder's backends for storage. Runs after inventory and overcommit, whose
    results it reads, and keeps the history in PCD Ops' metrics store for the trends."""
    oc, _ = db.cache_get("capacity:overcommit")
    hyps, _ = db.cache_get("inventory:hypervisors")
    backends, _ = db.cache_get("inventory:storage_backends")
    s = capacity.summary((oc or {}).get("totals"), hyps or [], backends or [])
    db.cache_set("capacity:summary", s)
    await local_metrics.push(capacity.samples(s))
    logger.info("Capacity: %.0f/%s vCPUs, %.0f/%s GB RAM, %.0f/%s GB storage",
                s["vcpus"]["used"], s["vcpus"]["total"], s["ram_gb"]["used"],
                s["ram_gb"]["total"], s["storage_gb"]["used"], s["storage_gb"]["total"])


# ── Capacity Trends & Forecast ────────────────────────────────────────────────

TREND_DAYS = 30            # from PCD Ops' metrics store, as far back as it has the history
TREND_STEP = "1h"          # collect_capacity writes every 15 minutes
TREND_MIN_POINTS = 3


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
    """Allocation against capacity over up to TREND_DAYS, from the history collect_capacity
    keeps in PCD Ops' metrics store, with a linear forecast of when each runs out."""
    logger.info("Collecting capacity trends…")
    ai = get_ai_provider()

    end = datetime.utcnow()
    days = min(TREND_DAYS, max(1.0, metrics_catalog._collected_days()))
    start = end - timedelta(days=days)
    qstep = TREND_STEP if days >= 2 else "15m"   # while the history is short, every sample
    note = None
    if not await metrics_catalog._local_ok():
        note = ("Capacity history is kept in PCD Ops' metrics store, which is off or has no "
                "data yet.")
    prom = metrics_catalog.local_client

    def q(series: str, resource: str) -> str:
        return f'max(last_over_time({series}{{resource="{resource}"}}))'

    trends: dict = {}
    for resource in ("vcpus", "ram_gb", "storage_gb"):
        if note:
            trends[resource] = {"series": [], "trend": None, "forecast": None}
            continue
        try:
            used_series, total_series = await asyncio.gather(
                prom.query_range(q("pcd_ops_capacity_used", resource), start, end, step=qstep),
                prom.query_range(q("pcd_ops_capacity_total", resource), start, end, step=qstep),
            )

            # Build aligned time-series list
            used_map  = {v[0]: float(v[1]) for r in used_series  for v in r.get("values", [])}
            total_map = {v[0]: float(v[1]) for r in total_series for v in r.get("values", [])}
            common_ts = sorted(set(used_map) & set(total_map))

            if len(common_ts) < TREND_MIN_POINTS:
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

    window = max(1, round(days))
    # AI interpretation
    forecast_summary = {
        r: {
            "current_pct": trends[r].get("latest", {}).get("pct"),
            "forecast": trends[r].get("forecast"),
            "slope_per_day": trends[r].get("trend", {}).get("slope_per_day") if trends[r].get("trend") else None,
        }
        for r in trends
    }
    analysis = None
    from app.config import settings as _settings
    if _settings.ai_capacity_enabled and not note:
        try:
            analysis = await ai.analyze(
                "You are analyzing OpenStack cluster capacity trends. "
                f"Based on the {window}-day allocation data below, identify: "
                "(1) resources trending toward saturation, "
                "(2) any concerning growth rates, "
                "(3) estimated runway before intervention is needed, "
                "(4) specific recommendations. Be concise and actionable.",
                forecast_summary,
            )
        except Exception as e:
            logger.warning("AI capacity analysis failed: %s", e)

    db.cache_set("capacity:trends", {
        "window_days": window,
        "note": note,
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
#   idle             — Reclamation's idle rule (services/reclamation.py: 95th-percentile
#                      CPU, network and IOPS under Settings' thresholds over its window)
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
RS_STEP     = "2h"   # ~84 data points over 7 days
RS_LOCAL_DAYS = 30            # with PCD Ops' own metrics store
RS_LOCAL_STEP = "6h"          # 120 points over 30 days
RS_LOCAL_MIN_DAYS = 7         # until the store has this much, use PCD's Grafana if set


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
    conn = get_connection()
    ai = get_ai_provider()

    # PCD Ops' own store once it has a week of data, looking back 30 days; else PCD's Grafana,
    # whose reduced pcd:* series are kept 14 days, looking back 7.
    src = await metrics_catalog.source(min_days=RS_LOCAL_MIN_DAYS)
    if src is None:
        raise MetricsNotConfigured("No VM metrics: PCD Ops' metrics store has no data yet and "
                                   "no Grafana token is set.")
    logger.info("Collecting right-sizing from %s metrics…", src)
    days, step = (RS_LOCAL_DAYS, RS_LOCAL_STEP) if src == "local" else (7, RS_STEP)
    end = datetime.utcnow()
    start = end - timedelta(days=days)
    prom = metrics_catalog.client(src)

    def _range(metric: str):
        return prom.query_range(metrics_catalog.promql("vm", metric, src), start, end, step=step)

    meta_raw, cpu_series_raw, mem_series_raw, io_series_raw = await asyncio.gather(
        prom.query("libvirt_domain_info_meta"),
        _range("cpu_pct"), _range("mem_pct"), _range("disk_iops"),
    )

    # Domain → metadata (instance_name, project_name, flavor; host_name from PCD, or our
    # hypervisor label locally)
    domain_meta: dict[str, dict] = {m["metric"]["domain"]: m["metric"] for m in meta_raw}

    # Build per-domain series maps for sparklines
    cpu_series_by_domain = {s["metric"]["domain"]: _series_from_range([s]) for s in cpu_series_raw if "domain" in s["metric"]}
    mem_series_by_domain = {s["metric"]["domain"]: _series_from_range([s]) for s in mem_series_raw if "domain" in s["metric"]}
    io_series_by_domain  = {s["metric"]["domain"]: _series_from_range([s]) for s in io_series_raw  if "domain" in s["metric"]}

    servers, flavors_raw = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.compute.flavors())),
    )

    # Flavors any project can resize to, smallest first so the first that fits is chosen
    all_flavors = sorted(
        [{"id": f.id, "name": f.name, "vcpus": f.vcpus, "ram_mb": f.ram,
          "extra_specs": getattr(f, "extra_specs", None) or {}}
         for f in flavors_raw if f.is_public is not False and not f.is_disabled],
        key=lambda f: (f["vcpus"], f["ram_mb"]),
    )
    hyps, _ = db.cache_get("inventory:hypervisors")
    hyp_of_name = {h["hostname"]: h["id"] for h in hyps or []}

    # Idle is Reclamation's rule, so both pages call the same VMs idle.
    recl, _ = db.cache_get("reclamation:candidates")
    idle_ids = {v["id"] for v in (recl or {}).get("idle_servers", [])}

    from app.config import settings as _settings
    ai_on = _settings.ai_rightsizing_enabled   # turned off for the rest of the run if AI fails
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
        elif uuid in idle_ids:
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
        if classification in _prompts and ai_on:
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
                # One failure (backend down or unreachable) would repeat for every VM, each
                # waiting out the timeout; classify the rest from metrics alone.
                logger.warning("AI insight failed for %s, skipping AI for the rest of this run: %s",
                               server.name, e)
                ai_on = False

        # The suggested flavor: smaller for spare capacity, bigger under pressure
        cur = {"vcpus": vcpus, "ram_mb": ram_mb}
        suggested_flavor = None
        if classification in ("overprovisioned", "idle"):
            suggested_flavor = rightsizing.smaller_flavor(cur, cpu_avg, mem_avg, all_flavors)
        elif classification in ("cpu-pressure", "memory-pressure"):
            suggested_flavor = rightsizing.larger_flavor(
                cur, cpu_avg, mem_avg, all_flavors,
                cpu_short=cpu_avg is not None and cpu_avg >= RS_CPU_HIGH,
                mem_short=mem_avg is not None and mem_avg >= RS_MEM_HIGH)

        recommendations.append({
            "server_id":    uuid,
            "server_name":  server.name,
            "server_status": server.status,
            "project_id":   server.project_id,
            "tenant_name":  meta.get("project_name"),
            "hypervisor":   meta.get("host_name") or meta.get("hypervisor"),
            "hypervisor_id": hyp_of_name.get(getattr(server, "hypervisor_hostname", None)),
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

# Name in the AI's context → metric in services/metrics_catalog.py
ANOMALY_METRICS = {
    "cpu_throttle":  "cpu_wait_pct",
    "mem_usage_pct": "mem_pct",
    "read_iops":     "read_iops",
    "write_iops":    "write_iops",
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

    src = await metrics_catalog.source(min_days=LOOKBACK_HOURS / 24)
    if src is None:
        raise MetricsNotConfigured("No VM metrics: PCD Ops' metrics store has no data yet and "
                                   "no Grafana token is set.")
    metric_results = await asyncio.gather(*[
        metrics_catalog.client(src).query_range(
            metrics_catalog.promql("vm", metric, src), start, end, step="15m")
        for metric in ANOMALY_METRICS.values()
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
