"""Can PCD Ops reach the exporters on each hypervisor, and what do they serve?

PCD runs node-exporter (:9388) and libvirt-exporter (:9177) on every hypervisor. Scraping them
directly gives full-resolution data that PCD's Grafana doesn't keep; this probe answers whether
that works from where the appliance sits (reachable, plain http or TLS, authentication) and what
the exporters serve, before anything is scraped.
"""
import asyncio
import re

import httpx

EXPORTERS = {"node": 9388, "libvirt": 9177}
TIMEOUT_S = 3
# Label names and an example sample are kept for these families: the ones a scraper joins on.
DETAIL_PREFIXES = ("libvirt_domain_info", "node_uname_info")

_SAMPLE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s")
_LABEL = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def parse(text: str) -> dict:
    """Series count, series per metric family, and label names (with one example) for the
    families in DETAIL_PREFIXES."""
    families: dict[str, int] = {}
    details: dict[str, dict] = {}
    series = 0
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = _SAMPLE.match(line)
        if not m:
            continue
        name = m.group(1)
        series += 1
        families[name] = families.get(name, 0) + 1
        if name.startswith(DETAIL_PREFIXES) and name not in details:
            labels = dict(_LABEL.findall(m.group(3) or ""))
            details[name] = {"labels": sorted(labels), "example": labels}
    return {"series": series, "families": families, "details": details}


async def probe_exporter(ip: str, port: int) -> dict:
    """{status, url, ...}: status is ok, refused, timeout, auth, tls, http or error."""
    url = f"http://{ip}:{port}/metrics"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.get(url)
    except httpx.TimeoutException:
        return {"status": "timeout", "url": url}
    except httpx.ConnectError as e:
        root = _root_cause(e)
        return {"status": "refused" if isinstance(root, ConnectionRefusedError) else "error",
                "url": url, "error": str(root)[:200]}
    except httpx.HTTPError as e:
        # A TLS server answering plain http usually just drops the connection.
        return await _probe_https(ip, port, url, str(e))
    if r.status_code == 400 and "https" in r.text.lower():
        return await _probe_https(ip, port, url, r.text)
    if r.status_code in (401, 403):
        return {"status": "auth", "url": url, "http_status": r.status_code}
    if r.status_code != 200:
        return {"status": "http", "url": url, "http_status": r.status_code}
    return {"status": "ok", "url": url, **parse(r.text)}


def _root_cause(e: BaseException) -> BaseException:
    """httpx reports every failed connect as "All connection attempts failed"; the reason
    (refused, no route, DNS) is at the bottom of the exception chain."""
    while e.__cause__ or e.__context__:
        e = e.__cause__ or e.__context__
    return e


async def _probe_https(ip: str, port: int, http_url: str, why: str) -> dict:
    """The exporter seems to want TLS: say so, and whether https works without a trusted cert."""
    url = f"https://{ip}:{port}/metrics"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, verify=False) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        return {"status": "error", "url": http_url, "error": f"{why[:100]}; https: {e}"[:200]}
    if r.status_code in (401, 403):
        return {"status": "auth", "url": url, "tls": True, "http_status": r.status_code}
    if r.status_code != 200:
        return {"status": "http", "url": url, "tls": True, "http_status": r.status_code}
    return {"status": "tls", "url": url, "tls": True, **parse(r.text)}


async def probe_hosts(hypervisors: list[dict]) -> list[dict]:
    """Probe both exporters on every hypervisor that is up and has an IP, concurrently."""
    hosts = [h for h in hypervisors if h.get("state") == "up" and h.get("host_ip")]

    async def one(h: dict) -> dict:
        results = await asyncio.gather(*(probe_exporter(h["host_ip"], port)
                                         for port in EXPORTERS.values()))
        return {"hypervisor_id": h.get("id"), "hostname": h.get("hostname"),
                "host_ip": h["host_ip"], **dict(zip(EXPORTERS, results))}

    return list(await asyncio.gather(*(one(h) for h in hosts)))
