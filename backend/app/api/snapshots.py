from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import openstack.connection
from app.dependencies import get_connection
from app.services import db
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
    try:
        server = conn.compute.get_server(body.server_id)
        snapshot = conn.compute.create_server_image(server, name=body.name)
        db.event_log("snapshot_create", f"Snapshot created: {body.name}",
                     level="success", component="Snapshots")
        return {"snapshot_id": snapshot.id, "name": snapshot.name}
    except Exception as e:
        db.event_log("snapshot_create", f"Snapshot create failed: {body.name}",
                     level="error", detail=str(e), component="Snapshots")
        raise HTTPException(500, detail=str(e))


@router.delete("/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: str,
    conn: openstack.connection.Connection = Depends(get_connection),
):
    """Delete a Cinder volume snapshot (irreversible)."""
    try:
        snapshot = conn.block_storage.get_snapshot(snapshot_id)
        name = getattr(snapshot, "name", None) or snapshot_id[:8]
        conn.block_storage.delete_snapshot(snapshot_id)
        db.event_log("snapshot_delete", f"Deleted snapshot: {name}",
                     level="success", component="Snapshots")
        return {"deleted": snapshot_id}
    except Exception as e:
        db.event_log("snapshot_delete", f"Delete snapshot failed",
                     level="error", detail=str(e), component="Snapshots")
        raise HTTPException(500, detail=str(e))
