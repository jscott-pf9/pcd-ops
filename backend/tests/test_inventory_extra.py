"""Storage backends, server groups and the inventory endpoints that serve them."""
import asyncio

import httpx
import pytest

from app.config import settings
from app.services import db, local_metrics, server_groups, storage


def pool(name, total, free, ts="2026-11-05T10:00:00", ratio=20.0, alloc=0, state=None):
    return {"name": name, "capabilities": {
        "volume_backend_name": name.split("#")[1], "storage_protocol": "NFS",
        "total_capacity_gb": total, "free_capacity_gb": free, "allocated_capacity_gb": alloc,
        "max_over_subscription_ratio": str(ratio), "thin_provisioning_support": True,
        "backend_state": state, "timestamp": ts}}


HOSTS = {"h-a": "hyp01", "h-b": "hyp02"}


def test_shared_pools_count_once_separate_pools_add_up():
    pools = [storage.pool_record(p, HOSTS) for p in (
        pool("h-a@nfs#nas", 1000, 400, ts="2026-11-05T10:00:00"),
        pool("h-b@nfs#nas", 1000.5, 400.2, ts="2026-11-05T10:01:00"),   # same export
        pool("h-a@lvm#lvm", 500, 100, ratio=1, state="up"),
        pool("h-b@lvm#lvm", 500, 300, ratio=1, state="up"),             # different disks
    )]
    volumes = [{"host": "h-a@nfs#nas", "size_gb": 50}, {"host": "h-b@nfs#nas", "size_gb": 30},
               {"host": "h-a@lvm#lvm", "size_gb": 10}, {"host": None, "size_gb": 99}]
    types = [{"name": "nas-type", "backend": "nas"}, {"name": "any", "backend": None}]
    lvm, nas = storage.group_pools(pools, volumes, types)            # by name

    assert nas["name"] == "nas" and nas["shared"] and nas["hosts"] == ["hyp01", "hyp02"]
    assert nas["total_gb"] == 1000.5 and nas["free_gb"] == 400.2      # the newest report, once
    assert nas["used_pct"] == pytest.approx(60.0, abs=0.1)
    assert nas["effective_gb"] == pytest.approx(20010.0)               # thin, 20x
    assert nas["provisioned_gb"] == 80 and nas["volumes"] == 2 and nas["types"] == ["nas-type"]

    assert not lvm["shared"] and lvm["total_gb"] == 1000 and lvm["free_gb"] == 400
    assert lvm["state"] == "up" and lvm["volumes"] == 1 and lvm["effective_gb"] == 1000


def test_storage_samples_and_exposition():
    b = {"name": 'my "nas"', "total_gb": 2.0, "free_gb": 1.0, "provisioned_gb": 0.5, "volumes": 3}
    text = local_metrics.exposition(storage.samples([b]), 1700000000000)
    assert 'pcd_ops_storage_total_bytes{backend="my \\"nas\\""} 2147483648.0 1700000000000' in text
    assert "pcd_ops_storage_volumes" in text and text.endswith("\n")


def test_push_does_nothing_without_the_store(monkeypatch):
    monkeypatch.setattr(local_metrics, "available", lambda: False)
    assert asyncio.run(local_metrics.push([("m", {}, 1.0)])) is False


@pytest.mark.parametrize("policy,hosts,rules,expected", [
    ("anti-affinity", [], None, "empty"),
    ("anti-affinity", ["a", "b"], None, "ok"),
    ("anti-affinity", ["a", "a"], None, "violated"),
    ("anti-affinity", ["a", "a"], {"max_server_per_host": 2}, "ok"),
    ("soft-anti-affinity", ["a", "a", "b"], None, "not_satisfied"),
    ("affinity", ["a", "a"], None, "ok"),
    ("affinity", ["a", "b"], None, "violated"),
    ("soft-affinity", ["a", "b"], None, "not_satisfied"),
    ("anti-affinity", [None, None], None, "ok"),                     # not placed yet
])
def test_server_group_check(policy, hosts, rules, expected):
    members = [{"host": h} for h in hosts]
    assert server_groups.check(policy, members, rules)["status"] == expected


@pytest.mark.parametrize("path,key", [
    ("storage_backends", "inventory:storage_backends"),
    ("storage_types", "inventory:storage_types"),
    ("server_groups", "inventory:server_groups"),
])
def test_new_inventory_endpoints(admin, path, key):
    assert admin.get(f"/api/inventory/{path}").status_code == 503
    db.cache_set(key, [{"name": "x"}])
    assert admin.get(f"/api/inventory/{path}").json() == [{"name": "x"}]


def test_servers_carry_latest_metrics(admin):
    db.cache_set("inventory:servers", [{"id": "vm-1"}, {"id": "vm-2"}])
    db.cache_set("metrics:vms", {"source": "local", "vms": {"vm-1": {"cpu_pct": 7.5}}})
    rows = admin.get("/api/inventory/servers").json()
    assert rows[0]["metrics"] == {"cpu_pct": 7.5} and rows[1]["metrics"] is None


def test_storage_history(admin, http, monkeypatch):
    _, routes = http
    assert admin.get("/api/metrics/storage/nas").status_code == 503   # no store here
    monkeypatch.setattr(local_metrics, "available", lambda: True)
    settings.metrics_local_enabled = True
    seen = []

    def query_range(req):
        seen.append(req.url.params["query"])
        return httpx.Response(200, json={"data": {"result": [
            {"metric": {}, "values": [[1700000000, "1024"]]}]}})
    routes[f"{local_metrics.URL}/api/v1/query_range"] = query_range
    body = admin.get("/api/metrics/storage/nas?range=7d").json()
    assert set(body["series"]) == {"total_bytes", "used_bytes", "provisioned_bytes"}
    assert all('backend="nas"' in q for q in seen)
    assert admin.get("/api/metrics/storage/nas?range=3w").status_code == 400
