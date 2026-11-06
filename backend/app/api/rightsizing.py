from fastapi import APIRouter, HTTPException

from app.agent.collector import _clean_analysis
from app.agent.runner import RIGHTSIZING_ERROR
from app.services import db, rightsizing
from app.services.db import cache_get

router = APIRouter(prefix="/rightsizing", tags=["rightsizing"])


def _last_error() -> str | None:
    """Why the last right-sizing run failed, if it did."""
    for run in db.get_runs(50):
        if (run.get("error") or "").startswith(RIGHTSIZING_ERROR):
            return run["error"][len(RIGHTSIZING_ERROR):]
    return None


@router.get("/recommendations")
async def rightsizing_recommendations():
    """Return VM right-sizing recommendations with CPU/memory usage metrics and AI-generated analysis.
    A suggested flavor carries `fit`: whether a host in the VM's cluster has room for it now
    (fits, same_host, no_room, unknown). 503 no_data until the first run succeeds; `error` says
    why the last one failed."""
    data, _ = cache_get("rightsizing:recommendations")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "rightsizing:recommendations",
                                         "error": _last_error()})
    for rec in data:
        if rec.get("analysis"):
            rec["analysis"] = _clean_analysis(rec["analysis"])
    return rightsizing.with_fit(data, cache_get("capacity:overcommit")[0],
                                cache_get("inventory:clusters")[0])
