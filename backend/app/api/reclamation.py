import openstack.connection
from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_connection
from app.services import db
from app.services.db import cache_get

router = APIRouter(prefix="/reclamation", tags=["reclamation"])


@router.get("/candidates")
async def reclamation_candidates():
    """Return idle VMs, unattached volumes, and unused floating IPs for reclamation."""
    data, _ = cache_get("reclamation:candidates")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "reclamation:candidates"})
    return data


# ── Mutations stay live (no caching) ──────────────────────────────────────────

@router.delete("/servers/{server_id}")
async def delete_server(
    server_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Force-delete a server (irreversible)."""
    try:
        server = conn.compute.get_server(server_id)
        name = getattr(server, "name", None) or server_id[:8]
        conn.compute.delete_server(server_id, force=True)
        db.event_log(
            "server_delete", f"Deleted server: {name}",
            level="success", component="Reclamation",
        )
        return {"deleted": server_id}
    except Exception as e:
        db.event_log(
            "server_delete", "Delete server failed",
            level="error", detail=str(e), component="Reclamation",
        )
        raise HTTPException(500, detail=str(e))


@router.delete("/volumes/{volume_id}")
async def delete_volume(
    volume_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Delete a Cinder volume (irreversible)."""
    try:
        volume = conn.block_storage.get_volume(volume_id)
        name = getattr(volume, "name", None) or volume_id[:8]
        conn.block_storage.delete_volume(volume_id)
        db.event_log(
            "volume_delete", f"Deleted volume: {name}",
            level="success", component="Reclamation",
        )
        return {"deleted": volume_id}
    except Exception as e:
        db.event_log(
            "volume_delete", "Delete volume failed",
            level="error", detail=str(e), component="Reclamation",
        )
        raise HTTPException(500, detail=str(e))


@router.delete("/floating_ips/{fip_id}")
async def release_floating_ip(
    fip_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Release an unused floating IP back to the pool (irreversible)."""
    try:
        fip = conn.network.get_ip(fip_id)
        addr = getattr(fip, "floating_ip_address", None) or fip_id[:8]
        conn.network.delete_ip(fip_id)
        db.event_log(
            "fip_release", f"Released floating IP: {addr}",
            level="success", component="Reclamation",
        )
        return {"released": fip_id}
    except Exception as e:
        db.event_log(
            "fip_release", "Release floating IP failed",
            level="error", detail=str(e), component="Reclamation",
        )
        raise HTTPException(500, detail=str(e))
