"""Config change log: a snapshot of the cloud's configuration each collection, and what changed
since the previous one (pure functions; collector.collect_drift fetches and stores).

A snapshot is {kind: {id: {"name", "project_id", "attrs": {...}}}}. Attribute values are
scalars, or dicts diffed per key: metadata and extra specs, and sets (aggregate hosts,
security group rules) as {member: description}. Changes are recorded between collections, so
they say what changed and roughly when, not who: Keystone doesn't expose that.
"""

from __future__ import annotations

import json

from app.services.reclamation import HIDDEN_PROJECTS

KINDS = ("flavors", "security_groups", "aggregates", "hosts", "quotas")
LABEL = {
    "flavors": "flavor",
    "security_groups": "security group",
    "aggregates": "aggregate",
    "hosts": "host",
    "quotas": "quotas",
}
PLURAL = {
    "flavors": "flavors",
    "security_groups": "security groups",
    "aggregates": "aggregates",
    "hosts": "hosts",
    "quotas": "quotas",
}

# Quota names worth tracking; Nova's legacy network ones and Neutron's rarely used ones skipped.
NOVA_QUOTAS = (
    "cores",
    "ram",
    "instances",
    "key_pairs",
    "server_groups",
    "server_group_members",
    "metadata_items",
)
NEUTRON_QUOTAS = (
    "network",
    "subnet",
    "port",
    "router",
    "floatingip",
    "security_group",
    "security_group_rule",
)


def _item(name, project_id=None, **attrs) -> dict:
    return {"name": name, "project_id": project_id, "attrs": attrs}


def flavors(records: list[dict]) -> dict:
    return {
        f["id"]: _item(
            f["name"],
            None,
            vcpus=f["vcpus"],
            ram_mb=f["ram_mb"],
            disk_gb=f["disk_gb"],
            ephemeral_gb=f["ephemeral_gb"],
            swap_mb=f["swap_mb"],
            public=f["public"],
            disabled=f["disabled"],
            extra_specs=dict(f.get("extra_specs") or {}),
        )
        for f in records
    }


def rule_signature(r: dict) -> str:
    """A rule as a person reads it, which also identifies it: Neutron rules can't be edited,
    only replaced, and their order means nothing."""
    ports = (
        ""
        if r.get("port_range_min") is None
        else f" {r['port_range_min']}"
        + (
            ""
            if r.get("port_range_max") in (None, r["port_range_min"])
            else f"-{r['port_range_max']}"
        )
    )
    remote = r.get("remote_ip_prefix") or (
        f"group {r['remote_group_id'][:8]}" if r.get("remote_group_id") else "any"
    )
    side = "from" if r.get("direction") == "ingress" else "to"
    return (
        f"{r.get('direction', '')} {r.get('ethertype', '')} {r.get('protocol') or 'any'}"
        f"{ports} {side} {remote}"
    )


def security_groups(records: list[dict]) -> dict:
    return {
        g["id"]: _item(
            g["name"],
            g.get("project_id"),
            description=g.get("description") or "",
            rules={rule_signature(r): r.get("description") or "" for r in g["rules"]},
        )
        for g in records
    }


def aggregates(records: list[dict]) -> dict:
    return {
        str(a["id"]): _item(
            a["name"],
            None,
            availability_zone=a.get("availability_zone"),
            metadata=dict(a.get("metadata") or {}),
            hosts={(h.get("hostname") or h.get("service_host")): "" for h in a.get("hosts") or []},
        )
        for a in records
    }


def hosts(hypervisors: list[dict], overcommit_hosts: list[dict]) -> dict:
    """Host configuration, not load: what changes when someone upgrades, disables or re-tunes a
    host. Placement's allocation ratio and reserved come from the overcommit rows."""
    alloc = {h["id"]: h for h in overcommit_hosts}
    out = {}
    for h in hypervisors:
        a = alloc.get(h["id"]) or {}
        cpu, mem = a.get("cpu") or {}, a.get("memory") or {}
        out[h["id"]] = _item(
            h["hostname"],
            None,
            state=h.get("state"),
            status=h.get("status"),
            hypervisor_version=h.get("hypervisor_version"),
            os_version=h.get("os_version"),
            cpu_model=h.get("cpu_model"),
            host_cpus=h.get("vcpus_total"),
            memory_mb=h.get("memory_mb_total"),
            cpu_allocation_ratio=cpu.get("ratio"),
            cpu_reserved=cpu.get("reserved"),
            ram_allocation_ratio=mem.get("ratio"),
            ram_reserved_mb=mem.get("reserved"),
        )
    return out


def quotas(
    projects: list[dict], nova: dict[str, dict], cinder: dict[str, dict], neutron: dict[str, dict]
) -> dict:
    """{project id: limits} from each service's quota set. A project whose sets couldn't all be
    read is left out, and kept from the previous snapshot by merge()."""
    out = {}
    for p in projects:
        if p["name"] in HIDDEN_PROJECTS or not (
            p["id"] in nova and p["id"] in cinder and p["id"] in neutron
        ):
            continue
        attrs = {f"compute.{k}": nova[p["id"]].get(k) for k in NOVA_QUOTAS if k in nova[p["id"]]}
        attrs |= {f"block_storage.{k}": v for k, v in sorted(cinder[p["id"]].items()) if k != "id"}
        attrs |= {
            f"network.{k}": neutron[p["id"]].get(k) for k in NEUTRON_QUOTAS if k in neutron[p["id"]]
        }
        out[p["id"]] = _item(p["name"], p["id"], **attrs)
    return out


def merge(prev: dict | None, cur: dict, partial: dict[str, set[str]] | None = None) -> dict:
    """The snapshot to keep: `cur`, with any kind it lacks (its source failed) and any items
    listed in `partial` ({kind: ids that couldn't be read}) taken from `prev`, so a failure
    isn't recorded as everything being removed."""
    out = {k: dict(v) for k, v in cur.items()}
    for kind, items in (prev or {}).items():
        if kind not in out:
            out[kind] = items
            continue
        for item_id in (partial or {}).get(kind, set()):
            if item_id in items and item_id not in out[kind]:
                out[kind][item_id] = items[item_id]
    return out


def _norm(v):
    return json.dumps(v, sort_keys=True, default=str)


def _fields(before: dict, after: dict) -> list[dict]:
    """Changed attributes; dict-valued ones per key ("metadata.zone")."""
    out = []
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k), after.get(k)
        if isinstance(b, dict) or isinstance(a, dict):
            b, a = b or {}, a or {}
            for sk in sorted(set(b) | set(a)):
                if sk not in a:
                    out.append(
                        {"field": f"{k}.{sk}", "op": "removed", "before": b[sk], "after": None}
                    )
                elif sk not in b:
                    out.append(
                        {"field": f"{k}.{sk}", "op": "added", "before": None, "after": a[sk]}
                    )
                elif _norm(b[sk]) != _norm(a[sk]):
                    out.append(
                        {"field": f"{k}.{sk}", "op": "changed", "before": b[sk], "after": a[sk]}
                    )
        elif _norm(b) != _norm(a):
            out.append({"field": k, "op": "changed", "before": b, "after": a})
    return out


def severity(kind: str, change: str, fields: list[dict]) -> str:
    """high: a security group's rules added or removed, a host going down, disabled or gone,
    an aggregate losing a host. medium: everything else."""
    if kind == "security_groups" and any(
        f["field"].startswith("rules.") and f["op"] != "changed" for f in fields
    ):
        return "high"
    if kind == "hosts":
        if change == "removed":
            return "high"
        for f in fields:
            if (f["field"] == "state" and f["after"] != "up") or (
                f["field"] == "status" and f["after"] != "enabled"
            ):
                return "high"
    if kind == "aggregates" and any(
        f["field"].startswith("hosts.") and f["op"] == "removed" for f in fields
    ):
        return "high"
    return "medium"


def diff(prev: dict, cur: dict) -> list[dict]:
    """What changed from `prev` to `cur`, for the kinds in both."""
    out = []
    for kind in KINDS:
        if kind not in prev or kind not in cur:
            continue
        p, c = prev[kind], cur[kind]
        for item_id in sorted(set(p) | set(c)):
            if item_id not in p:
                change, fields, it = "added", [], c[item_id]
            elif item_id not in c:
                change, fields, it = "removed", [], p[item_id]
            else:
                fields = _fields(p[item_id]["attrs"], c[item_id]["attrs"])
                if not fields and p[item_id]["name"] == c[item_id]["name"]:
                    continue
                if p[item_id]["name"] != c[item_id]["name"]:
                    fields.insert(
                        0,
                        {
                            "field": "name",
                            "op": "changed",
                            "before": p[item_id]["name"],
                            "after": c[item_id]["name"],
                        },
                    )
                change, it = "modified", c[item_id]
            out.append(
                {
                    "kind": kind,
                    "item_id": item_id,
                    "name": it["name"],
                    "project_id": it.get("project_id"),
                    "change": change,
                    "fields": fields,
                    "severity": severity(kind, change, fields),
                }
            )
    return out


def describe(c: dict) -> str:
    """One line for alerts: "flavor m1.large modified: vcpus 4 → 8"."""
    head = f"{LABEL[c['kind']]} {c['name']} {c['change']}"
    if not c["fields"]:
        return head
    parts = []
    for f in c["fields"][:3]:
        if f["op"] == "added":
            parts.append(f"+{f['field']}")
        elif f["op"] == "removed":
            parts.append(f"-{f['field']}")
        else:
            parts.append(f"{f['field']} {f['before']} → {f['after']}")
    more = len(c["fields"]) - 3
    return f"{head}: " + "; ".join(parts) + (f" (+{more} more)" if more > 0 else "")
