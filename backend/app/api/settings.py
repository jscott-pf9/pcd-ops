from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings
from app.services import settings_store

router = APIRouter()

# App settings only. PCD itself is reached with the logged-in user's token or the background
# application credential (app/api/access.py), never a stored account (APPLIANCE_STANDARD §7.8).
_SECRETS = ("grafana_token", "ai_api_key")


class SettingsPayload(BaseModel):
    prometheus_url: str = ""
    grafana_url: str = ""
    grafana_token: str = ""
    ai_backend: str = "ollama"
    ai_url: str = ""
    ai_model: str = ""
    ai_api_key: str = ""
    # AI feature toggles
    ai_rightsizing_enabled: bool = True
    ai_anomaly_enabled: bool = True
    ai_logs_enabled: bool = True
    ai_capacity_enabled: bool = True
    # AI analysis schedules
    ai_rightsizing_schedule: str = "daily@02:00"
    ai_anomaly_schedule: str = "hourly"


@router.get("/settings")
async def get_settings():
    """Return the app settings; token and API key fields are masked with '***'."""
    def mask(field: str) -> str:
        val = getattr(settings, field, "")
        return "***" if val else ""

    return {
        "prometheus_url": settings.prometheus_url,
        "grafana_url": settings.grafana_url,
        "grafana_token": mask("grafana_token"),
        "ai_backend": settings.ai_backend,
        "ai_url": settings.ai_url,
        "ai_model": settings.ai_model,
        "ai_api_key": mask("ai_api_key"),
        "ai_rightsizing_enabled":  getattr(settings, "ai_rightsizing_enabled", True),
        "ai_anomaly_enabled":      getattr(settings, "ai_anomaly_enabled", True),
        "ai_logs_enabled":         getattr(settings, "ai_logs_enabled", True),
        "ai_capacity_enabled":     getattr(settings, "ai_capacity_enabled", True),
        "ai_rightsizing_schedule": getattr(settings, "ai_rightsizing_schedule", "daily@02:00"),
        "ai_anomaly_schedule":     getattr(settings, "ai_anomaly_schedule", "hourly"),
    }


@router.put("/settings")
async def update_settings(payload: SettingsPayload):
    """Update runtime settings; fields with value '***' or '' for secrets are preserved from the current config."""
    stored = settings_store.load()
    incoming = payload.model_dump()

    for key, value in incoming.items():
        # Skip masked sentinel — keep whatever is already stored/in-memory
        if key in _SECRETS and value in ("***", ""):
            continue
        # Booleans are always saved (False is a valid value, not "blank")
        if isinstance(value, bool):
            stored[key] = value
        elif value != "":
            stored[key] = value
        elif key not in _SECRETS:
            # Allow blanking non-secret fields
            stored[key] = value

    settings_store.save(stored)

    for key, value in stored.items():
        if hasattr(settings, key):
            setattr(settings, key, value)

    return {"status": "saved"}
