"""Physical capacity and what-if simulation (pure functions; the collector and API call them).

Capacity is what the cloud can actually allocate, not the sum of tenant quotas:
- vCPUs and RAM from Placement, summed over hosts: (total - reserved) × allocation ratio, and
  what is allocated (services/overcommit.py totals). Without Placement data, the hypervisors'
  own counts at 1:1.
- Storage from Cinder's backends (services/storage.py), a shared store counted once: GB
  written against the disks' size. Not what Cinder lets thin backends provision (their
  oversubscription ratio can make a 7 TB share look like 150 TB), and not just volumes (other
  data on a shared store fills it too). Provisioned and provisionable GB are reported beside.

A what-if adds resources cluster-wide, and for a tenant also checks the tenant's quotas (cores,
RAM, volume GB, and vDisks against the volumes quota).
"""

from __future__ import annotations

# Quota names: Nova's and Cinder's, and the plan field that uses each.
QUOTAS = (
    ("cores", "vcpus", 1, "vCPUs"),
    ("ram", "ram_gb", 1024, "RAM (GB)"),  # Nova counts MB
    ("gigabytes", "storage_gb", 1, "Volume storage (GB)"),
    ("volumes", "vdisks", 1, "Volumes"),
)


def _resource(used: float, total: float | None, **extra) -> dict:
    return {
        "used": round(used, 1),
        "total": round(total, 1) if total is not None else None,
        "free": round(total - used, 1) if total is not None else None,
        **extra,
    }


def summary(placement_totals: dict | None, hypervisors: list[dict], backends: list[dict]) -> dict:
    """{vcpus, ram_gb, storage_gb}: each {used, total, free} plus where it came from."""
    cpu = (placement_totals or {}).get("cpu")
    mem = (placement_totals or {}).get("memory")
    if cpu:
        vcpus = _resource(
            cpu["allocated"],
            cpu["capacity"],
            physical=cpu["physical"],
            ratio=cpu["ratio"],
            source="placement",
        )
    else:
        vcpus = _resource(
            sum(h.get("vcpus_used") or 0 for h in hypervisors),
            sum(h.get("vcpus_total") or 0 for h in hypervisors) or None,
            source="hypervisors",
        )
    if mem:
        ram = _resource(
            mem["allocated"] / 1024,
            mem["capacity"] / 1024,
            physical=round(mem["physical"] / 1024, 1),
            ratio=mem["ratio"],
            source="placement",
        )
    else:
        ram = _resource(
            sum(h.get("memory_mb_used") or 0 for h in hypervisors) / 1024,
            (sum(h.get("memory_mb_total") or 0 for h in hypervisors) / 1024) or None,
            source="hypervisors",
        )
    known = [b for b in backends if b.get("total_gb") is not None]
    provisioned = round(sum(b.get("provisioned_gb") or 0 for b in backends), 1)
    storage = _resource(
        sum(b.get("used_gb") or 0 for b in known) if known else provisioned,
        sum(b["total_gb"] for b in known) if known else None,
        provisioned=provisioned,
        provisionable=round(sum(b.get("effective_gb") or 0 for b in known), 1) if known else None,
        source="cinder",
    )
    return {"vcpus": vcpus, "ram_gb": ram, "storage_gb": storage}


def samples(s: dict) -> list[tuple[str, dict, float]]:
    """The summary as series for PCD Ops' metrics store, which keeps its history for trends."""
    out = []
    for res in ("vcpus", "ram_gb", "storage_gb"):
        r = s[res]
        out.append(("pcd_ops_capacity_used", {"resource": res}, float(r["used"])))
        if r["total"] is not None:
            out.append(("pcd_ops_capacity_total", {"resource": res}, float(r["total"])))
    return out


def _project(r: dict, delta: float) -> dict:
    used = r["used"] + delta
    free = (r["free"] - delta) if r["free"] is not None else None
    return {
        **r,
        "used": round(used, 1),
        "free": round(free, 1) if free is not None else None,
        "fits": free is None or free >= 0,
    }


def simulate(s: dict, add: dict, quota: dict | None = None) -> dict:
    """Current vs projected capacity for adding `add` ({vcpus, ram_gb, storage_gb, vdisks}),
    and, given a tenant's `quota` (from tenant_quota), whether the tenant's quotas allow it."""
    projected = {
        "vcpus": _project(s["vcpus"], add.get("vcpus", 0)),
        "ram_gb": _project(s["ram_gb"], add.get("ram_gb", 0)),
        "storage_gb": _project(s["storage_gb"], add.get("storage_gb", 0)),
    }
    out = {
        "current": s,
        "projected": projected,
        "would_fit": all(v["fits"] for v in projected.values()),
    }
    if quota is not None:
        rows = []
        for _, field, _, label in QUOTAS:
            q = quota.get(field)
            if not q:
                continue
            limit, used = q["limit"], q["used"]
            after = used + add.get(field, 0)
            rows.append(
                {
                    "resource": field,
                    "label": label,
                    "limit": limit,
                    "used": used,
                    "after": round(after, 1),
                    # -1 is unlimited
                    "fits": limit is None or limit < 0 or after <= limit,
                }
            )
        out["quota"] = rows
        out["quota_fits"] = all(r["fits"] for r in rows)
        out["would_fit"] = out["would_fit"] and out["quota_fits"]
    return out


def tenant_quota(compute: dict | None, block: dict | None) -> dict:
    """A tenant's limits and use, from Nova's and Cinder's quota sets with usage
    ({name: {limit, in_use, reserved}}), in plan units."""
    out = {}
    for name, field, scale, _ in QUOTAS:
        src = compute if name in ("cores", "ram") else block
        q = (src or {}).get(name)
        if not isinstance(q, dict):
            continue
        limit = q.get("limit")
        used = (q.get("in_use") or 0) + (q.get("reserved") or 0)
        out[field] = {
            "limit": limit / scale if limit is not None and limit >= 0 else limit,
            "used": round(used / scale, 1),
        }
    return out
