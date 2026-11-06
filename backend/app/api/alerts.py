from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import alerts, db

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("")
async def list_alerts(limit: int = 100):
    """Recent alerts, newest first: source, key, severity, title, body, `results` per channel
    (null = sent, else why not) and whether the cooldown suppressed it."""
    return {"alerts": db.alert_list(max(1, min(limit, 500))), "channels": alerts.configured()}


class TestRequest(BaseModel):
    channel: str | None = None


@router.post("/test")
async def test_alert(body: TestRequest):
    """Send a test alert to one channel (email, webhook, slack) or all of them, whatever the
    alert rules say. Returns {channel: null if sent, else why not}."""
    if body.channel and body.channel not in alerts.CHANNELS:
        raise HTTPException(400, detail=f"Unknown channel {body.channel}")
    return await alerts.test(body.channel)
