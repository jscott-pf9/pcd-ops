import asyncio
from collections.abc import Callable

import openstack.connection
from fastapi import APIRouter, Depends, HTTPException
from openstack import exceptions as os_exc

from app.services import db
from app.services.db import cache_get
from app.services.openstack import user_connection

router = APIRouter(prefix="/reclamation", tags=["reclamation"])


@router.get("/candidates")
async def reclamation_candidates():
    """Everything Reclamation & Warnings lists, by category (services/reclamation.py), with
    `notes` saying why a category couldn't be checked, `idle_rule` and `orphan_check`."""
    data, _ = cache_get("reclamation:candidates")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "reclamation:candidates"})
    return data


_STATUS = ((os_exc.ResourceNotFound, 404), (os_exc.ConflictException, 409),
           (os_exc.ForbiddenException, 403), (os_exc.BadRequestException, 400))


# ── Mutations stay live (no caching), with the signed-in user's token ─────────────

async def _reclaim(event: str, what: str, item_id: str,
                   act: Callable[[], str | None], result: dict) -> dict:
    """Run `act` (returns the item's display name), log the outcome ("Delete port failed",
    "Deleted port: x"), and turn PCD's refusal into the same status code with its message."""
    verb, noun = what.split(" ", 1)
    done = f"{verb}d {noun}"
    try:
        name = await asyncio.to_thread(act) or item_id[:8]
    except HTTPException as e:
        db.event_log(event, f"{what} failed", level="error", detail=str(e.detail),
                     component="Reclamation")
        raise
    except os_exc.SDKException as e:
        code = getattr(e, "status_code", None) or next(
            (c for t, c in _STATUS if isinstance(e, t)), None)
        status = code if isinstance(code, int) and 400 <= code < 500 else 502
        detail = getattr(e, "details", None) or str(e)
        db.event_log(event, f"{what} failed", level="error", detail=detail, component="Reclamation")
        raise HTTPException(status, detail=detail) from None
    db.event_log(event, f"{done}: {name}", level="success", component="Reclamation")
    return result


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str,
                        conn: openstack.connection.Connection = Depends(user_connection)):
    """Force-delete a server (irreversible)."""
    def act():
        name = conn.compute.get_server(server_id).name
        conn.compute.delete_server(server_id, force=True)
        return name
    return await _reclaim("server_delete", "Delete server", server_id, act, {"deleted": server_id})


@router.delete("/volumes/{volume_id}")
async def delete_volume(volume_id: str,
                        conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete a Cinder volume (irreversible)."""
    def act():
        name = conn.block_storage.get_volume(volume_id).name
        conn.block_storage.delete_volume(volume_id)
        return name
    return await _reclaim("volume_delete", "Delete volume", volume_id, act, {"deleted": volume_id})


@router.delete("/floating_ips/{fip_id}")
async def release_floating_ip(fip_id: str,
                              conn: openstack.connection.Connection = Depends(user_connection)):
    """Release an unused floating IP back to the pool (irreversible)."""
    def act():
        addr = conn.network.get_ip(fip_id).floating_ip_address
        conn.network.delete_ip(fip_id)
        return addr
    return await _reclaim("fip_release", "Release floating IP", fip_id, act, {"released": fip_id})


@router.delete("/ports/{port_id}")
async def delete_port(port_id: str,
                      conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete an orphaned port, freeing its IP addresses (irreversible)."""
    def act():
        port = conn.network.get_port(port_id)
        conn.network.delete_port(port_id)
        return port.name or ", ".join(f["ip_address"] for f in port.fixed_ips or [])
    return await _reclaim("port_delete", "Delete port", port_id, act, {"deleted": port_id})


@router.delete("/routers/{router_id}")
async def delete_router(router_id: str,
                        conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete a router: detach its interfaces, clear its gateway, then delete it (irreversible)."""
    def act():
        r = conn.network.get_router(router_id)
        for p in conn.network.ports(device_id=router_id):
            if (p.device_owner or "").startswith("network:router_interface"):
                conn.network.remove_interface_from_router(r, port_id=p.id)
        if r.external_gateway_info:
            conn.network.update_router(r, external_gateway_info={})
        conn.network.delete_router(r)
        return r.name
    return await _reclaim("router_delete", "Delete router", router_id, act, {"deleted": router_id})


@router.delete("/networks/{network_id}")
async def delete_network(network_id: str,
                         conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete a network with its subnets; Neutron removes its DHCP and metadata ports. 409 names
    the ports still using it (irreversible)."""
    def act():
        net = conn.network.get_network(network_id)
        try:
            conn.network.delete_network(network_id)
        except os_exc.ConflictException:
            infra = ("network:dhcp", "network:distributed")
            users = [p for p in conn.network.ports(network_id=network_id)
                     if not (p.device_owner or "").startswith(infra)]
            names = ", ".join(f"{p.name or p.id[:8]} ({p.device_owner or 'unbound'})"
                              for p in users)
            raise HTTPException(409, detail=f"Network {net.name or network_id[:8]} is still in use"
                                            + (f" by: {names}" if names else "")) from None
        return net.name
    return await _reclaim("network_delete", "Delete network", network_id, act,
                          {"deleted": network_id})


@router.delete("/server_groups/{group_id}")
async def delete_server_group(group_id: str,
                              conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete a server group (irreversible)."""
    def act():
        name = conn.compute.get_server_group(group_id).name
        conn.compute.delete_server_group(group_id)
        return name
    return await _reclaim("server_group_delete", "Delete server group", group_id, act,
                          {"deleted": group_id})


@router.delete("/images/{image_id}")
async def delete_image(image_id: str,
                       conn: openstack.connection.Connection = Depends(user_connection)):
    """Delete a Glance image or snapshot; 409 if it's protected (irreversible). Deleting a
    volume-backed VM's snapshot image leaves its Cinder snapshots."""
    def act():
        img = conn.image.get_image(image_id)
        if img.is_protected:
            raise HTTPException(409, detail=f"Image {img.name} is protected; "
                                            "unprotect it in PCD first.")
        conn.image.delete_image(image_id)
        return img.name
    return await _reclaim("image_delete", "Delete image", image_id, act, {"deleted": image_id})
