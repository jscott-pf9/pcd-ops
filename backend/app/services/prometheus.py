"""Prometheus (VictoriaMetrics in PCD) through the Grafana data source proxy.

Only the Grafana token has to be entered:
- Grafana is at https://<PCD host>/grafana unless Settings says otherwise (default_grafana_url).
- The Prometheus data source is looked up in Grafana (find_datasource) unless Settings has a
  Prometheus URL. The lookup is cached per Grafana URL and token, so saving either redoes it.
"""
from datetime import datetime
from urllib.parse import urlsplit

import httpx

from app.appliance import connection as pcd
from app.config import settings

TIMEOUT_S = 30
PROMETHEUS_TYPES = ("prometheus",)


class MetricsNotConfigured(RuntimeError):
    """No Grafana token, or no Prometheus data source could be found."""


def default_grafana_url() -> str:
    """https://<host>/grafana for the PCD in PCD_AUTH_URL; empty if that isn't known."""
    parts = urlsplit(pcd.load().auth_url)
    return f"{parts.scheme}://{parts.netloc}/grafana" if parts.scheme and parts.netloc else ""


def grafana_url() -> str:
    return (settings.grafana_url or default_grafana_url()).rstrip("/")


async def find_datasource(grafana: str, token: str) -> dict:
    """The Prometheus data source Grafana offers this token: {name, uid, url}, where url is its
    proxy URL. /api/frontend/settings lists the data sources any role may query, so a Viewer
    service account is enough (/api/datasources needs admin)."""
    if not grafana:
        raise MetricsNotConfigured("The Grafana URL isn't known; enter it in "
                                   "Settings → Connection.")
    if not token:
        raise MetricsNotConfigured("Add a Grafana service account token in Settings → Connection.")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.get(f"{grafana}/api/frontend/settings",
                                 headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as e:
        raise MetricsNotConfigured(f"Can't reach Grafana at {grafana}: {e}") from None
    if r.status_code in (401, 403):
        raise MetricsNotConfigured(f"Grafana refused the token (HTTP {r.status_code}).")
    if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
        raise MetricsNotConfigured(f"{grafana} doesn't look like Grafana (HTTP {r.status_code}).")
    sources = [d for d in (r.json().get("datasources") or {}).values()
               if d.get("type") in PROMETHEUS_TYPES]
    if not sources:
        raise MetricsNotConfigured("Grafana has no Prometheus data source this token can use.")
    ds = next((d for d in sources if d.get("isDefault")), sources[0])
    proxy = (f"{grafana}/api/datasources/proxy/{ds['id']}" if ds.get("id") is not None
             else f"{grafana}/api/datasources/proxy/uid/{ds['uid']}")
    return {"name": ds.get("name", ""), "uid": ds.get("uid", ""), "url": proxy}


_found: dict[tuple[str, str], dict] = {}


async def resolve() -> dict:
    """Where queries go: {url, source: "settings"|"grafana", name}."""
    if settings.prometheus_url:
        return {"url": settings.prometheus_url.rstrip("/"), "source": "settings", "name": ""}
    key = (grafana_url(), settings.grafana_token)
    if key not in _found:
        _found.clear()
        _found[key] = await find_datasource(*key)
    return {**_found[key], "source": "grafana"}


class PrometheusClient:
    """Queries Prometheus. Without arguments it follows the current settings."""

    def __init__(self, base_url: str = "", auth_token: str = ""):
        self._base_url = base_url.rstrip("/")
        self._token = auth_token

    async def _target(self) -> tuple[str, dict]:
        base = self._base_url or (await resolve())["url"]
        token = self._token or settings.grafana_token
        return base, ({"Authorization": f"Bearer {token}"} if token else {})

    async def _get(self, path: str, params: dict | None = None):
        base, headers = await self._target()
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.get(f"{base}{path}", params=params, headers=headers)
            response.raise_for_status()
            return response.json().get("data", {})

    async def query(self, promql: str) -> list[dict]:
        return (await self._get("/api/v1/query", {"query": promql})).get("result", [])

    async def query_range(
        self,
        promql: str,
        start: datetime,
        end: datetime,
        step: str = "5m",
    ) -> list[dict]:
        data = await self._get("/api/v1/query_range", {
            "query": promql,
            "start": start.timestamp(),
            "end": end.timestamp(),
            "step": step,
        })
        return data.get("result", [])

    async def label_values(self, label: str) -> list[str]:
        return await self._get(f"/api/v1/label/{label}/values") or []


prometheus_client = PrometheusClient()
