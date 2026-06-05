from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings
from app.services import settings_store

router = APIRouter()

_SECRETS = ("os_password", "grafana_token", "ai_api_key")


class SettingsPayload(BaseModel):
    os_auth_url: str = ""
    os_username: str = ""
    os_password: str = ""
    os_project_name: str = ""
    os_user_domain_name: str = "Default"
    os_project_domain_name: str = "Default"
    os_region_name: str = ""
    prometheus_url: str = ""
    grafana_url: str = ""
    grafana_token: str = ""
    ai_backend: str = "ollama"
    ai_url: str = ""
    ai_model: str = ""
    ai_api_key: str = ""


@router.get("/settings")
async def get_settings():
    def mask(field: str) -> str:
        val = getattr(settings, field, "")
        return "***" if val else ""

    return {
        "os_auth_url": settings.os_auth_url,
        "os_username": settings.os_username,
        "os_password": mask("os_password"),
        "os_project_name": settings.os_project_name,
        "os_user_domain_name": settings.os_user_domain_name,
        "os_project_domain_name": settings.os_project_domain_name,
        "os_region_name": settings.os_region_name,
        "prometheus_url": settings.prometheus_url,
        "grafana_url": settings.grafana_url,
        "grafana_token": mask("grafana_token"),
        "ai_backend": settings.ai_backend,
        "ai_url": settings.ai_url,
        "ai_model": settings.ai_model,
        "ai_api_key": mask("ai_api_key"),
    }


@router.put("/settings")
async def update_settings(payload: SettingsPayload):
    stored = settings_store.load()
    incoming = payload.model_dump()

    for key, value in incoming.items():
        # Skip masked sentinel — keep whatever is already stored/in-memory
        if key in _SECRETS and value in ("***", ""):
            continue
        if value != "":
            stored[key] = value
        elif key not in _SECRETS:
            # Allow blanking non-secret fields
            stored[key] = value

    settings_store.save(stored)

    for key, value in stored.items():
        if hasattr(settings, key):
            setattr(settings, key, value)

    return {"status": "saved"}
