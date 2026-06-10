from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.services import db

router = APIRouter(tags=["events"])


class AppEvent(BaseModel):
    id: str
    event_type: str
    level: str
    title: str
    detail: str | None = None
    component: str | None = None
    tenant: str | None = None
    timestamp: str


@router.get("/events", response_model=list[AppEvent])
def list_events(limit: int = Query(default=100, le=500)):
    return db.get_recent_events(limit)
