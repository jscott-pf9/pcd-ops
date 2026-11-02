from app.config import settings
from app.services.ai.base import AIProvider
from app.services.ai.claude import ClaudeProvider
from app.services.ai.private import PrivateAIProvider
from app.services.openstack import get_connection
from app.services.prometheus import prometheus_client


def make_ai_provider(backend: str, url: str, model: str, api_key: str = "") -> AIProvider:
    if backend == "claude":
        return ClaudeProvider(api_key, model)
    # "ollama" (and the old "openai"): Private AI
    return PrivateAIProvider(url, model, api_key)


def get_ai_provider() -> AIProvider:
    """Built from the current settings on every call, so a saved change applies at once."""
    key = settings.ai_api_key if settings.ai_backend == "claude" else settings.ai_private_api_key
    return make_ai_provider(settings.ai_backend, settings.ai_url, settings.ai_model, key)


__all__ = ["get_connection", "prometheus_client", "get_ai_provider", "make_ai_provider"]
