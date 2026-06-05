from abc import ABC, abstractmethod


class AIProvider(ABC):
    @abstractmethod
    async def analyze(self, prompt: str, context: dict) -> str:
        """Submit a structured analysis request and return the model's response."""
        ...
