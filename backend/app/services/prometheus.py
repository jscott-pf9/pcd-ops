from datetime import datetime

import httpx

from app.config import settings


class PrometheusClient:
    def __init__(self, base_url: str, auth_token: str = ""):
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}

    async def query(self, promql: str) -> list[dict]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{self._base_url}/api/v1/query",
                params={"query": promql},
                headers=self._headers,
            )
            response.raise_for_status()
            return response.json().get("data", {}).get("result", [])

    async def query_range(
        self,
        promql: str,
        start: datetime,
        end: datetime,
        step: str = "5m",
    ) -> list[dict]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{self._base_url}/api/v1/query_range",
                params={
                    "query": promql,
                    "start": start.timestamp(),
                    "end": end.timestamp(),
                    "step": step,
                },
                headers=self._headers,
            )
            response.raise_for_status()
            return response.json().get("data", {}).get("result", [])

    async def label_values(self, label: str) -> list[str]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{self._base_url}/api/v1/label/{label}/values",
                headers=self._headers,
            )
            response.raise_for_status()
            return response.json().get("data", [])


prometheus_client = PrometheusClient(settings.prometheus_url, settings.grafana_token)
