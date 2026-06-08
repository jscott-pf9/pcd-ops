from fastapi import APIRouter, Depends, HTTPException

import openstack.connection
from app.dependencies import get_connection
from app.services.db import cache_get

router = APIRouter(prefix="/reclamation", tags=["reclamation"])


@router.get("/candidates")
async def reclamation_candidates():
    """Return idle VMs (stopped/shelved), unattached volumes, and unused floating IPs eligible for reclamation."""
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
    conn.compute.delete_server(server_id, force=True)
    return {"deleted": server_id}


@router.delete("/volumes/{volume_id}")
async def delete_volume(
    volume_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Delete a Cinder volume (irreversible)."""
    conn.block_storage.delete_volume(volume_id)
    return {"deleted": volume_id}
