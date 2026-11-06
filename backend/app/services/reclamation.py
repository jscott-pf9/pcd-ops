"""What could be reclaimed, and what looks wrong (Reclamation & Warnings).

Pure functions over plain records, so every rule is tested on its own. The collector
(agent/collector.py:collect_reclamation) fetches from PCD and the metrics store, turns SDK
objects into records with the *_record functions, and calls these; the resource-reclamation job
(agent/jobs.py) and Right-Sizing use the same rules.

Every candidate carries `id`, `name`, `project_id` and a `reason`. "Since" ages come from
first-seen tracking (db.seen_update): when PCD Ops first saw the item in its category.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime

# PCD's admin project is a hidden background tenant: never shown as a tenant.
HIDDEN_PROJECTS = {"admin"}
# Projects PCD itself uses; hidden from Empty tenants unless asked for.
SYSTEM_PROJECTS = {"service"}

STOPPED = ("SHUTOFF", "ERROR", "SHELVED_OFFLOADED")
# Neutron's own ports: they serve a network, they don't use it.
INFRA_OWNERS = ("network:",)


def _ts(value) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else value


def earliest(*stamps: str | None) -> str | None:
    """The earliest of ISO timestamps, ignoring blanks (they sort as strings once normalised)."""
    vals = [s.replace("Z", "").split("+")[0] for s in stamps if s]
    return min(vals) if vals else None


# ── Records from SDK objects ─────────────────────────────────────────────────────

def server_record(s) -> dict:
    fl = s.flavor or {}
    return {
        "id": s.id, "name": s.name, "status": s.status, "task_state": s.task_state,
        "project_id": s.project_id, "user_id": s.user_id,
        "host": s.compute_host, "hypervisor_hostname": s.hypervisor_hostname,
        "image_id": (s.image or {}).get("id") if isinstance(s.image, dict) else None,
        "vcpus": fl.get("vcpus") or 0, "ram_mb": fl.get("ram") or 0,
        "created_at": _ts(s.created_at), "updated_at": _ts(s.updated_at),
    }


def volume_record(v) -> dict:
    return {
        "id": v.id, "name": v.name or "(unnamed)", "size": v.size or 0, "status": v.status,
        "volume_type": v.volume_type, "availability_zone": v.availability_zone,
        "is_bootable": v.is_bootable, "description": v.description or "",
        "project_id": v.project_id,
        "attachments": [{"server_id": a.get("server_id")} for a in v.attachments or []],
        "image_id": (v.volume_image_metadata or {}).get("image_id"),
        # Glance's Cinder store keeps each image's data in a volume tagged with the image
        "glance_image_id": (v.metadata or {}).get("glance_image_id"),
        "created_at": _ts(v.created_at), "updated_at": _ts(v.updated_at),
    }


def port_record(p) -> dict:
    return {
        "id": p.id, "name": p.name or "", "status": p.status,
        "device_owner": p.device_owner or "", "device_id": p.device_id or "",
        "network_id": p.network_id, "project_id": p.project_id,
        "fixed_ips": [f.get("ip_address") for f in p.fixed_ips or []],
        "subnet_ids": [f.get("subnet_id") for f in p.fixed_ips or []],
        "allowed_ips": [a.get("ip_address") for a in p.allowed_address_pairs or []],
        "created_at": _ts(p.created_at), "updated_at": _ts(p.updated_at),
    }


# ── Compute ──────────────────────────────────────────────────────────────────────

def attached_gb(volumes: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in volumes:
        for a in v["attachments"]:
            if a.get("server_id"):
                out[a["server_id"]] = out.get(a["server_id"], 0) + v["size"]
    return out


def stopped_servers(servers: list[dict], volumes: list[dict]) -> list[dict]:
    """SHUTOFF, ERROR or SHELVED_OFFLOADED. Nova's updated_at is when that last changed."""
    gb = attached_gb(volumes)
    return [{
        "id": s["id"], "name": s["name"], "status": s["status"], "project_id": s["project_id"],
        "updated_at": s["updated_at"], "attached_disk_gb": gb.get(s["id"], 0),
        "vcpus": s["vcpus"], "ram_mb": s["ram_mb"], "reason": s["status"].lower(),
        "since_hint": s["updated_at"],
    } for s in servers if s["status"] in STOPPED]


def is_idle(cpu_pct: float | None, net_bps: float | None, iops: float | None,
            cpu_max: float, net_max_bps: float, iops_max: float) -> bool:
    """Idle: CPU, network and disk I/O all under their thresholds. A metric with no data
    doesn't count against it, but CPU must have data."""
    if cpu_pct is None or cpu_pct >= cpu_max:
        return False
    return (net_bps is None or net_bps < net_max_bps) and (iops is None or iops < iops_max)


def idle_servers(servers: list[dict], stats: dict[str, dict], th: dict) -> list[dict]:
    """ACTIVE VMs whose 95th-percentile CPU, network and IOPS over the window (stats, by server
    id) are under the thresholds. VMs younger than the window are left out."""
    out = []
    for s in servers:
        st = stats.get(s["id"])
        if s["status"] != "ACTIVE" or not st:
            continue
        if s["created_at"] and s["created_at"] > th["window_start"]:
            continue
        if is_idle(st.get("cpu_pct"), st.get("net_bps"), st.get("iops"),
                   th["cpu_pct"], th["net_kbps"] * 1024, th["iops"]):
            out.append({
                "id": s["id"], "name": s["name"], "status": s["status"],
                "project_id": s["project_id"], "vcpus": s["vcpus"], "ram_mb": s["ram_mb"],
                "cpu_pct": st.get("cpu_pct"), "net_bps": st.get("net_bps"), "iops": st.get("iops"),
                "reason": "idle",
            })
    return out


def orphaned_vms(servers: list[dict], domains: list[dict] | None, hosts_up: set[str] | None,
                 host_of: dict[str, str], projects: set[str],
                 deleted_users: set[str]) -> list[dict]:
    """VMs that look wrong:
    - unknown: a hypervisor runs a domain Nova has no server for;
    - missing: Nova places a server on a hypervisor that runs no such domain (or another does);
    - owner_deleted: the server's project or user is gone from Keystone.

    `domains` are libvirt_domain_info_meta label sets (domain, hypervisor_id, instance_name,
    project_name, user_uuid); None when there is no libvirt data. `hosts_up` are hypervisor ids
    whose libvirt exporter answered its last scrape; only those are compared. `host_of` maps a
    server's compute service host or hypervisor hostname to the hypervisor id. Servers in the
    middle of something (task_state set) are skipped."""
    out = []
    by_id = {s["id"]: s for s in servers}
    if domains is not None and hosts_up is not None:
        running: dict[str, set[str]] = {}
        for d in domains:
            if d.get("hypervisor_id") in hosts_up:
                running.setdefault(d["domain"], set()).add(d["hypervisor_id"])
        for d in domains:
            if d.get("hypervisor_id") in hosts_up and d["domain"] not in by_id:
                out.append({
                    "id": d["domain"], "name": d.get("instance_name") or d["domain"],
                    "project_id": None, "project_name": d.get("project_name"),
                    "hypervisor_id": d["hypervisor_id"], "hypervisor": d.get("hypervisor"),
                    "kind": "unknown",
                    "reason": "Running on the host, but PCD has no record of this VM",
                })
        for s in servers:
            if s["task_state"]:
                continue
            hyp = host_of.get(s["host"] or "") or host_of.get(s["hypervisor_hostname"] or "")
            if not hyp or hyp not in hosts_up:
                continue
            on = running.get(s["id"], set())
            if hyp in on:
                continue
            reason = ("PCD places it on this host, but it runs on another one" if on
                      else "PCD places it on this host, but the host doesn't run it")
            out.append({
                "id": s["id"], "name": s["name"], "project_id": s["project_id"],
                "status": s["status"], "hypervisor_id": hyp, "kind": "missing", "reason": reason,
            })
    flagged = {o["id"]: o for o in out}
    for s in servers:
        gone = []
        if s["project_id"] and s["project_id"] not in projects:
            gone.append("project")
        if s["user_id"] and s["user_id"] in deleted_users:
            gone.append("user")
        if not gone:
            continue
        reason = f"Its {' and '.join(gone)} no longer exist{'s' if len(gone) == 1 else ''}"
        if s["id"] in flagged:   # one row per VM, with every reason
            flagged[s["id"]]["reason"] += f"; {reason[0].lower()}{reason[1:]}"
            continue
        out.append({
            "id": s["id"], "name": s["name"], "project_id": s["project_id"],
            "status": s["status"], "kind": "owner_deleted", "reason": reason,
        })
    return out


def empty_server_groups(groups: list[dict]) -> list[dict]:
    return [{
        "id": g["id"], "name": g["name"], "policy": g["policy"], "project_id": g["project_id"],
        "reason": "no members",
    } for g in groups if not g["members"]]


# ── Storage ──────────────────────────────────────────────────────────────────────

def unattached_volumes(volumes: list[dict], image_ids: set[str] | None = None) -> list[dict]:
    """Available volumes with no attachment. Cinder's updated_at changes on detach, so it's a
    floor for how long the volume has been unattached.

    Volumes Glance's Cinder store keeps image data in are never listed while their image
    exists; one whose image is gone is leaked storage and is listed. Without `image_ids` (the
    Glance image ids) no store volume is listed."""
    out = []
    for v in volumes:
        if v["status"] != "available" or v["attachments"]:
            continue
        reason, kind = "unattached", "volume"
        if v.get("glance_image_id"):
            if image_ids is None or v["glance_image_id"] in image_ids:
                continue
            reason, kind = "Glance image store volume; its image was deleted", "image_store"
        out.append({
            **{k: v[k] for k in ("id", "name", "size", "volume_type", "availability_zone",
                                 "is_bootable", "description", "project_id", "created_at",
                                 "updated_at")},
            "reason": reason, "kind": kind, "since_hint": v["updated_at"],
        })
    return out


def image_use(servers: list[dict], volumes: list[dict],
              domains: list[dict] | None = None) -> dict[str, dict[str, int]]:
    """{image id: {"vms": n, "volumes": n}}. A VM uses an image if Nova says it booted from it
    or its libvirt domain's root disk is the image; a volume uses it if made from it."""
    use: dict[str, dict[str, int]] = {}
    vm_images = {s["id"]: s["image_id"] for s in servers if s["image_id"]}
    for d in domains or []:
        if d.get("root_type") == "image" and d.get("root_uuid"):
            vm_images.setdefault(d["domain"], d["root_uuid"])
    for iid in vm_images.values():
        use.setdefault(iid, {"vms": 0, "volumes": 0})["vms"] += 1
    for v in volumes:
        if v["image_id"]:
            use.setdefault(v["image_id"], {"vms": 0, "volumes": 0})["volumes"] += 1
    return use


def unused_images(images: list[dict], use: dict[str, dict[str, int]]) -> list[dict]:
    """Images and snapshots no VM and no volume uses."""
    return [{
        **{k: i.get(k) for k in ("id", "name", "visibility", "status", "size_gb", "is_protected",
                                 "kind", "snapshot_type", "created_at", "updated_at")},
        "project_id": i.get("owner"), "reason": "not used by any VM or volume",
    } for i in images if i["id"] not in use]


# ── Network ──────────────────────────────────────────────────────────────────────

def unused_floating_ips(fips: list[dict]) -> list[dict]:
    return [{
        "id": f["id"], "floating_ip_address": f["floating_ip_address"],
        "project_id": f["project_id"], "name": f["floating_ip_address"],
        "reason": "not associated", "since_hint": f.get("updated_at"),
    } for f in fips if not f.get("port_id")]


def is_consumer(port: dict) -> bool:
    """A port something uses the network through: a VM, a load balancer, a bare-metal node.
    Neutron's own ports (DHCP, metadata, router, floating IP) and unbound ports aren't."""
    owner = port["device_owner"]
    return bool(owner) and not owner.startswith(INFRA_OWNERS)


def orphaned_ports(ports: list[dict], server_ids: set[str], router_ids: set[str]) -> list[dict]:
    """Ports left behind:
    - unbound: no owner and no device (unless its IP is another port's allowed address: a VIP);
    - vm_gone: a compute:* port whose VM no longer exists;
    - router_gone: a router interface whose router no longer exists."""
    vips = {ip for p in ports for ip in p["allowed_ips"] if ip}
    out = []
    for p in ports:
        owner, dev = p["device_owner"], p["device_id"]
        if not owner and not dev:
            if any(ip in vips for ip in p["fixed_ips"]):
                continue
            kind, reason = "unbound", "not attached to anything"
        elif owner.startswith("compute:") and dev and dev not in server_ids:
            kind, reason = "vm_gone", "its VM no longer exists"
        elif owner == "network:router_interface" and dev and dev not in router_ids:
            kind, reason = "router_gone", "its router no longer exists"
        else:
            continue
        out.append({
            "id": p["id"], "name": p["name"] or p["id"][:8], "status": p["status"],
            "network_id": p["network_id"], "fixed_ips": p["fixed_ips"], "device_owner": owner,
            "device_id": dev, "project_id": p["project_id"], "created_at": p["created_at"],
            "kind": kind, "reason": reason, "since_hint": p["updated_at"],
        })
    return out


def network_consumers(ports: list[dict]) -> Counter:
    return Counter(p["network_id"] for p in ports if is_consumer(p))


def unused_routers(routers: list[dict], ports: list[dict], fips: list[dict]) -> list[dict]:
    """Routers nothing goes through: no interfaces, or interfaces only on networks with no VMs,
    and no floating IPs using them."""
    consumers = network_consumers(ports)
    fip_routers = Counter(f.get("router_id") for f in fips if f.get("router_id"))
    out = []
    for r in routers:
        ifaces = [p for p in ports if p["device_id"] == r["id"]
                  and p["device_owner"].startswith("network:router_interface")]
        if fip_routers[r["id"]]:
            continue
        if any(consumers[p["network_id"]] for p in ifaces):
            continue
        out.append({
            "id": r["id"], "name": r["name"] or r["id"][:8], "status": r["status"],
            "project_id": r["project_id"], "gateway": r["gateway"],
            "interfaces": [{"port_id": p["id"], "network_id": p["network_id"],
                            "subnet_ids": p["subnet_ids"], "fixed_ips": p["fixed_ips"]}
                           for p in ifaces],
            "reason": "no interfaces" if not ifaces else "its networks have no VMs",
        })
    return out


def unused_networks(networks: list[dict], ports: list[dict]) -> list[dict]:
    """Tenant networks (not external) with no VM or other consumer on them."""
    consumers = network_consumers(ports)
    routers_on: dict[str, list[str]] = {}
    for p in ports:
        if p["device_owner"].startswith("network:router_interface"):
            routers_on.setdefault(p["network_id"], []).append(p["device_id"])
    return [{
        "id": n["id"], "name": n["name"] or n["id"][:8], "project_id": n["project_id"],
        "shared": n["shared"], "subnets": len(n["subnet_ids"]),
        "routers": routers_on.get(n["id"], []), "created_at": n["created_at"],
        "reason": "no VMs",
    } for n in networks if not n["external"] and not consumers[n["id"]]]


# ── Tenants ──────────────────────────────────────────────────────────────────────

def empty_tenants(projects: list[dict], owned: Counter, role_counts: Counter) -> list[dict]:
    """Projects that own nothing. `owned` counts each project's servers, volumes, snapshots,
    networks, ports, routers, floating IPs, images and non-default security groups. The admin
    project is never listed; system projects are marked so the page can hide them."""
    return [{
        "id": p["id"], "name": p["name"], "project_id": p["id"], "enabled": p["enabled"],
        "description": p.get("description") or "", "domain_id": p.get("domain_id"),
        "system": p["name"] in SYSTEM_PROJECTS or bool(p.get("is_domain")),
        "role_assignments": role_counts[p["id"]], "reason": "owns nothing",
    } for p in projects if p["name"] not in HIDDEN_PROJECTS and not owned[p["id"]]]


# What deleting a candidate frees, for the page's totals.
CATEGORIES = (
    "stopped_servers", "idle_servers", "orphaned_vms", "empty_server_groups",
    "unattached_volumes", "unused_images",
    "unused_floating_ips", "orphaned_ports", "unused_routers", "unused_networks",
    "empty_tenants",
)
