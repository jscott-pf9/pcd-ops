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
