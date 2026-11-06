"""Storage backends, server groups and the inventory endpoints that serve them."""

import asyncio

import httpx
import pytest

from app.config import settings
from app.services import db, local_metrics, server_groups, storage


def pool(name, total, free, ts="2026-11-05T10:00:00", ratio=20.0, alloc=0, state=None):
    return {
        "name": name,
        "capabilities": {
            "volume_backend_name": name.split("#")[1],
            "storage_protocol": "NFS",
            "total_capacity_gb": total,
            "free_capacity_gb": free,
            "allocated_capacity_gb": alloc,
            "max_over_subscription_ratio": str(ratio),
            "thin_provisioning_support": True,
            "backend_state": state,
            "timestamp": ts,
        },
    }


HOSTS = {"h-a": "hyp01", "h-b": "hyp02"}


def test_shared_pools_count_once_separate_pools_add_up():
    pools = [
        storage.pool_record(p, HOSTS)
        for p in (
            pool("h-a@nfs#nas", 1000, 400, ts="2026-11-05T10:00:00"),
            pool("h-b@nfs#nas", 1000.5, 400.2, ts="2026-11-05T10:01:00"),  # same export
            pool("h-a@lvm#lvm", 500, 100, ratio=1, state="up"),
            pool("h-b@lvm#lvm", 500, 300, ratio=1, state="up"),  # different disks
        )
    ]
    volumes = [
        {"host": "h-a@nfs#nas", "size_gb": 50},
        {"host": "h-b@nfs#nas", "size_gb": 30},
        {"host": "h-a@lvm#lvm", "size_gb": 10},
        {"host": None, "size_gb": 99},
    ]
    types = [{"name": "nas-type", "backend": "nas"}, {"name": "any", "backend": None}]
    lvm, nas = storage.group_pools(pools, volumes, types)  # by name

    assert nas["name"] == "nas" and nas["shared"] and nas["hosts"] == ["hyp01", "hyp02"]
    assert nas["total_gb"] == 1000.5 and nas["free_gb"] == 400.2  # the newest report, once
    assert nas["used_pct"] == pytest.approx(60.0, abs=0.1)
    assert nas["effective_gb"] == pytest.approx(20010.0)  # thin, 20x
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


@pytest.mark.parametrize(
    "policy,hosts,rules,expected",
    [
        ("anti-affinity", [], None, "empty"),
        ("anti-affinity", ["a", "b"], None, "ok"),
        ("anti-affinity", ["a", "a"], None, "violated"),
        ("anti-affinity", ["a", "a"], {"max_server_per_host": 2}, "ok"),
        ("soft-anti-affinity", ["a", "a", "b"], None, "not_satisfied"),
        ("affinity", ["a", "a"], None, "ok"),
        ("affinity", ["a", "b"], None, "violated"),
        ("soft-affinity", ["a", "b"], None, "not_satisfied"),
        ("anti-affinity", [None, None], None, "ok"),  # not placed yet
    ],
)
def test_server_group_check(policy, hosts, rules, expected):
    members = [{"host": h} for h in hosts]
    assert server_groups.check(policy, members, rules)["status"] == expected


@pytest.mark.parametrize(
    "path,key",
    [
        ("storage_backends", "inventory:storage_backends"),
        ("storage_types", "inventory:storage_types"),
        ("server_groups", "inventory:server_groups"),
    ],
)
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
    assert admin.get("/api/metrics/storage/nas").status_code == 503  # no store here
    monkeypatch.setattr(local_metrics, "available", lambda: True)
    settings.metrics_local_enabled = True
    seen = []

    def query_range(req):
        seen.append(req.url.params["query"])
        return httpx.Response(
            200, json={"data": {"result": [{"metric": {}, "values": [[1700000000, "1024"]]}]}}
        )

    routes[f"{local_metrics.URL}/api/v1/query_range"] = query_range
    body = admin.get("/api/metrics/storage/nas?range=7d").json()
    assert {"total_bytes", "used_bytes", "provisioned_bytes", "read_bps", "latency_ms"} == (
        set(body["series"])
        & {"total_bytes", "used_bytes", "provisioned_bytes", "read_bps", "latency_ms"}
    )
    assert all('backend="nas"' in q for q in seen)
    # I/O joins libvirt's disks to the backend's volumes
    assert any('pcd_ops_volume_disk{backend="nas"}' in q for q in seen)
    assert admin.get("/api/metrics/storage/nas?range=3w").status_code == 400


# ── Snapshots, clusters, volumes, live details ────────────────────────────────


def test_image_kind():
    from app.agent.collector import _image_kind

    assert _image_kind({})["kind"] == "image"
    assert _image_kind({"image_type": "snapshot", "base_image_ref": "b"}) | {} == {
        "kind": "snapshot",
        "snapshot_type": "instance",
        "base_image_ref": "b",
        "instance_uuid": None,
    }
    assert _image_kind({"block_device_mapping": "[...]"})["snapshot_type"] == "volume-backed"


def test_volume_disks_map_attachments_to_vm_disks():
    vols = [
        {"id": "v1", "backend": "nas", "attachments": [{"server_id": "s1", "device": "/dev/vdb"}]},
        {"id": "v2", "backend": None, "attachments": [{"server_id": "s2", "device": None}]},
    ]
    assert storage.volume_disks(vols) == [
        (
            "pcd_ops_volume_disk",
            {"volume_id": "v1", "backend": "nas", "domain": "s1", "target_device": "vdb"},
            1.0,
        )
    ]


def test_cluster_selector():
    from app.services import metrics_catalog

    hyps = [
        {"id": "h-1", "service_host": "u-1"},
        {"id": "h-2", "service_host": None},
        {"id": 'x"y', "service_host": None},
    ]
    assert metrics_catalog.cluster_selector("local", hyps) == 'hypervisor_id=~"h-1|h-2"'
    assert metrics_catalog.cluster_selector("pcd", hyps) == 'host=~"u-1"'
    assert metrics_catalog.cluster_selector("pcd", hyps[1:]) is None
    q = metrics_catalog.promql("cluster", "cpu_pct", "local", 'hypervisor_id=~"h-1"')
    assert "by (" not in q  # one value for the whole cluster


def test_cluster_and_volume_history(admin, http, monkeypatch):
    from app.services import metrics_catalog

    _, routes = http
    seen = []

    def query_range(req):
        seen.append(req.url.params["query"])
        return httpx.Response(
            200, json={"data": {"result": [{"metric": {}, "values": [[1700000000, "5"]]}]}}
        )

    routes[f"{local_metrics.URL}/api/v1/query_range"] = query_range

    async def local():
        return "local"

    monkeypatch.setattr(metrics_catalog, "source", lambda min_days=0: local())
    monkeypatch.setattr(local_metrics, "available", lambda: True)
    settings.metrics_local_enabled = True
    db.cache_set(
        "inventory:hypervisors",
        [{"id": "h1", "service_host": "u1"}, {"id": "h2", "service_host": "u2"}],
    )
    db.cache_set(
        "inventory:clusters",
        [
            {"id": 7, "hosts": [{"hypervisor_id": "h1"}, {"hypervisor_id": "h2"}]},
            {"id": 8, "hosts": []},
        ],
    )
    body = admin.get("/api/metrics/clusters/7?range=7d").json()
    assert {"cpu_pct", "net_rx_bps", "vcpu_alloc_pct", "vms"} <= set(body["series"])
    assert any('hypervisor_id=~"h1|h2"' in q for q in seen) and any(
        'aggregate="7"' in q for q in seen
    )
    assert admin.get("/api/metrics/clusters/8").status_code == 404
    assert admin.get("/api/metrics/clusters/9").status_code == 404

    db.cache_set(
        "inventory:volumes",
        [
            {"id": "v1", "attachments": [{"server_id": "s1", "device": "/dev/vdb"}]},
            {"id": "v2", "attachments": []},
        ],
    )
    seen.clear()
    body = admin.get("/api/metrics/volumes/v1").json()
    assert "latency_ms" in body["series"] and all(
        'domain="s1",target_device="vdb"' in q for q in seen
    )
    r = admin.get("/api/metrics/volumes/v2")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_attached"
    monkeypatch.setattr(local_metrics, "available", lambda: False)
    assert admin.get("/api/metrics/volumes/v1").status_code == 503


def test_flavors_endpoint(admin):
    assert admin.get("/api/inventory/flavors").status_code == 503
    db.cache_set("inventory:flavors", [{"id": "f1", "name": "m1.small"}])
    assert admin.get("/api/inventory/flavors").json()[0]["name"] == "m1.small"


def test_details_are_live_and_cleaned(admin, monkeypatch):
    from app.api import inventory
    from app.main import app
    from app.services.openstack import user_connection

    class Res:
        def __init__(self, d):
            self.d = d

        def to_dict(self, computed=False):
            return self.d

    class Image:
        def get_image(self, i):
            return Res(
                {
                    "id": i,
                    "name": "snap",
                    "hw_disk_bus": "virtio",
                    "min_ram": 0,
                    "owner": None,
                    "locations": [{"url": "rbd://secret"}],
                    "direct_url": "rbd://x",
                    "file": "/v2/f",
                    "properties": {"image_type": "snapshot", "empty": ""},
                }
            )

    class Conn:
        image = Image()

    app.dependency_overrides[user_connection] = lambda: Conn()
    try:
        body = admin.get("/api/inventory/images/i1/details").json()
        assert body == {
            "properties": {
                "id": "i1",
                "name": "snap",
                "hw_disk_bus": "virtio",
                "min_ram": 0,
                "properties": {"image_type": "snapshot"},
            }
        }
        assert admin.get("/api/inventory/networks/n1/details").status_code == 404
    finally:
        app.dependency_overrides.pop(user_connection, None)
    assert inventory.clean({"a": [{"b": None, "c": 1}], "d": {}}) == {"a": [{"c": 1}]}


def test_tenants_for_names_include_service_never_admin(admin):
    db.cache_set("inventory:tenants", [{"id": i, "name": n} for i, n in
                                       (("a", "admin"), ("s", "service"), ("t", "tenant-x"))])
    assert [t["name"] for t in admin.get("/api/inventory/tenants").json()] == ["tenant-x"]
    names = [t["name"] for t in admin.get("/api/inventory/tenants?all=true").json()]
    assert names == ["service", "tenant-x"]
