from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException

from app.services import db, drift

router = APIRouter(prefix="/drift", tags=["drift"])


@router.get("/changes")
async def list_changes(kind: str | None = None, days: int | None = None, q: str | None = None,
                       limit: int = 500):
    """The config change log, newest first: flavors, security groups, aggregates, hosts and
    quotas added, removed or modified between collections, each with its changed fields
    ({field, op: added|removed|changed, before, after}) and severity. Filter by `kind`, the
    last `days`, and `q` (item name or field)."""
    if kind and kind not in drift.KINDS:
        raise HTTPException(400, detail=f"kind must be one of {', '.join(drift.KINDS)}")
    since = (datetime.utcnow() - timedelta(days=days)).isoformat() if days else None
    return db.drift_list(kind, since, (q or "").strip() or None, max(1, min(limit, 5000)))


@router.get("/status")
async def change_log_status():
    """When the change log started, the last collection, items tracked per kind, notes on what
    couldn't be read, and changes per kind in the last 24 hours and 7 days."""
    status, _ = db.cache_get("drift:status")
    if status is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "drift:status"})
    now = datetime.utcnow()
    return {**status,
            "counts_24h": db.drift_counts((now - timedelta(days=1)).isoformat()),
            "counts_7d": db.drift_counts((now - timedelta(days=7)).isoformat())}
