"""Right-sizing: which flavor a VM should move to, and whether that flavor fits anywhere (pure
functions; the collector, the API and the rightsizing-resize job call them).

The suggested flavor is a formula, not the AI's: the smallest flavor that would run the VM's
average load at a target utilisation. The AI only comments.

Fit comes from Placement's headroom per host (services/overcommit.py rows): a resize goes to a
host in the same cluster as the VM's current one, and the flavor's
`aggregate_instance_extra_specs:*` must match that cluster's metadata. Nova resizes to another
host unless `allow_resize_to_same_host` is set, so fitting only on the current host is reported
separately.
"""

from __future__ import annotations

import math

DOWN_MARGIN = 1.5  # a smaller flavor keeps 50 % above the average use
CPU_TARGET = 70.0  # % a bigger flavor should run the VM at
MEM_TARGET = 75.0
AGG_SPEC = "aggregate_instance_extra_specs:"


def smaller_flavor(
    cur: dict, cpu_avg: float | None, mem_avg: float | None, flavors: list[dict]
) -> dict | None:
    """The smallest flavor with room for the average use plus DOWN_MARGIN that is smaller than
    `cur` in vCPUs or RAM. `flavors` are {id, name, vcpus, ram_mb}, smallest first."""
    vcpus, ram = cur.get("vcpus") or 0, cur.get("ram_mb") or 0
    if not vcpus or not ram:
        return None
    need_vcpus = max(1, math.ceil((cpu_avg or 5) / 100 * vcpus * DOWN_MARGIN))
    need_ram = max(512, math.ceil((mem_avg or 5) / 100 * ram * DOWN_MARGIN))
    for f in flavors:
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
    need_vcpus = (
        max(vcpus + 1, math.ceil((cpu_avg or 0) / CPU_TARGET * vcpus)) if cpu_short else vcpus
    )
    need_ram = max(ram + 1, math.ceil((mem_avg or 0) / MEM_TARGET * ram)) if mem_short else ram
    for f in flavors:
        if f["vcpus"] >= need_vcpus and f["ram_mb"] >= need_ram:
            return f
    return None


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


def flavor_fit(
    flavor: dict, current: dict, host_id: str | None, hosts: list[dict], clusters: list[dict]
) -> dict:
    """Where `flavor` would fit for a VM now running `current` on `host_id`.

    {status, hosts, reason}; status is fits (another host has room), same_host (only the
    current host, after giving back the current flavor), no_room, or unknown (no Placement
    data for the hosts)."""
    by_id = {h["id"]: h for h in hosts}
    aggs_of: dict[str, list[dict]] = {}
    for c in clusters:
        for m in c.get("hosts") or []:
            if m.get("hypervisor_id"):
                aggs_of.setdefault(m["hypervisor_id"], []).append(c)
    home = by_id.get(host_id or "")
    home_aggs = {c["id"] for c in aggs_of.get(host_id or "", [])}
    scope = [
        h for h in hosts if not home_aggs or home_aggs & {c["id"] for c in aggs_of.get(h["id"], [])}
    ]
    scope = [
        h
        for h in scope
        if h.get("state") in (None, "up")
        and h.get("cpu")
        and h.get("memory")
        and _agg_ok(flavor, aggs_of.get(h["id"], []))
    ]
    if not scope:
        if not any(h.get("cpu") for h in hosts):
            return {"status": "unknown", "hosts": [], "reason": "No Placement data for the hosts"}
        return {
            "status": "no_room",
            "hosts": [],
            "reason": "No host in its cluster matches the flavor's aggregate requirements",
        }

    def room(h: dict, give_back: bool) -> bool:
        cpu = h["cpu"]["headroom"] + ((current.get("vcpus") or 0) if give_back else 0)
        mem = h["memory"]["headroom"] + ((current.get("ram_mb") or 0) if give_back else 0)
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
