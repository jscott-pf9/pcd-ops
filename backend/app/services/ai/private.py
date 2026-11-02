"""Private AI: a model server on your own network. Ollama's own API when the server is Ollama,
else the OpenAI-compatible API (vLLM, LM Studio, LocalAI, llama.cpp server, ...)."""
import json

import httpx

from app.services.ai.base import SYSTEM_PROMPT, AIProvider

# Which API each base URL speaks, found on first use.
_flavors: dict[str, str] = {}


def base_url(url: str) -> str:
    """http://host:11434, whether it was entered with or without /v1."""
    url = url.strip().rstrip("/")
    return url[:-3] if url.endswith("/v1") else url


class PrivateAIProvider(AIProvider):
    def __init__(self, url: str, model: str, api_key: str = ""):
        self._base_url = base_url(url)
        self._model = model
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    async def _flavor(self, client: httpx.AsyncClient) -> str:
        if self._base_url not in _flavors:
            try:
                r = await client.get(f"{self._base_url}/api/tags", headers=self._headers)
                ollama = r.status_code == 200 and "models" in r.json()
            except (httpx.HTTPError, ValueError):
                ollama = False
            _flavors[self._base_url] = "ollama" if ollama else "openai"
        return _flavors[self._base_url]

    async def analyze(self, prompt: str, context: dict) -> str:
        content = f"{prompt}\n\nContext:\n{json.dumps(context, indent=2)}"
        async with httpx.AsyncClient(timeout=120) as client:
            if await self._flavor(client) == "ollama":
                response = await client.post(
                    f"{self._base_url}/api/generate", headers=self._headers,
                    json={"model": self._model, "prompt": content, "stream": False})
                response.raise_for_status()
                return response.json()["response"]
            response = await client.post(
                f"{self._base_url}/v1/chat/completions", headers=self._headers,
                json={"model": self._model, "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": content},
                ]})
            response.raise_for_status()
            return response.json()["choices"][0]["message"]["content"]

    async def models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=15) as client:
            if await self._flavor(client) == "ollama":
                r = await client.get(f"{self._base_url}/api/tags", headers=self._headers)
                r.raise_for_status()
                return sorted(m["name"] for m in r.json().get("models", []))
            r = await client.get(f"{self._base_url}/v1/models", headers=self._headers)
            r.raise_for_status()
            return sorted(m["id"] for m in r.json().get("data", []))
