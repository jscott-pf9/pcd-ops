"""Right-sizing: which flavor a VM should move to, and whether that flavor fits anywhere (pure
functions; the collector, the API and the rightsizing-resize job call them).

A VM's class comes from its average CPU and RAM over the window (classify); the suggested
flavor is a formula, not the AI's: the smallest flavor that would run the VM's average load at a
target utilisation. The AI only comments. For the drill-down, `reasons` says why in words,
`project` shows its use on another flavor and `alternatives` lists the other flavors that would do.

Fit comes from Placement's headroom per host (services/overcommit.py rows): a resize goes to a
host in the same cluster as the VM's current one, and the flavor's
`aggregate_instance_extra_specs:*` must match that cluster's metadata. Nova resizes to another
host unless `allow_resize_to_same_host` is set, so fitting only on the current host is reported
separately.
"""

from __future__ import annotations

import math

CPU_LOW, CPU_HIGH = 20.0, 80.0  # average CPU % under: spare; over: pressure
MEM_LOW, MEM_HIGH = 20.0, 80.0
RISK_HIGH = 90.0  # pressure at or above this average is high risk
DOWN_MARGIN = 1.5  # a smaller flavor keeps 50 % above the average use
CPU_TARGET = 70.0  # % a bigger flavor should run the VM at
MEM_TARGET = 75.0
BUSY_WARN = 90.0  # a flavor that would run the VM's busiest hours (p95) above this is tight
ALTERNATIVES = 5
AGG_SPEC = "aggregate_instance_extra_specs:"


def classify(cpu_avg: float | None, mem_avg: float | None, idle: bool) -> tuple[str, str]:
    """(classification, risk) from the window's average CPU and RAM %. `idle` is Reclamation's
    rule, so both pages call the same VMs idle."""
    if cpu_avg is None and mem_avg is None:
        return "no-data", "unknown"
    if mem_avg is not None and mem_avg >= MEM_HIGH:
        return "memory-pressure", "high" if mem_avg >= RISK_HIGH else "medium"
    if cpu_avg is not None and cpu_avg >= CPU_HIGH:
        return "cpu-pressure", "high" if cpu_avg >= RISK_HIGH else "medium"
    if idle:
        return "idle", "low"
    if (cpu_avg is None or cpu_avg < CPU_LOW) and (mem_avg is None or mem_avg < MEM_LOW):
        return "overprovisioned", "low"
    return "right-sized", "low"


def _pct(v: float | None) -> str:
    return "no data" if v is None else f"{v:.1f} %"


def reasons(rec: dict) -> list[str]:
    """Why a recommendation has its class, in the order classify() checks."""
    cls, cpu, mem = rec.get("classification"), rec.get("cpu_avg_pct"), rec.get("mem_avg_pct")
    days = rec.get("window_days")
    over = (f"over the last {days} day{'s' if days != 1 else ''}" if days
            else "over the window")
    if cls == "no-data":
        return ["No CPU or RAM metrics for this VM: it is stopped, new, or its host isn't "
                "scraped."]
    if cls == "memory-pressure":
        out = [f"Average RAM {over} is {_pct(mem)}, at or above {MEM_HIGH:.0f} %."]
        if mem is not None and mem >= RISK_HIGH:
            out.append(f"At {RISK_HIGH:.0f} % or more it risks running out of memory: high risk.")
        return out
    if cls == "cpu-pressure":
        out = [f"Average CPU {over} is {_pct(cpu)}, at or above {CPU_HIGH:.0f} %; "
               f"RAM ({_pct(mem)}) is under {MEM_HIGH:.0f} %."]
        if cpu is not None and cpu >= RISK_HIGH:
            out.append(f"At {RISK_HIGH:.0f} % or more its work is likely waiting for CPU: high "
                       "risk.")
        return out
    if cls == "idle":
        idle = rec.get("idle") or {}
        rule = idle.get("rule") or {}
        out = ["Reclamation's idle rule: at its busiest (95th percentile) over the last "
               f"{rule.get('days', '?')} days, CPU, network and disk all stayed under the "
               "thresholds."]
        if idle:
            net, iops = idle.get("net_bps"), idle.get("iops")
            net_s = "no data" if net is None else f"{net / 1024:.1f} KB/s"
            iops_s = "no data" if iops is None else f"{iops:.1f} IOPS"
            out.append(
                f"CPU {_pct(idle.get('cpu_pct'))} (under {rule.get('cpu_pct', '?')} %), "
                f"network {net_s} (under {rule.get('net_kbps', '?')} KB/s), "
                f"disk {iops_s} (under {rule.get('iops', '?')} IOPS).")
        return out
    if cls == "overprovisioned":
        return [f"Average CPU ({_pct(cpu)}) and RAM ({_pct(mem)}) {over} are both under "
                f"{CPU_LOW:.0f} %: it uses a small part of its flavor."]
    return [f"Average CPU ({_pct(cpu)}) and RAM ({_pct(mem)}) {over} are between "
            f"{CPU_LOW:.0f} % and {CPU_HIGH:.0f} %: no change needed."]


def resizable(cur: dict, flavors: list[dict]) -> list[dict]:
    """The flavors a VM on `cur` can resize to. Nova can't shrink a local root or ephemeral disk,
    or resize an image-backed VM to a flavor without a root disk, so an image-backed VM
    (`cur["image_backed"]`) keeps at least its disk_gb and ephemeral_gb. A volume-backed VM's
    root disk is its volume, so any flavor will do."""
    if not cur.get("image_backed"):
        return flavors
    disk, eph = cur.get("disk_gb") or 0, cur.get("ephemeral_gb") or 0
    return [f for f in flavors
            if (f.get("disk_gb") or 0) >= max(disk, 1) and (f.get("ephemeral_gb") or 0) >= eph]


def _need_down(cur: dict, cpu_avg: float | None, mem_avg: float | None) -> tuple[int, int]:
    vcpus, ram = cur.get("vcpus") or 0, cur.get("ram_mb") or 0
    return (max(1, math.ceil((cpu_avg or 5) / 100 * vcpus * DOWN_MARGIN)),
            max(512, math.ceil((mem_avg or 5) / 100 * ram * DOWN_MARGIN)))


def _need_up(cur: dict, cpu_avg: float | None, mem_avg: float | None, cpu_short: bool,
             mem_short: bool) -> tuple[int, int]:
    vcpus, ram = cur.get("vcpus") or 0, cur.get("ram_mb") or 0
    return (max(vcpus + 1, math.ceil((cpu_avg or 0) / CPU_TARGET * vcpus)) if cpu_short else vcpus,
            max(ram + 1, math.ceil((mem_avg or 0) / MEM_TARGET * ram)) if mem_short else ram)


def smaller_flavor(
    cur: dict, cpu_avg: float | None, mem_avg: float | None, flavors: list[dict]
) -> dict | None:
    """The smallest flavor with room for the average use plus DOWN_MARGIN that is smaller than
    `cur` in vCPUs or RAM, among those it can resize to (resizable). `flavors` are {id, name,
    vcpus, ram_mb, disk_gb, ephemeral_gb}, smallest first."""
    vcpus, ram = cur.get("vcpus") or 0, cur.get("ram_mb") or 0
    if not vcpus or not ram:
        return None
    need_vcpus, need_ram = _need_down(cur, cpu_avg, mem_avg)
    for f in resizable(cur, flavors):
        if (
            f["vcpus"] >= need_vcpus
            and f["ram_mb"] >= need_ram
            and (f["vcpus"] < vcpus or f["ram_mb"] < ram)
        ):
            return f
    return None


def larger_flavor(
    cur: dict,
    cpu_avg: float | None,
    mem_avg: float | None,
    flavors: list[dict],
    cpu_short: bool,
    mem_short: bool,
) -> dict | None:
    """The smallest flavor that runs the pressured resource at its target and is no smaller in
    the other one. None when no flavor is big enough."""
    vcpus, ram = cur.get("vcpus") or 0, cur.get("ram_mb") or 0
    if not vcpus or not ram or not (cpu_short or mem_short):
        return None
    need_vcpus, need_ram = _need_up(cur, cpu_avg, mem_avg, cpu_short, mem_short)
    for f in resizable(cur, flavors):
        if f["vcpus"] >= need_vcpus and f["ram_mb"] >= need_ram:
            return f
    return None


def basis(rec: dict) -> dict | None:
    """What the suggested flavor had to have, and the rule: {direction, vcpus, ram_mb, rule}.
    None for classes that keep their flavor."""
    cls, cur = rec.get("classification"), rec.get("current_flavor") or {}
    cpu, mem = rec.get("cpu_avg_pct"), rec.get("mem_avg_pct")
    if not cur.get("vcpus") or not cur.get("ram_mb"):
        return None
    if cls in ("overprovisioned", "idle"):
        v, r = _need_down(cur, cpu, mem)
        return {"direction": "down", "vcpus": v, "ram_mb": r,
                "rule": f"The smallest flavor with room for its average use plus "
                        f"{round((DOWN_MARGIN - 1) * 100)} %, smaller than now in vCPUs or RAM."}
    if cls in ("cpu-pressure", "memory-pressure"):
        cpu_short, mem_short = (cpu or 0) >= CPU_HIGH, (mem or 0) >= MEM_HIGH
        v, r = _need_up(cur, cpu, mem, cpu_short, mem_short)
        what = " and ".join(w for w, short in (
            (f"CPU at {CPU_TARGET:.0f} %", cpu_short), (f"RAM at {MEM_TARGET:.0f} %", mem_short))
            if short)
        return {"direction": "up", "vcpus": v, "ram_mb": r,
                "rule": f"The smallest flavor that runs its average {what}, and no smaller in "
                        "the other."}
    return None


def project(cur: dict, flavor: dict, stats: dict | None) -> dict:
    """The VM's CPU and RAM use on `flavor`, scaled from its use of `cur`: the same work over
    more or fewer vCPUs and MB. {cpu: {avg, p95, peak}, mem: {...}, warnings: [...]}."""
    out: dict = {"warnings": []}
    for key, size in (("cpu", "vcpus"), ("mem", "ram_mb")):
        ratio = (cur.get(size) or 0) / flavor[size] if flavor.get(size) else None
        st = (stats or {}).get(key) or {}
        out[key] = {k: (round(min(st[k] * ratio, 999), 1) if ratio and st.get(k) is not None
                        else None) for k in ("avg", "p95", "peak")}
        p95 = out[key]["p95"]
        if p95 is not None and p95 >= BUSY_WARN:
            what = "CPU" if key == "cpu" else "RAM"
            out["warnings"].append(
                f"In its busiest hours (95th percentile) it would use {min(p95, 100):.0f} % "
                f"{what}{' or more' if p95 > 100 else ''} on {flavor.get('name', 'this flavor')}.")
    return out


def alternatives(rec: dict, flavors: list[dict]) -> list[dict]:
    """Flavors that meet the suggestion's basis, smallest first (the suggestion among them),
    each with the VM's projected use. `flavors` are smallest first."""
    b, cur = basis(rec), rec.get("current_flavor") or {}
    if not b:
        return []
    out = []
    for f in resizable(cur, flavors):
        if f["vcpus"] < b["vcpus"] or f["ram_mb"] < b["ram_mb"]:
            continue
        smaller = f["vcpus"] < cur["vcpus"] or f["ram_mb"] < cur["ram_mb"]
        if b["direction"] == "down" and not smaller:
            continue
        out.append({"flavor": {k: f.get(k) for k in ("id", "name", "vcpus", "ram_mb")},
                    "projected": project(cur, f, rec.get("stats"))})
        if len(out) == ALTERNATIVES:
            break
    return out


def _agg_ok(flavor: dict, host_aggs: list[dict]) -> bool:
    """The flavor's aggregate extra specs are all met by one of the host's aggregates."""
    want = {
        k[len(AGG_SPEC) :]: str(v)
        for k, v in (flavor.get("extra_specs") or {}).items()
        if k.startswith(AGG_SPEC)
    }
    if not want:
        return True
    return any(
        all(str((a.get("metadata") or {}).get(k)) == v for k, v in want.items()) for a in host_aggs
    )


def _cluster(host_id: str | None, hosts: list[dict],
             clusters: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    """The hosts sharing an aggregate with `host_id` (all hosts when it has none), and each
    host's aggregates."""
    aggs_of: dict[str, list[dict]] = {}
    for c in clusters:
        for m in c.get("hosts") or []:
            if m.get("hypervisor_id"):
                aggs_of.setdefault(m["hypervisor_id"], []).append(c)
    home_aggs = {c["id"] for c in aggs_of.get(host_id or "", [])}
    members = [
        h for h in hosts if not home_aggs or home_aggs & {c["id"] for c in aggs_of.get(h["id"], [])}
    ]
    return members, aggs_of


def _excluded(flavor: dict, h: dict, aggs_of: dict[str, list[dict]]) -> str | None:
    """Why a host in the cluster can't take the flavor at all, or None."""
    if h.get("state") not in (None, "up"):
        return "host is down"
    if not h.get("cpu") or not h.get("memory"):
        return "no Placement data"
    if not _agg_ok(flavor, aggs_of.get(h["id"], [])):
        return "flavor's aggregate requirements not met"
    return None


def _scope(flavor: dict, host_id: str | None, hosts: list[dict],
           clusters: list[dict]) -> list[dict]:
    """Hosts a resize of the VM on `host_id` could go to: up, in its cluster, with Placement
    data, and meeting the flavor's aggregate specs."""
    members, aggs_of = _cluster(host_id, hosts, clusters)
    return [h for h in members if not _excluded(flavor, h, aggs_of)]


def _free(h: dict, current: dict, give_back: bool) -> tuple[float, float]:
    """Free vCPUs and MB under the allocation ratio; on the VM's own host its current flavor
    counts as free, since a same-host resize gives it back."""
    return (h["cpu"]["headroom"] + ((current.get("vcpus") or 0) if give_back else 0),
            h["memory"]["headroom"] + ((current.get("ram_mb") or 0) if give_back else 0))


def host_room(flavor: dict, current: dict, host_id: str | None, hosts: list[dict],
              clusters: list[dict]) -> list[dict]:
    """Each host in the VM's cluster: its free vCPUs and RAM and whether `flavor` fits there,
    or why it can't be used. Hosts that fit first."""
    members, aggs_of = _cluster(host_id, hosts, clusters)
    rows = []
    for h in members:
        why = _excluded(flavor, h, aggs_of)
        current_host = h["id"] == host_id
        cpu_free = mem_free = None
        fits = False
        if not why:
            cpu_free, mem_free = _free(h, current, current_host)
            short = [w for w, have, need in (("vCPUs", cpu_free, flavor.get("vcpus") or 0),
                                             ("RAM", mem_free, flavor.get("ram_mb") or 0))
                     if have < need]
            fits = not short
            if short:
                why = "not enough free " + " or ".join(short)
        rows.append({"id": h["id"], "hostname": h["hostname"], "current": current_host,
                     "cpu_free": None if cpu_free is None else round(cpu_free, 1),
                     "mem_free_mb": None if mem_free is None else round(mem_free),
                     "fits": fits, "why": why})
    rows.sort(key=lambda r: (not r["fits"], r["current"], r["hostname"]))
    return rows


def flavor_fit(
    flavor: dict, current: dict, host_id: str | None, hosts: list[dict], clusters: list[dict]
) -> dict:
    """Where `flavor` would fit for a VM now running `current` on `host_id`.

    {status, hosts, reason}; status is fits (another host has room), same_host (only the
    current host, after giving back the current flavor), no_room, or unknown (no Placement
    data for the hosts)."""
    by_id = {h["id"]: h for h in hosts}
    home = by_id.get(host_id or "")
    scope = _scope(flavor, host_id, hosts, clusters)
    if not scope:
        if not any(h.get("cpu") for h in hosts):
            return {"status": "unknown", "hosts": [], "reason": "No Placement data for the hosts"}
        return {
            "status": "no_room",
            "hosts": [],
            "reason": "No host in its cluster matches the flavor's aggregate requirements",
        }

    def room(h: dict, give_back: bool) -> bool:
        cpu, mem = _free(h, current, give_back)
        return cpu >= (flavor.get("vcpus") or 0) and mem >= (flavor.get("ram_mb") or 0)

    others = [h["hostname"] for h in scope if h["id"] != host_id and room(h, False)]
    if others:
        return {
            "status": "fits",
            "hosts": others,
            "reason": f"Room on {len(others)} host{'s' if len(others) != 1 else ''} in its cluster",
        }
    if home and home in scope and room(home, True):
        return {
            "status": "same_host",
            "hosts": [home["hostname"]],
            "reason": (
                "Fits only on its current host: the resize works only if Nova "
                "allows resizing to the same host"
            ),
        }
    return {
        "status": "no_room",
        "hosts": [],
        "reason": f"No host in its cluster has {flavor.get('vcpus')} vCPUs and "
        f"{round((flavor.get('ram_mb') or 0) / 1024)} GB free under its allocation ratio",
    }


def with_fit(recs: list[dict], overcommit: dict | None, clusters: list[dict] | None) -> list[dict]:
    """Each recommendation with a suggested flavor gets `fit`, from Placement's headroom now."""
    hosts = (overcommit or {}).get("hosts") or []
    out = []
    for r in recs:
        if r.get("suggested_flavor"):
            r = {
                **r,
                "fit": flavor_fit(
                    r["suggested_flavor"],
                    r.get("current_flavor") or {},
                    r.get("hypervisor_id"),
                    hosts,
                    clusters or [],
                ),
            }
        out.append(r)
    return out
