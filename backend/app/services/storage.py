"""Cinder storage backends: pools grouped into backends, with utilization.

Cinder reports capacity per pool (`host@backend#pool`). One backend can appear as several pools,
one per cinder-volume host. When those pools all report the same total and free space they are
one shared store (an NFS export mounted on every host): its capacity is counted once. Otherwise
the pools are separate stores and their capacity is summed.
"""

from __future__ import annotations

from collections import defaultdict

GB = 1024**3
SAME = 0.01  # pools within 1% of each other's total and free space are one shared store


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pool_record(pool: dict, host_names: dict[str, str]) -> dict:
    """One pool from GET /scheduler-stats/get_pools?detail=true: {name, capabilities}."""
    caps = pool.get("capabilities") or {}
    name = pool.get("name") or ""
    host = name.split("@", 1)[0]
    total, free = _num(caps.get("total_capacity_gb")), _num(caps.get("free_capacity_gb"))
    return {
        "name": name,
        "backend": caps.get("volume_backend_name") or name.split("@", 1)[-1].split("#", 1)[0],
        "host": host,
        "hostname": host_names.get(host),
        "protocol": caps.get("storage_protocol"),
        "vendor": caps.get("vendor_name"),
        "driver_version": caps.get("driver_version"),
        "state": caps.get("backend_state"),
        "total_gb": total,
        "free_gb": free,
        "allocated_gb": _num(caps.get("allocated_capacity_gb")),
        "oversubscription": _num(caps.get("max_over_subscription_ratio")),
        "thin": bool(caps.get("thin_provisioning_support")),
        "reserved_pct": _num(caps.get("reserved_percentage")),
        "multiattach": bool(caps.get("multiattach")),
        "reported_at": caps.get("timestamp"),
    }


def _close(values: list[float | None]) -> bool:
    nums = [v for v in values if v is not None]
    if len(nums) != len(values) or not nums:
        return False
    hi = max(nums)
    return hi == 0 or (hi - min(nums)) / hi <= SAME


def group_pools(pools: list[dict], volumes: list[dict], types: list[dict]) -> list[dict]:
    """Backends from pool records (`pool_record`), with the volumes on them (each volume's
    `host` is its pool) and the volume types that select them."""
    by_backend: dict[str, list[dict]] = defaultdict(list)
    for p in pools:
        by_backend[p["backend"]].append(p)
    backend_of_pool = {p["name"]: p["backend"] for p in pools}

    vols: dict[str, list[dict]] = defaultdict(list)
    for v in volumes:
        b = backend_of_pool.get(v.get("host") or "")
        if b:
            vols[b].append(v)

    type_names: dict[str, list[str]] = defaultdict(list)
    for t in types:
        if t.get("backend"):
            type_names[t["backend"]].append(t["name"])

    out = []
    for name, ps in sorted(by_backend.items()):
        shared = len(ps) > 1 and _close([p["total_gb"] for p in ps]) and _close(
            [p["free_gb"] for p in ps])
        if shared:
            newest = max(ps, key=lambda p: p["reported_at"] or "")
            total, free = newest["total_gb"], newest["free_gb"]
        else:
            total = sum(p["total_gb"] or 0 for p in ps) if any(p["total_gb"] for p in ps) else None
            free = sum(p["free_gb"] or 0 for p in ps) if total is not None else None
        used = (total - free) if total is not None and free is not None else None
        ratio = max((p["oversubscription"] or 1.0) for p in ps)
        thin = any(p["thin"] for p in ps)
        effective = total * ratio if total is not None and thin else total
        provisioned = float(sum(v.get("size_gb") or 0 for v in vols[name]))
        states = {p["state"] for p in ps if p["state"]}
        out.append({
            "name": name,
            "protocol": ps[0]["protocol"],
            "vendor": ps[0]["vendor"],
            "driver_version": ps[0]["driver_version"],
            "state": "down" if "down" in states else ("up" if states else None),
            "shared": shared,
            "hosts": sorted({p["hostname"] or p["host"] for p in ps}),
            "pools": sorted(ps, key=lambda p: p["hostname"] or p["host"]),
            "total_gb": _round(total),
            "free_gb": _round(free),
            "used_gb": _round(used),
            "used_pct": _round(used / total * 100) if used is not None and total else None,
            "oversubscription": ratio,
            "thin": thin,
            "effective_gb": _round(effective),
            "provisioned_gb": provisioned,
            "provisioned_pct": _round(provisioned / effective * 100) if effective else None,
            "volumes": len(vols[name]),
            "types": sorted(type_names[name]),
            "reported_at": max((p["reported_at"] or "" for p in ps), default="") or None,
        })
    return out


def _round(v: float | None) -> float | None:
    return round(v, 2) if v is not None else None


def samples(backends: list[dict]) -> list[tuple[str, dict, float]]:
    """Per-backend capacity series for PCD Ops' metrics store."""
    out = []
    for b in backends:
        labels = {"backend": b["name"]}
        for metric, value in (
            ("pcd_ops_storage_total_bytes", b["total_gb"]),
            ("pcd_ops_storage_free_bytes", b["free_gb"]),
            ("pcd_ops_storage_provisioned_bytes", b["provisioned_gb"]),
        ):
            if value is not None:
                out.append((metric, labels, value * GB))
        out.append(("pcd_ops_storage_volumes", labels, float(b["volumes"])))
    return out


def volume_disks(volumes: list[dict]) -> list[tuple[str, dict, float]]:
    """pcd_ops_volume_disk{volume_id, backend, domain, target_device} = 1 for each attachment:
    what joins libvirt's per-disk stats to a volume and its backend."""
    out = []
    for v in volumes:
        for a in v.get("attachments") or []:
            dev = (a.get("device") or "").rsplit("/", 1)[-1]
            if a.get("server_id") and dev:
                out.append(("pcd_ops_volume_disk", {
                    "volume_id": v["id"], "backend": v.get("backend") or "",
                    "domain": a["server_id"], "target_device": dev}, 1.0))
    return out
