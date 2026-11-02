import json

import anthropic

from app.services.ai.base import SYSTEM_PROMPT, AIProvider

DEFAULT_MODEL = "claude-opus-5-5"
# Models that take server-side refusal fallbacks ("default" routing): a declined request is
# re-run on a fallback model inside the same call.
_FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}


class ClaudeProvider(AIProvider):
    def __init__(self, api_key: str, model: str = ""):
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        # The Model setting is shared with Private AI; anything that isn't a Claude model means
        # "use the default".
        self.model = model if model.startswith("claude") else DEFAULT_MODEL

    async def analyze(self, prompt: str, context: dict) -> str:
        extra = ({"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
                 if self.model in _FALLBACK_MODELS else {})
        message = await self._client.beta.messages.create(
            model=self.model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": f"{prompt}\n\nContext:\n{json.dumps(context, indent=2)}",
                }
            ],
            **extra,
        )
        if message.stop_reason == "refusal":
            category = message.stop_details.category if message.stop_details else None
            raise RuntimeError(f"Claude declined this request ({category or 'no category'}).")
        return "".join(b.text for b in message.content if b.type == "text")

    async def models(self) -> list[str]:
        return [m.id async for m in self._client.models.list()]
