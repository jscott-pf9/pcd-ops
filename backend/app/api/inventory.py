from fastapi import APIRouter, Depends, HTTPException

import openstack.connection
from app.dependencies import get_connection
from app.services.db import cache_get

router = APIRouter(prefix="/inventory", tags=["inventory"])


def _require(key: str):
    data, _ = cache_get(key)
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": key})
    return data


@router.get("/servers")
async def list_servers():
    return _require("inventory:servers")


@router.get("/hypervisors")
async def list_hypervisors():
    return _require("inventory:hypervisors")


@router.get("/volumes")
async def list_volumes():
    return _require("inventory:volumes")


@router.get("/networks")
async def list_networks():
    return _require("inventory:networks")


_HIDDEN_TENANTS = {"admin", "service"}

@router.get("/tenants")
async def list_tenants():
    return [t for t in _require("inventory:tenants") if t.get("name", "").lower() not in _HIDDEN_TENANTS]


@router.get("/summary")
async def summary():
    return _require("inventory:summary")


@router.get("/floating_ips")
async def list_floating_ips():
    return _require("inventory:floating_ips")


@router.get("/images")
async def list_images():
    return _require("inventory:images")


@router.get("/security_groups")
async def list_security_groups():
    return _require("inventory:security_groups")


@router.get("/topology")
async def topology():
    """Return graph nodes + edges for the topology view."""
    servers    = _require("inventory:servers")
    hypervisors = _require("inventory:hypervisors")
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
