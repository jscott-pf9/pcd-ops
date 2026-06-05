import json

import anthropic

from app.services.ai.base import AIProvider


class ClaudeProvider(AIProvider):
    def __init__(self, api_key: str):
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    async def analyze(self, prompt: str, context: dict) -> str:
        message = await self._client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            system="You are an infrastructure operations analyst for a Platform9 Private Cloud Director environment. Provide concise, actionable recommendations.",
            messages=[
                {
                    "role": "user",
                    "content": f"{prompt}\n\nContext:\n{json.dumps(context, indent=2)}",
                }
            ],
        )
        return message.content[0].text
