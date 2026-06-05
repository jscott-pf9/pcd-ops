from fastapi import APIRouter, HTTPException

from app.services.db import cache_get

router = APIRouter(prefix="/anomaly", tags=["anomaly"])


@router.get("/")
async def detect_anomalies():
    data, _ = cache_get("anomaly:latest")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "anomaly:latest"})
    return data
