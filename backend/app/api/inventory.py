import asyncio

import openstack
from fastapi import APIRouter, Depends, HTTPException

from app.services import exporters
from app.services.db import cache_get, cache_set
from app.services.openstack import user_connection

router = APIRouter(prefix="/inventory", tags=["inventory"])

EXPORTER_PROBE = "exporters:probe"


def _require(key: str):
    data, _ = cache_get(key)
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": key})
    return data


@router.get("/servers")
async def list_servers():
    """Return all compute instances with status, flavor, hypervisor, security groups, server
    group, project, and latest CPU/memory/network/disk (`metrics`, null without data)."""
    data, _ = cache_get("metrics:vms")
    vms = (data or {}).get("vms", {})
    return [{**s, "metrics": vms.get(s["id"])} for s in _require("inventory:servers")]


def _with_metrics(hypervisors: list[dict]) -> list[dict]:
    """Each hypervisor with its latest CPU, memory, disk and network (`metrics`, null without
    data) and where they came from (`metrics_source`: local or pcd)."""
    data, _ = cache_get("metrics:hosts")
    hosts = (data or {}).get("hosts", {})
    source = (data or {}).get("source")
    return [{**h, "metrics": hosts.get(h["id"]), "metrics_source": source} for h in hypervisors]


@router.get("/hypervisors")
async def list_hypervisors():
    """Return all hypervisors with CPU/RAM/disk capacity, current utilization, and live load
    (`metrics`) from PCD Ops' metrics store or PCD's Grafana."""
    return _with_metrics(_require("inventory:hypervisors"))


@router.get("/hypervisors/exporters")
async def exporter_probe():
    """The last exporter probe: per hypervisor, whether node-exporter (:9388) and
    libvirt-exporter (:9177) answered, and what they serve."""
    data, probed_at = cache_get(EXPORTER_PROBE)
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": EXPORTER_PROBE})
    return {"probed_at": probed_at, "hosts": data}


@router.post("/hypervisors/probe-exporters")
async def probe_exporters():
    """Probe the exporters on every hypervisor that is up, from this appliance."""
    hosts = await exporters.probe_hosts(_require("inventory:hypervisors"))
    probed_at = cache_set(EXPORTER_PROBE, hosts)
    return {"probed_at": probed_at, "hosts": hosts}


@router.get("/volumes")
async def list_volumes():
    """Return all Cinder volumes with size, status, and attachment info."""
    return _require("inventory:volumes")


@router.get("/networks")
async def list_networks():
    """Return all Neutron networks with external/shared flags and project ownership."""
    return _require("inventory:networks")


_HIDDEN_TENANTS = {"admin", "service"}

@router.get("/tenants")
async def list_tenants(all: bool = False):
    """Return the projects/tenants to pick from (admin and service excluded). `all=true`: every
    project but admin (PCD's hidden background tenant), for showing names."""
    hidden = {"admin"} if all else _HIDDEN_TENANTS
    return [t for t in _require("inventory:tenants") if t.get("name", "").lower() not in hidden]


@router.get("/summary")
async def summary():
    """Return an inventory summary: server counts, volume sizes, floating IP usage, and image count."""
    return _require("inventory:summary")


@router.get("/floating_ips")
async def list_floating_ips():
    """Return all floating IPs with association status and project info."""
    return _require("inventory:floating_ips")


@router.get("/images")
async def list_images():
    """Return all Glance images with visibility, size, and disk format."""
    return _require("inventory:images")


@router.get("/security_groups")
async def list_security_groups():
    """Return all security groups with their rules."""
    return _require("inventory:security_groups")


@router.get("/topology")
async def topology():
    """Return graph nodes + edges for the topology view."""
    servers    = _require("inventory:servers")
    hypervisors = _with_metrics(_require("inventory:hypervisors"))
    volumes    = _require("inventory:volumes")
    networks   = _require("inventory:networks")

    nodes, edges = [], []

    # Hypervisor nodes
    for h in hypervisors:
        nodes.append({"id": f"hyp:{h['hostname']}", "type": "hypervisor", "data": h})

    # Server nodes + hypervisor→VM edges
    for s in servers:
        nodes.append({"id": f"vm:{s['id']}", "type": "vm", "data": s})
        hyp = s.get("hypervisor_hostname")
        if hyp:
            edges.append({"id": f"e:hyp:{hyp}->vm:{s['id']}", "source": f"hyp:{hyp}", "target": f"vm:{s['id']}", "type": "hosts"})

    # Volume nodes + VM→Volume edges
    for v in volumes:
        nodes.append({"id": f"vol:{v['id']}", "type": "volume", "data": v})
        for server_id in (v.get("attached_to") or []):
            edges.append({"id": f"e:vm:{server_id}->vol:{v['id']}", "source": f"vm:{server_id}", "target": f"vol:{v['id']}", "type": "attached"})

    # Network nodes + VM→Network edges (via shared tenant)
    for n in networks:
        nodes.append({"id": f"net:{n['id']}", "type": "network", "data": n})
    # Link VMs to networks by matching project_id (tenant networks)
    net_by_project = {}
    for n in networks:
        pid = n.get("project_id")
        if pid:
            net_by_project.setdefault(pid, []).append(n["id"])
    for s in servers:
        for net_id in net_by_project.get(s.get("project_id", ""), []):
            edges.append({"id": f"e:vm:{s['id']}->net:{net_id}", "source": f"vm:{s['id']}", "target": f"net:{net_id}", "type": "network"})

    return {"nodes": nodes, "edges": edges}


@router.get("/clusters")
async def list_clusters():
    """Return host aggregates (`kind` "cluster" for PCD clusters, which are pf9-managed
    aggregates) with their hosts, VM count, and vCPU/RAM totals and allocation."""
    return _require("inventory:clusters")


@router.get("/storage_backends")
async def list_storage_backends():
    """Return Cinder backends: pools grouped by backend (a shared store, reported by every host,
    counted once), capacity, free, used, provisioned against oversubscribed capacity, volumes
    and the volume types that select each."""
    return _require("inventory:storage_backends")


@router.get("/storage_types")
async def list_storage_types():
    """Return volume types: backend, extra specs, QoS, default, encryption, access, volumes."""
    return _require("inventory:storage_types")


@router.get("/server_groups")
async def list_server_groups():
    """Return server groups: policy, rules, members with their hosts, and whether the
    placement satisfies the policy (`status`: ok, violated, not_satisfied, empty)."""
    return _require("inventory:server_groups")


@router.get("/keypairs")
async def list_keypairs():
    """Return all SSH key pairs registered in Nova."""
    data, _ = cache_get("inventory:keypairs")
    return data or []


@router.get("/flavors")
async def list_flavors():
    """Return Nova flavors: vCPUs, RAM, disk, ephemeral, swap, public, extra specs, VM count."""
    return _require("inventory:flavors")


# Never shown: where image data lives (store URLs can carry credentials) and API bookkeeping
_HIDDEN = {"location", "links", "locations", "direct_url", "file", "schema"}


def clean(value):
    """Drop empty values and hidden keys, recursively."""
    if isinstance(value, dict):
        out = {k: clean(v) for k, v in value.items() if k not in _HIDDEN}
        return {k: v for k, v in out.items() if v not in (None, "", [], {})}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def _details(conn: openstack.connection.Connection, kind: str, item_id: str) -> dict:
    body = lambda r: r.to_dict(computed=False)  # noqa: E731
    if kind == "servers":
        server = conn.compute.get_server(item_id)
        return {"properties": body(server),
                "interfaces": [body(i) for i in conn.compute.server_interfaces(item_id)]}
    if kind == "images":
        return {"properties": body(conn.image.get_image(item_id))}
    if kind == "flavors":
        return {"properties": body(conn.compute.get_flavor(item_id, get_extra_specs=True))}
    if kind == "storage_types":
        props = body(conn.block_storage.get_type(item_id))
        r = conn.block_storage.get(f"/types/{item_id}/encryption")
        if r.ok and r.json():
            props["encryption"] = r.json()
        return {"properties": props}
    if kind == "volumes":
        return {"properties": body(conn.block_storage.get_volume(item_id))}
    raise HTTPException(404, detail=f"No details for {kind}")


@router.get("/{kind}/{item_id}/details")
async def item_details(kind: str, item_id: str,
                       conn: openstack.connection.Connection = Depends(user_connection)):
    """Everything PCD reports for one VM, image, flavor, volume type or volume, fetched now
    with the signed-in user's token (metadata, image properties, extra specs, ...)."""
    try:
        return clean(await asyncio.to_thread(_details, conn, kind, item_id))
    except openstack.exceptions.ResourceNotFound:
        raise HTTPException(404, detail="Not found in PCD") from None
    except openstack.exceptions.SDKException as e:
        raise HTTPException(502, detail=f"PCD didn't answer: {e}") from None
