import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import openstack.connection
from app.services.openstack import user_connection
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
    conn: openstack.connection.Connection = Depends(user_connection),
):
    """Create a Cinder snapshot of each volume attached to a server (in-use volumes too)."""
    try:
        server = await asyncio.to_thread(conn.compute.get_server, body.server_id)
        volume_ids = [v["id"] for v in (server.attached_volumes or [])]
        if not volume_ids:
            raise HTTPException(400, detail=f"{server.name or body.server_id} has no attached "
                                            "volumes to snapshot.")
        created = []
        for vid in volume_ids:
            name = body.name if len(volume_ids) == 1 else f"{body.name}-{vid[:8]}"
            snap = await asyncio.to_thread(
                lambda v=vid, n=name: conn.block_storage.create_snapshot(volume_id=v, name=n,
                                                                         force=True))
            created.append({"snapshot_id": snap.id, "name": name, "volume_id": vid})
        db.event_log("snapshot_create", f"Snapshot created: {body.name}",
                     detail=f"{len(created)} volume(s) of {server.name or body.server_id}",
                     level="success", component="Snapshots")
        return {"snapshots": created}
    except HTTPException:
        raise
    except Exception as e:
        db.event_log("snapshot_create", f"Snapshot create failed: {body.name}",
                     level="error", detail=str(e), component="Snapshots")
        raise HTTPException(500, detail=str(e))


@router.delete("/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: str,
    conn: openstack.connection.Connection = Depends(user_connection),
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
