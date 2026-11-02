from abc import ABC, abstractmethod

SYSTEM_PROMPT = ("You are an infrastructure operations analyst for a Platform9 Private Cloud "
                 "Director environment. Provide concise, actionable recommendations.")


class AIProvider(ABC):
    @abstractmethod
    async def analyze(self, prompt: str, context: dict) -> str:
        """Submit a structured analysis request and return the model's response."""
        ...

    @abstractmethod
    async def models(self) -> list[str]:
        """The model names the backend offers (for the Settings page)."""
        ...
