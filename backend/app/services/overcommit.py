"""CPU and memory overcommit per host and per cluster (pure functions; the collector fetches).

Allocation comes from Placement: each compute node is a resource provider (its UUID is the
Nova hypervisor id) with VCPU and MEMORY_MB inventories (total, reserved, allocation_ratio) and
usages. Nova schedules up to (total - reserved) * allocation_ratio.

Load is the 95th percentile over a window, so a short spike doesn't count:
- host CPU % and memory used %;
- CPU wait: the share of a VM's vCPU time spent waiting for a host CPU (steal), averaged over
  the host's VMs weighted by their vCPUs, and its worst VM;
- swap-in, pages per second (PCD Ops' own store only).
"""
from __future__ import annotations

import math

CPU_WAIT_HIGH = 5.0     # % of vCPU time waiting for a host CPU: VMs notice
CPU_BUSY_HIGH = 85.0    # host CPU %
CPU_ROOM_LOAD = 50.0    # host CPU % under which a nearly full ratio could go up
CPU_ROOM_WAIT = 1.0
CPU_TARGET = 70.0       # host CPU % a raised ratio is sized for
NEAR_FULL = 80.0        # % of what the ratio allows
MEM_HIGH = 90.0         # host memory used %
SWAP_IN_PPS = 10.0      # pages swapped in per second
MAX_RATIO_STEP = 2.0    # never suggest more than double the current ratio

THRESHOLDS = {
    "cpu_wait_high": CPU_WAIT_HIGH, "cpu_busy_high": CPU_BUSY_HIGH,
    "cpu_room_load": CPU_ROOM_LOAD, "cpu_target": CPU_TARGET, "near_full": NEAR_FULL,
    "mem_high": MEM_HIGH, "swap_in_pps": SWAP_IN_PPS,
}

# Worst first: a cluster takes its worst host's status.
CPU_ORDER = ("contended", "busy", "near_full", "room", "ok", "unknown")
MEM_ORDER = ("pressure", "high", "near_full", "ok", "unknown")


def allocation(inv: dict | None, used: float | None) -> dict | None:
    """What a resource class allows and how much of it is allocated. `inv` is Placement's
    inventory for it ({total, reserved, allocation_ratio})."""
    if not inv or not inv.get("total"):
        return None
    total = float(inv["total"])
    reserved = float(inv.get("reserved") or 0)
    ratio = float(inv.get("allocation_ratio") or 1.0)
    usable = max(total - reserved, 0.0)
    capacity = usable * ratio
    used = float(used or 0)
    return {
        "physical": total,
        "reserved": reserved,
        "ratio": ratio,
        "capacity": round(capacity, 1),
        "allocated": used,
        # How far it is overcommitted in fact, whatever the ratio allows
        "effective_ratio": round(used / usable, 2) if usable else None,
        "alloc_pct": round(100 * used / capacity, 1) if capacity else None,
        "headroom": round(capacity - used, 1),
    }


def vm_wait_by_host(servers: list[dict], waits: dict[str, float]) -> dict[str, dict]:
    """Per host: its VMs' CPU wait averaged by vCPUs, and the worst VM. `servers` are
    {id, name, host (hypervisor id), vcpus}; `waits` is CPU wait % by server id."""
    acc: dict[str, dict] = {}
    for s in servers:
        w = waits.get(s["id"])
        if s.get("host") is None or w is None:
            continue
        a = acc.setdefault(s["host"], {"sum": 0.0, "vcpus": 0, "worst": None})
        n = s.get("vcpus") or 1
        a["sum"] += w * n
        a["vcpus"] += n
        if a["worst"] is None or w > a["worst"]["pct"]:
            a["worst"] = {"id": s["id"], "name": s.get("name"), "pct": round(w, 2)}
    return {h: {"avg": round(a["sum"] / a["vcpus"], 2), "worst": a["worst"]}
            for h, a in acc.items() if a["vcpus"]}


def suggest_ratio(alloc: dict, cpu_p95: float) -> float | None:
    """A higher CPU ratio the host's load leaves room for, if load grows in step with the
    vCPUs allocated: sized for CPU_TARGET, in steps of 0.5, at most double. None when it
    wouldn't be higher than today's."""
    usable = alloc["physical"] - alloc["reserved"]
    if not usable or not alloc["allocated"]:
        return None
    fits = alloc["allocated"] * CPU_TARGET / max(cpu_p95, 1.0) / usable
    ratio = math.floor(min(fits, alloc["ratio"] * MAX_RATIO_STEP) * 2) / 2
    return ratio if ratio > alloc["ratio"] else None


def _nearly_full(alloc: dict) -> str:
    return f"{alloc['alloc_pct']:.0f}% of what the {alloc['ratio']:g}:1 ratio allows"


def cpu_verdict(alloc: dict | None, load: dict) -> dict:
    """{status, reason, suggested_ratio} for a host's CPU. Statuses:
    contended: more vCPUs than cores in use and VMs wait for CPU or the host is busy;
    busy: loaded, but not overcommitted, so the ratio isn't the cause;
    near_full: the ratio is nearly used up and load gives no room to raise it;
    room: the ratio is nearly used up but load is low, so it could go up;
    ok; unknown: no Placement data, or no load data where it matters."""
    if alloc is None:
        return {"status": "unknown", "reason": "No VCPU inventory in Placement",
                "suggested_ratio": None}
    cpu, wait = load.get("cpu_pct"), load.get("cpu_wait_pct")
    over = (alloc["effective_ratio"] or 0) > 1
    hot = []
    if wait is not None and wait >= CPU_WAIT_HIGH:
        hot.append(f"VMs wait {wait:.1f}% of the time for a CPU")
    if cpu is not None and cpu >= CPU_BUSY_HIGH:
        hot.append(f"host CPU at {cpu:.0f}% (p95)")
    if hot:
        if over:
            return {"status": "contended", "suggested_ratio": None,
                    "reason": (f"{alloc['effective_ratio']:g} vCPUs per host CPU and "
                               + " and ".join(hot))}
        return {"status": "busy", "suggested_ratio": None,
                "reason": "Busy without overcommit: " + " and ".join(hot)}
    full = (alloc["alloc_pct"] or 0) >= NEAR_FULL
    if not full:
        return {"status": "ok", "reason": None, "suggested_ratio": None}
    if cpu is None:
        return {"status": "near_full", "suggested_ratio": None,
                "reason": f"{_nearly_full(alloc)}; no load data"}
    if cpu < CPU_ROOM_LOAD and (wait is None or wait < CPU_ROOM_WAIT):
        ratio = suggest_ratio(alloc, cpu)
        if ratio:
            return {"status": "room", "suggested_ratio": ratio,
                    "reason": (f"{alloc['alloc_pct']:.0f}% allocated but CPU only {cpu:.0f}% "
                               f"(p95): the ratio could go to about {ratio:g}:1")}
    return {"status": "near_full", "suggested_ratio": None, "reason": _nearly_full(alloc)}


def mem_verdict(alloc: dict | None, load: dict) -> dict:
    """{status, reason} for a host's memory. Statuses:
    pressure: the host swaps, or memory is overcommitted (more allocated than there is) and
    usage is high; high: usage is high without overcommit; near_full: nearly all of what the
    ratio allows is allocated; ok; unknown."""
    if alloc is None:
        return {"status": "unknown", "reason": "No MEMORY_MB inventory in Placement"}
    used, swap = load.get("mem_pct"), load.get("swap_in_pps")
    over = (alloc["effective_ratio"] or 0) > 1
    if swap is not None and swap >= SWAP_IN_PPS:
        return {"status": "pressure", "reason": f"Swapping in {swap:.0f} pages/s (p95)"}
    if used is not None and used >= MEM_HIGH:
        if over:
            return {"status": "pressure", "reason": (
                f"{alloc['effective_ratio']:g}× memory allocated and {used:.0f}% used (p95): "
                "VMs may be swapped or ballooned")}
        return {"status": "high", "reason": f"{used:.0f}% used (p95)"}
    if (alloc["alloc_pct"] or 0) >= NEAR_FULL:
        return {"status": "near_full", "reason": _nearly_full(alloc)}
    return {"status": "ok", "reason": None}


def host_rows(hypervisors: list[dict], placement: dict[str, dict], load: dict[str, dict],
              waits: dict[str, dict]) -> list[dict]:
    """One row per hypervisor. `placement` is {hypervisor id: {inventories, usages}}, `load` is
    {hypervisor id: {cpu_pct, mem_pct, swap_in_pps}} and `waits` comes from vm_wait_by_host."""
    rows = []
    for h in hypervisors:
        p = placement.get(h["id"]) or {}
        inv, use = p.get("inventories") or {}, p.get("usages") or {}
        w = waits.get(h["id"]) or {}
        lo = {**(load.get(h["id"]) or {}), "cpu_wait_pct": w.get("avg")}
        cpu = allocation(inv.get("VCPU"), use.get("VCPU"))
        mem = allocation(inv.get("MEMORY_MB"), use.get("MEMORY_MB"))
        rows.append({
            "id": h["id"],
            "hostname": h.get("hostname"),
            "aggregates": h.get("aggregates") or [],
            "state": h.get("state"),
            "vms": h.get("running_vms"),
            "cpu": cpu,
            "memory": mem,
            "load": {**lo, "cpu_wait_worst": w.get("worst")},
            "cpu_verdict": cpu_verdict(cpu, lo),
            "mem_verdict": mem_verdict(mem, lo),
        })
    return rows


def _sum(allocs: list[dict]) -> dict | None:
    if not allocs:
        return None
    phys = sum(a["physical"] for a in allocs)
    usable = sum(a["physical"] - a["reserved"] for a in allocs)
    cap = sum(a["capacity"] for a in allocs)
    used = sum(a["allocated"] for a in allocs)
    ratios = sorted({a["ratio"] for a in allocs})
    return {
        "physical": phys,
        "reserved": phys - usable,
        "ratio": ratios[0] if len(ratios) == 1 else None,
        "ratios": ratios,
        "capacity": round(cap, 1),
        "allocated": used,
        "effective_ratio": round(used / usable, 2) if usable else None,
        "alloc_pct": round(100 * used / cap, 1) if cap else None,
        "headroom": round(cap - used, 1),
    }


def _worst(statuses: list[str], order: tuple[str, ...]) -> str:
    return min(statuses, key=order.index) if statuses else "unknown"


def _wavg(pairs: list[tuple[float | None, float]]) -> float | None:
    pairs = [(v, w) for v, w in pairs if v is not None and w]
    total = sum(w for _, w in pairs)
    return round(sum(v * w for v, w in pairs) / total, 1) if total else None


def _size(host: dict, res: str, field: str = "physical") -> float:
    return (host[res] or {}).get(field, 0)


def cluster_rows(clusters: list[dict], hosts: list[dict]) -> list[dict]:
    """One row per host aggregate: its hosts' allocation summed, load averaged by size, the
    worst host's status, and how many hosts have each status."""
    by_id = {h["id"]: h for h in hosts}
    rows = []
    for c in clusters:
        members = [by_id[m["hypervisor_id"]] for m in c.get("hosts") or []
                   if m.get("hypervisor_id") in by_id]
        cpus = [h["cpu"] for h in members if h["cpu"]]
        mems = [h["memory"] for h in members if h["memory"]]
        cpu_st = [h["cpu_verdict"]["status"] for h in members]
        mem_st = [h["mem_verdict"]["status"] for h in members]
        rows.append({
            "id": c["id"],
            "name": c.get("name"),
            "kind": c.get("kind"),
            "hosts": len(members),
            "cpu": _sum(cpus),
            "memory": _sum(mems),
            "load": {
                # Host load weighted by host size; CPU wait by the vCPUs that wait
                "cpu_pct": _wavg([(h["load"].get("cpu_pct"), _size(h, "cpu")) for h in members]),
                "mem_pct": _wavg([(h["load"].get("mem_pct"), _size(h, "memory")) for h in members]),
                "cpu_wait_pct": _wavg([(h["load"].get("cpu_wait_pct"),
                                        _size(h, "cpu", "allocated")) for h in members]),
            },
            "cpu_status": _worst(cpu_st, CPU_ORDER),
            "mem_status": _worst(mem_st, MEM_ORDER),
            "cpu_counts": {s: cpu_st.count(s) for s in CPU_ORDER if s in cpu_st},
            "mem_counts": {s: mem_st.count(s) for s in MEM_ORDER if s in mem_st},
        })
    return rows


def totals(hosts: list[dict]) -> dict:
    """Every host together, and how many hosts have each status."""
    return {
        "cpu": _sum([h["cpu"] for h in hosts if h["cpu"]]),
        "memory": _sum([h["memory"] for h in hosts if h["memory"]]),
        "cpu_counts": {s: n for s in CPU_ORDER
                       if (n := sum(h["cpu_verdict"]["status"] == s for h in hosts))},
        "mem_counts": {s: n for s in MEM_ORDER
                       if (n := sum(h["mem_verdict"]["status"] == s for h in hosts))},
    }
