from functools import lru_cache

from app.config import settings
from app.services.ai.base import AIProvider
from app.services.ai.claude import ClaudeProvider
from app.services.ai.ollama import OllamaProvider
from app.services.openstack import get_connection
from app.services.prometheus import prometheus_client


@lru_cache
def get_ai_provider() -> AIProvider:
    if settings.ai_backend == "claude":
        return ClaudeProvider(settings.ai_api_key)
    # Default: ollama (or any OpenAI-compatible endpoint via ai_url)
    return OllamaProvider(settings.ai_url, settings.ai_model)


__all__ = ["get_connection", "prometheus_client", "get_ai_provider"]
