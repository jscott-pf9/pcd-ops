from fastapi import APIRouter, HTTPException

from app.services.db import cache_get

router = APIRouter(prefix="/anomaly", tags=["anomaly"])


@router.get("/")
async def detect_anomalies():
    """The latest statistical anomalies: VMs and hosts whose last hour is far from their usual
    (z-score against the same hour on earlier days, or the whole window while history is short),
    each with now, usual, z, severity, since and a 48-hour sparkline. `explanation` is the AI's
    reading of them, when AI is on; `explanation_current` says whether it covers these findings."""
    data, _ = cache_get("anomaly:latest")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "anomaly:latest"})
    exp, at = cache_get("anomaly:explanation")
    ids = {f["id"] for f in data.get("findings", [])}
    current = bool(exp and exp.get("text")) and set(exp.get("finding_ids") or []) == ids
    return {**data, "explanation": (exp or {}).get("text"), "explanation_at": at,
            "explanation_current": current}
