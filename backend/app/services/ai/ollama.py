import json

import httpx

from app.services.ai.base import AIProvider


class OllamaProvider(AIProvider):
    def __init__(self, base_url: str, model: str):
        self._base_url = base_url.rstrip("/")
        self._model = model

    async def analyze(self, prompt: str, context: dict) -> str:
        payload = {
            "model": self._model,
            "prompt": f"{prompt}\n\nContext:\n{json.dumps(context, indent=2)}",
            "stream": False,
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self._base_url}/api/generate", json=payload)
            response.raise_for_status()
            return response.json()["response"]
