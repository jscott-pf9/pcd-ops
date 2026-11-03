"""Hypervisor exporters: the probe that says whether PCD Ops can scrape them directly."""

import asyncio

import httpx

from app.services import db, exporters

from .conftest import CSRF

NODE = """\
# HELP node_load1 1m load average.
# TYPE node_load1 gauge
node_load1 0.5
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="0",mode="user"} 7
node_uname_info{machine="x86_64",nodename="hv1",release="6.8.0"} 1
"""
LIBVIRT = """\
libvirt_domain_info_meta{domain="instance-0000002a",uuid="9f0c",instance_name="web-1"} 1
libvirt_domain_info_meta{domain="instance-0000002b",uuid="77aa",instance_name="db-1"} 1
libvirt_domain_info_vcpu_count{domain="instance-0000002a"} 2
"""

HYPERVISORS = [
    {"id": "h1", "hostname": "hv1", "state": "up", "host_ip": "10.0.0.1"},
    {"id": "h2", "hostname": "hv2", "state": "up", "host_ip": "10.0.0.2"},
    {"id": "h3", "hostname": "hv3", "state": "down", "host_ip": "10.0.0.3"},
]


def test_parse_counts_series_and_keeps_join_labels():
    p = exporters.parse(LIBVIRT)
    assert p["series"] == 3
    assert p["families"] == {"libvirt_domain_info_meta": 2, "libvirt_domain_info_vcpu_count": 1}
    meta = p["details"]["libvirt_domain_info_meta"]
    assert meta["labels"] == ["domain", "instance_name", "uuid"]
    assert meta["example"]["uuid"] == "9f0c"


def test_probe_classifies_each_outcome(http):
    _, routes = http

    def refused(r):
        # What httpx raises for a refused connection: the reason is only in the chain.
        try:
            raise ConnectionRefusedError(111, "Connect call failed")
        except ConnectionRefusedError as cause:
            raise httpx.ConnectError("All connection attempts failed", request=r) from cause

    def timeout(r):
        raise httpx.ConnectTimeout("timed out", request=r)

    routes["http://10.0.0.1:9388/"] = lambda r: httpx.Response(200, text=NODE)
    routes["http://10.0.0.1:9177/"] = lambda r: httpx.Response(200, text=LIBVIRT)
    routes["http://10.0.0.2:9388/"] = lambda r: httpx.Response(401)
    routes["http://10.0.0.2:9177/"] = refused
    hosts = asyncio.run(exporters.probe_hosts(HYPERVISORS))
    assert [h["hostname"] for h in hosts] == ["hv1", "hv2"]   # hv3 is down
    hv1, hv2 = hosts
    assert hv1["node"]["status"] == "ok" and hv1["node"]["series"] == 4
    assert "node_uname_info" in hv1["node"]["details"]
    assert hv1["libvirt"]["status"] == "ok"
    assert hv2["node"] == {"status": "auth", "url": "http://10.0.0.2:9388/metrics",
                           "http_status": 401}
    assert hv2["libvirt"]["status"] == "refused"

    routes.clear()
    routes["http://10.0.0.1:9388/"] = timeout
    assert asyncio.run(exporters.probe_exporter("10.0.0.1", 9388))["status"] == "timeout"


def test_probe_detects_tls(http):
    _, routes = http
    routes["http://10.0.0.1:9388/"] = lambda r: httpx.Response(
        400, text="Client sent an HTTP request to an HTTPS server.")
    routes["https://10.0.0.1:9388/"] = lambda r: httpx.Response(200, text=NODE)
    r = asyncio.run(exporters.probe_exporter("10.0.0.1", 9388))
    assert r["status"] == "tls" and r["tls"] and r["series"] == 4


def test_probe_endpoint_caches_results(admin, http):
    _, routes = http
    assert admin.get("/api/inventory/hypervisors/exporters").status_code == 503
    db.cache_set("inventory:hypervisors", HYPERVISORS[:1])
    routes["http://10.0.0.1:9388/"] = lambda r: httpx.Response(200, text=NODE)
    routes["http://10.0.0.1:9177/"] = lambda r: httpx.Response(200, text=LIBVIRT)
    r = admin.post("/api/inventory/hypervisors/probe-exporters", headers=CSRF).json()
    assert r["hosts"][0]["libvirt"]["series"] == 3
    cached = admin.get("/api/inventory/hypervisors/exporters").json()
    assert cached == r


# ── PCD Ops' own metrics store ────────────────────────────────────────────────

import json  # noqa: E402

import pytest  # noqa: E402

from app.config import settings  # noqa: E402
from app.services import local_metrics, metrics_catalog  # noqa: E402

LOCAL = "http://127.0.0.1:8428/api/v1/"


def _vec(label, items):
    """A Prometheus instant-query response: [(label value, number)]."""
    return {"data": {"result": [{"metric": {label: k}, "value": [0, str(v)]} for k, v in items]}}


def test_scrape_config_targets_and_retention(tmp_path):
    jobs = local_metrics.scrape_config()["scrape_configs"]
    assert [j["job_name"] for j in jobs] == ["node", "libvirt"]
    keep = jobs[0]["metric_relabel_configs"][0]
    assert keep["action"] == "keep" and "node_cpu_seconds_total" in keep["regex"]
    assert jobs[1]["file_sd_configs"][0]["files"][0].endswith("targets/libvirt.json")

    settings.metrics_keep_all_series = True
    assert "metric_relabel_configs" not in local_metrics.scrape_config()["scrape_configs"][0]
    settings.metrics_local_enabled = False
    assert local_metrics.scrape_config() == {"scrape_configs": []}
    settings.metrics_local_enabled = True

    assert local_metrics.write_config() is True          # first write
    assert local_metrics.write_config() is False         # unchanged: no restart
    settings.metrics_retention_days = 365
    assert local_metrics.write_config() is True          # retention changed: restart
    d = local_metrics._dir()
    assert (d / "metrics.env").read_text() == "METRICS_RETENTION=365d\n"
    json.loads((d / "scrape.yml").read_text())            # JSON is valid YAML

    assert local_metrics.write_targets(HYPERVISORS) == 3  # down hosts stay listed
    node = json.loads((d / "targets" / "node.json").read_text())
    assert node[0] == {"targets": ["10.0.0.1:9388"], "labels": {
        "hypervisor_id": "h1", "hypervisor": "hv1", "host_ip": "10.0.0.1"}}


def test_metrics_settings_are_checked_and_applied(admin, monkeypatch):
    restarts = []
    monkeypatch.setattr(local_metrics, "available", lambda: True)
    monkeypatch.setattr(local_metrics, "restart", lambda: restarts.append(1))
    bad = admin.put("/api/settings", json={"metrics_retention_days": 45}, headers=CSRF)
    assert bad.status_code == 400
    assert admin.put("/api/settings", json={"metrics_scrape_interval": "5s"},
                     headers=CSRF).status_code == 400
    admin.put("/api/settings", json={"metrics_retention_days": 730}, headers=CSRF)
    admin.put("/api/settings", json={"metrics_scrape_interval": "30s"}, headers=CSRF)
    assert len(restarts) == 1   # only the retention change needs a restart
    assert '"scrape_interval": "30s"' in (local_metrics._dir() / "scrape.yml").read_text()


def test_promql_selectors():
    q = metrics_catalog.promql("host", "cpu_pct", "local")
    assert 'node_cpu_seconds_total{mode="idle"}' in q and "SEL" not in q
    q = metrics_catalog.promql("host", "cpu_pct", "local", 'hypervisor_id="h1"')
    assert '{mode="idle",hypervisor_id="h1"}' in q
    assert metrics_catalog.promql("vm", "mem_pct", "pcd", 'domain="v"') == (
        '100 * sum by (domain) (pcd:vm_mem_usage{domain="v"}) / '
        'sum by (domain) (pcd:vm_mem_total{domain="v"})')
    assert metrics_catalog.promql("vm", "disk_latency_ms", "pcd") is None
    for group in metrics_catalog.GROUPS.values():   # every template fills cleanly
        for m in group.values():
            for t in filter(None, m.values()):
                assert "SEL" in t


@pytest.mark.parametrize("local, days, grafana, min_days, expected", [
    (True, 10, True, 7, "local"),
    (True, 2, True, 7, "pcd"),      # not enough local history yet
    (True, 2, False, 7, "local"),   # but better than nothing
    (False, 0, True, 0, "pcd"),
    (False, 0, False, 0, None),
])
def test_source_choice(monkeypatch, local, days, grafana, min_days, expected):
    async def local_ok():
        return local
    monkeypatch.setattr(metrics_catalog, "_local_ok", local_ok)
    monkeypatch.setattr(metrics_catalog, "_collected_days", lambda: days)
    settings.grafana_token = "glsa_x" if grafana else ""
    assert asyncio.run(metrics_catalog.source(min_days)) == expected


@pytest.fixture(autouse=True)
def fresh_source():
    """The source choice is cached for a minute; each test decides afresh."""
    metrics_catalog.forget_source()
    yield
    metrics_catalog.forget_source()


def _local_store(routes, answers, exact=None):
    """Route the local store's /api/v1/query: exact PromQL first, then by substring."""
    def handler(r):
        q = r.url.params.get("query", "")
        if q in (exact or {}):
            return httpx.Response(200, json=exact[q])
        for needle, body in answers.items():
            if needle in q:
                return httpx.Response(200, json=body)
        return httpx.Response(200, json={"data": {"result": []}})
    routes[LOCAL] = handler


def test_host_metrics_from_local_store(admin, http):
    _, routes = http
    _local_store(routes, {
        "count(up == 1)": _vec("x", [("x", 2)]),
        'mode="idle"}[5m]': _vec("hypervisor_id", [("h1", 42.5)]),
        "node_memory_MemTotal_bytes": _vec("hypervisor_id", [("h1", 256e9)]),
        "libvirt_domain_memory_stats_used_percent": _vec("domain", [("vm-1", 61)]),
    }, exact={"up": {"data": {"result": [
        {"metric": {"hypervisor_id": "h1", "job": "node"}, "value": [0, "1"]},
        {"metric": {"hypervisor_id": "h1", "job": "libvirt"}, "value": [0, "0"]}]}}})
    db.cache_set("inventory:hypervisors", HYPERVISORS)

    from app.agent import collector
    asyncio.run(collector.collect_host_metrics())
    hosts, _ = db.cache_get("metrics:hosts")
    assert hosts["source"] == "local"
    h1 = hosts["hosts"]["h1"]
    assert h1["cpu_pct"] == 42.5 and h1["mem_total_bytes"] == 256e9
    assert h1["exporters"] == {"node": True, "libvirt": False} and h1["stale"] is False
    assert db.cache_get("metrics:vms")[0]["vms"]["vm-1"]["mem_pct"] == 61

    rows = admin.get("/api/inventory/hypervisors").json()
    assert rows[0]["metrics"]["cpu_pct"] == 42.5 and rows[0]["metrics_source"] == "local"
    assert rows[1]["metrics"] is None


def test_history_endpoints(admin, http, monkeypatch):
    _, routes = http
    r = admin.get("/api/metrics/vms/vm-1")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "metrics_not_configured"

    async def pcd():
        return "pcd"
    monkeypatch.setattr(metrics_catalog, "source", lambda min_days=0: pcd())
    settings.prometheus_url = "http://prom"
    seen = []

    def query_range(req):
        seen.append(req.url.params["query"])
        return httpx.Response(200, json={"data": {"result": [
            {"metric": {}, "values": [[1700000000, "12.5"], [1700000060, "NaN"]]}]}})
    routes["http://prom/api/v1/query_range"] = query_range
    db.cache_set("inventory:hypervisors",
                 [{**HYPERVISORS[0], "service_host": "uuid-1"}, HYPERVISORS[1]])

    body = admin.get("/api/metrics/hosts/h1?range=30d").json()
    assert body["days"] == 14                        # PCD's Grafana keeps 14 days
    assert body["series"]["cpu_pct"] == [{"ts": 1700000000, "v": 12.5}]
    assert all('host="uuid-1"' in q for q in seen)
    # A hypervisor PCD's metrics can't name, an unknown one, and a bad range
    assert admin.get("/api/metrics/hosts/h2").status_code == 404
    assert admin.get("/api/metrics/hosts/nope").status_code == 404
    assert admin.get("/api/metrics/hosts/h1?range=3w").status_code == 400
    vm = admin.get("/api/metrics/vms/vm-1?range=24h").json()
    assert "disk_latency_ms" not in vm["series"]    # no PCD equivalent


def test_failed_restart_keeps_the_save(admin, monkeypatch):
    import subprocess

    def fail():
        raise subprocess.CalledProcessError(1, ["sudo"], stderr=b"sudo: a password is required")
    monkeypatch.setattr(local_metrics, "available", lambda: True)
    monkeypatch.setattr(local_metrics, "restart", fail)
    r = admin.put("/api/settings", json={"metrics_retention_days": 180}, headers=CSRF)
    assert r.status_code == 200 and settings.metrics_retention_days == 180
    st = asyncio.run(local_metrics.status())
    assert "password is required" in st["restart_error"]
    local_metrics._restart_error = None
