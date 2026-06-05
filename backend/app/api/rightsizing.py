from fastapi import APIRouter, HTTPException

from app.agent.collector import _clean_analysis
from app.services.db import cache_get

router = APIRouter(prefix="/rightsizing", tags=["rightsizing"])


@router.get("/recommendations")
async def rightsizing_recommendations():
    data, _ = cache_get("rightsizing:recommendations")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "rightsizing:recommendations"})
    for rec in data:
        if rec.get("analysis"):
            rec["analysis"] = _clean_analysis(rec["analysis"])
    return data
