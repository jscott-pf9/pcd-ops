import asyncio

import openstack.connection
from fastapi import APIRouter, Depends

from app.agent import runner
from app.services import db
from app.services.openstack import acting_as, user_connection

router = APIRouter(prefix="/agent", tags=["agent"])


@router.get("/status")
async def status():
    """Return agent runner status, domain cache metadata, and recent runs."""
    return {
        "is_running": runner._is_running,
        "domains": db.cache_meta(),
        "recent_runs": db.get_runs(10),
    }


@router.post("/trigger")
async def trigger(slow: bool = False,
                  conn: openstack.connection.Connection = Depends(user_connection)):
    """Trigger an on-demand collection run, as the logged-in user.

    ?slow=true runs all tiers including AI collectors (anomaly, capacity trends, right-sizing).
    Default (slow=false) runs only fast collectors (inventory, snapshots, logs, reclamation).
    """
    if runner._is_running:
        return {"triggered": False, "reason": "already running"}
    with acting_as(conn):   # the task inherits the user's connection
        if slow:
            asyncio.create_task(runner.run_all())
        else:
            asyncio.create_task(runner.run_fast())
    return {"triggered": True, "slow": slow}


@router.get("/runs")
async def runs(limit: int = 50):
    """Return recent agent run history (most recent first)."""
    return db.get_runs(limit)
