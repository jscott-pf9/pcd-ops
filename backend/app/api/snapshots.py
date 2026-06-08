from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import openstack.connection
from app.dependencies import get_connection
from app.services.db import cache_get

router = APIRouter(prefix="/snapshots", tags=["snapshots"])


class SnapshotCreate(BaseModel):
    server_id: str
    name: str


@router.get("/")
async def list_snapshots():
    """Return all volume snapshots with size, status, and creation time."""
    data, _ = cache_get("snapshots:list")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "snapshots:list"})
    return data


@router.post("/")
async def create_snapshot(
    body: SnapshotCreate,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Create a snapshot of a server's volumes by calling the Nova createImage action."""
    server = conn.compute.get_server(body.server_id)
    snapshot = conn.compute.create_server_image(server, name=body.name)
    return {"snapshot_id": snapshot.id, "name": snapshot.name}


@router.delete("/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Delete a Cinder volume snapshot (irreversible)."""
    conn.block_storage.delete_snapshot(snapshot_id)
    return {"deleted": snapshot_id}
