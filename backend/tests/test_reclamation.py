"""Reclamation & Warnings: the rules (services/reclamation.py), first-seen tracking, the
resource-reclamation job and the delete endpoints."""
from __future__ import annotations

import asyncio
from collections import Counter
from types import SimpleNamespace as NS

import pytest
from openstack import exceptions as os_exc

from app.services import db
from app.services import reclamation as r
from tests.conftest import CSRF


def srv(id, status="ACTIVE", **kw):
    return {"id": id, "name": kw.pop("name", id), "status": status, "task_state": None,
            "project_id": "p1", "user_id": "u1", "host": "svc-a", "hypervisor_hostname": "hypA",
            "image_id": None, "vcpus": 2, "ram_mb": 2048, "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z", **kw}


def vol(id, status="available", attachments=(), **kw):
    return {"id": id, "name": id, "size": 10, "status": status, "volume_type": "ceph",
            "availability_zone": "nova", "is_bootable": False, "description": "",
            "project_id": "p1", "attachments": [{"server_id": s} for s in attachments],
            "image_id": None, "glance_image_id": None, "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z", **kw}


def port(id, owner="", device="", net="n1", ips=("10.0.0.5",), allowed=(), **kw):
    return {"id": id, "name": kw.pop("name", ""), "status": "DOWN", "device_owner": owner,
            "device_id": device, "network_id": net, "project_id": "p1", "fixed_ips": list(ips),
            "subnet_ids": ["s1"], "allowed_ips": list(allowed),
            "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z", **kw}


# ── Compute ──────────────────────────────────────────────────────────────────────

def test_stopped_servers_carry_attached_disk():
    out = r.stopped_servers([srv("a", "SHUTOFF"), srv("b")], [vol("v", "in-use", ["a"])])
    assert [s["id"] for s in out] == ["a"]
    assert out[0]["attached_disk_gb"] == 10 and out[0]["since_hint"] == "2026-10-01T00:00:00Z"


def test_is_idle_needs_cpu_data_and_every_metric_under():
    assert r.is_idle(1, 100, 0.1, 5, 10240, 1)
    assert not r.is_idle(None, 0, 0, 5, 10240, 1)
    assert not r.is_idle(6, 0, 0, 5, 10240, 1)
    assert not r.is_idle(1, 20000, 0, 5, 10240, 1)
    assert not r.is_idle(1, 0, 3, 5, 10240, 1)
    assert r.is_idle(1, None, None, 5, 10240, 1)


def test_idle_servers_skip_stopped_and_young_vms():
    th = {"cpu_pct": 5, "net_kbps": 10, "iops": 1, "window_start": "2026-10-20T00:00:00"}
    stats = {i: {"cpu_pct": 1, "net_bps": 10, "iops": 0} for i in "abc"}
    servers = [srv("a"), srv("b", "SHUTOFF"), srv("c", created_at="2026-11-01T00:00:00Z")]
    assert [s["id"] for s in r.idle_servers(servers, stats, th)] == ["a"]


def dom(domain, hyp="h1", **kw):
    return {"domain": domain, "hypervisor_id": hyp, "instance_name": domain, **kw}


def test_orphans_unknown_and_missing():
    host_of = {"svc-a": "h1", "hypA": "h1", "svc-b": "h2"}
    servers = [srv("a"), srv("b"), srv("c", host="svc-b"), srv("d", task_state="migrating")]
    domains = [dom("a"), dom("x"), dom("b", "h2")]
    out = r.orphaned_vms(servers, domains, {"h1", "h2"}, host_of, {"p1"}, set())
    out = {o["id"]: o for o in out}
    assert out["x"]["kind"] == "unknown"
    assert out["b"]["kind"] == "missing" and "another" in out["b"]["reason"]
    assert out["c"]["kind"] == "missing" and "doesn't run" in out["c"]["reason"]
    assert "a" not in out and "d" not in out


def test_orphans_only_compare_hosts_that_answered():
    out = r.orphaned_vms([srv("a")], [dom("x", "h2")], {"h9"}, {"svc-a": "h1"}, {"p1"}, set())
    assert out == []
    # no libvirt data at all: only owner checks
    assert r.orphaned_vms([srv("a")], None, None, {}, {"p1"}, set()) == []


def test_orphans_owner_deleted_merges_into_one_row():
    servers = [srv("a", project_id="gone"), srv("b", user_id="u9")]
    out = r.orphaned_vms(servers, [dom("a"), dom("b")], {"h1"}, {"svc-a": "h1"}, {"p1"},
                         {"u9"})
    by = {o["id"]: o for o in out}
    assert by["a"]["kind"] == "owner_deleted"
    assert by["a"]["reason"] == "Its project no longer exists"
    assert by["b"]["kind"] == "owner_deleted"
    out = r.orphaned_vms([srv("c", project_id="gone")], [], {"h1"}, {"svc-a": "h1"}, {"p1"}, set())
    assert len(out) == 1 and out[0]["kind"] == "missing"
    assert "project no longer exists" in out[0]["reason"]


def test_empty_server_groups():
    groups = [{"id": "g1", "name": "a", "policy": "affinity", "project_id": "p", "members": []},
              {"id": "g2", "name": "b", "policy": "affinity", "project_id": "p", "members": ["s"]}]
    assert [g["id"] for g in r.empty_server_groups(groups)] == ["g1"]


# ── Storage ──────────────────────────────────────────────────────────────────────

def test_unattached_volumes_and_glance_store_volumes():
    vols = [vol("v1"), vol("v2", "in-use", ["a"]), vol("store", glance_image_id="img1"),
            vol("leak", glance_image_id="gone")]
    assert [v["id"] for v in r.unattached_volumes(vols, {"img1"})] == ["v1", "leak"]
    assert r.unattached_volumes(vols, {"img1"})[1]["kind"] == "image_store"
    assert [v["id"] for v in r.unattached_volumes(vols)] == ["v1"]   # images unknown: skip all


def test_image_use_counts_vms_volumes_and_libvirt_roots():
    use = r.image_use([srv("a", image_id="i1")], [vol("v", image_id="i2")],
                      [{"domain": "z", "root_type": "image", "root_uuid": "i3"},
                       {"domain": "a", "root_type": "image", "root_uuid": "i1"}])
    assert use == {"i1": {"vms": 1, "volumes": 0}, "i2": {"vms": 0, "volumes": 1},
                   "i3": {"vms": 1, "volumes": 0}}
    images = [{"id": i, "name": i, "owner": "p1"} for i in ("i1", "i2", "i3", "i4")]
    assert [i["id"] for i in r.unused_images(images, use)] == ["i4"]


# ── Network ──────────────────────────────────────────────────────────────────────

def test_orphaned_ports():
    ports = [port("unbound"), port("vip", ips=["10.0.0.9"]),
             port("holder", owner="compute:nova", device="s1", allowed=["10.0.0.9"]),
             port("gone", owner="compute:lab01", device="s-deleted"),
             port("rif", owner="network:router_interface", device="r-deleted"),
             port("dhcp", owner="network:dhcp", device="dhcp-x")]
    out = {p["id"]: p["kind"] for p in r.orphaned_ports(ports, {"s1"}, {"r1"})}
    assert out == {"unbound": "unbound", "gone": "vm_gone", "rif": "router_gone"}


def test_unused_networks_count_consumers_only():
    nets = [{"id": n, "name": n, "project_id": "p", "shared": False, "external": ext,
             "subnet_ids": ["s"], "created_at": None} for n, ext in
            (("used", False), ("empty", False), ("ext", True), ("lb", False))]
    ports = [port("p1", owner="compute:nova", device="s", net="used"),
             port("p2", owner="network:dhcp", device="d", net="empty"),
             port("p3", owner="network:router_interface", device="r1", net="empty"),
             port("p4", owner="Octavia", device="lb", net="lb")]
    out = r.unused_networks(nets, ports)
    assert [n["id"] for n in out] == ["empty"] and out[0]["routers"] == ["r1"]


def test_unused_routers():
    routers = [{"id": i, "name": i, "status": "ACTIVE", "project_id": "p", "gateway": True}
               for i in ("bare", "busy", "idle", "fip")]
    ports = [port("a", owner="network:router_interface", device="busy", net="vmnet"),
             port("b", owner="compute:nova", device="s", net="vmnet"),
             port("c", owner="network:router_interface_distributed", device="idle", net="empty")]
    fips = [{"router_id": "fip"}]
    out = {x["id"]: x["reason"] for x in r.unused_routers(routers, ports, fips)}
    assert out == {"bare": "no interfaces", "idle": "its networks have no VMs"}


# ── Tenants ──────────────────────────────────────────────────────────────────────

def test_empty_tenants_never_admin_and_mark_system():
    projects = [{"id": i, "name": n, "enabled": True} for i, n in
                (("a", "admin"), ("s", "service"), ("t", "tenant-x"), ("u", "used"))]
    out = r.empty_tenants(projects, Counter({"u": 3}), Counter({"t": 2}))
    assert [(p["name"], p["system"], p["role_assignments"]) for p in out] == [
        ("service", True, 0), ("tenant-x", False, 2)]


# ── First-seen tracking and ages ─────────────────────────────────────────────────

def test_seen_update_keeps_first_seen_and_forgets_dropped():
    first = db.seen_update("k", ["a", "b"])
    again = db.seen_update("k", ["a", "c"])
    assert again["a"] == first["a"] and "b" not in again and "c" in again
    assert db.seen_get("k") == again
    assert db.seen_update("k", []) == {}


def test_earliest():
    assert r.earliest("2026-11-06T10:00:00.5", "2026-10-01T00:00:00Z") == "2026-10-01T00:00:00"
    assert r.earliest(None, None) is None


# ── The resource-reclamation job uses the same rules ─────────────────────────────

def test_job_uses_unattached_time_not_age(monkeypatch):
    from app.agent import jobs

    def server(id, status, updated):
        return NS(id=id, name=id, status=status, task_state=None, project_id="p1", user_id="u",
                  compute_host="h", hypervisor_hostname="h", image=None,
                  flavor={"vcpus": 1, "ram": 512}, created_at="2025-01-01T00:00:00Z",
                  updated_at=updated)

    def volume(id, updated, meta=None):
        return NS(id=id, name=id, size=5, status="available", volume_type="t",
                  availability_zone="nova", is_bootable=False, description="", project_id="p1",
                  attachments=[], volume_image_metadata=None, metadata=meta or {},
                  created_at="2025-01-01T00:00:00Z", updated_at=updated)

    conn = NS(
        compute=NS(servers=lambda **kw: [server("old", "SHUTOFF", "2025-06-01T00:00:00Z"),
                                         server("new", "SHUTOFF", "2099-01-01T00:00:00Z"),
                                         server("on", "ACTIVE", "2025-06-01T00:00:00Z")]),
        block_storage=NS(volumes=lambda **kw: [
            volume("detached-long-ago", "2025-06-01T00:00:00Z"),
            volume("detached-today", "2099-01-01T00:00:00Z"),        # old volume, fresh detach
            volume("store", "2025-06-01T00:00:00Z", {"glance_image_id": "i"})]),
    )
    monkeypatch.setattr(jobs, "get_connection", lambda: conn)
    res = asyncio.run(jobs._run_resource_reclamation({"dry_run": True}))
    assert [v["name"] for v in res["vms_actioned"]] == ["old"]
    assert [v["name"] for v in res["volumes_deleted"]] == ["detached-long-ago"]


def test_job_deletes_newer_categories_only_when_set_and_still_unused(monkeypatch):
    from app.agent import jobs

    old, new = "2025-06-01T00:00:00", "2099-01-01T00:00:00"
    db.cache_set("reclamation:candidates", {
        "unused_floating_ips": [{"id": "f-old", "name": "1.2.3.4", "since": old},
                                {"id": "f-new", "name": "1.2.3.5", "since": new},
                                {"id": "f-used-now", "name": "1.2.3.6", "since": old}],
        "orphaned_ports": [{"id": "p-old", "name": "p", "since": old, "project_id": "p1"}],
        "empty_server_groups": [{"id": "g-old", "name": "g", "since": old}],
        "unused_images": [{"id": "i-private", "name": "mine", "since": old},
                          {"id": "i-public", "name": "shared", "since": old}],
    })

    def ip(id, port=None):
        return NS(id=id, floating_ip_address=id, project_id="p1", port_id=port, router_id=None,
                  updated_at=old)

    def image(id, visibility):
        return NS(id=id, name=id, visibility=visibility, status="active", size=1, owner="p1",
                  is_protected=False, created_at=old, updated_at=old)

    deleted = []
    conn = NS(
        compute=NS(servers=lambda **kw: [],
                   server_groups=lambda **kw: [NS(id="g-old", name="g", project_id="p1",
                                                  policy="anti-affinity", policies=None,
                                                  member_ids=[])],
                   delete_server_group=lambda i: deleted.append(i)),
        block_storage=NS(volumes=lambda **kw: []),
        network=NS(ips=lambda: [ip("f-old"), ip("f-new"), ip("f-used-now", port="x")],
                   ports=lambda: [NS(id="p-old", name="p", status="DOWN", device_owner="",
                                     device_id="", network_id="n", project_id="p1",
                                     fixed_ips=[], allowed_address_pairs=[],
                                     created_at=old, updated_at=old)],
                   routers=lambda: [],
                   delete_ip=lambda i: deleted.append(i), delete_port=lambda i: deleted.append(i)),
        image=NS(images=lambda: [image("i-private", "private"), image("i-public", "public")],
                 delete_image=lambda i: deleted.append(i)),
    )
    monkeypatch.setattr(jobs, "get_connection", lambda: conn)

    # Not set: the job leaves them alone, as before
    res = asyncio.run(jobs._run_resource_reclamation({"dry_run": False}))
    assert res["deleted"] == {} and deleted == []

    cfg = {"dry_run": False, "unused_floating_ips_days": 30, "orphaned_ports_days": 30,
           "empty_server_groups_days": 30, "unused_images_days": 30}
    res = asyncio.run(jobs._run_resource_reclamation(cfg))
    # f-new is too recent, f-used-now got a port since the collection, i-public is public
    assert sorted(deleted) == ["f-old", "g-old", "i-private", "p-old"]
    assert [d["name"] for d in res["deleted"]["unused_floating_ips"]] == ["1.2.3.4"]
    assert "1 orphaned port(s) >30d" in res["summary"]

    deleted.clear()
    asyncio.run(jobs._run_resource_reclamation({**cfg, "dry_run": True}))
    assert deleted == []


# ── API ──────────────────────────────────────────────────────────────────────────

def test_candidates_503_until_collected(admin):
    assert admin.get("/api/reclamation/candidates").status_code == 503
    db.cache_set("reclamation:candidates", {"stopped_servers": [], "notes": {}})
    assert admin.get("/api/reclamation/candidates").json()["notes"] == {}


@pytest.fixture
def fake_conn():
    from app.main import app
    from app.services.openstack import user_connection
    calls: list = []

    class Net:
        def get_port(self, i):
            return NS(name="", fixed_ips=[{"ip_address": "10.0.0.5"}])

        def delete_port(self, i):
            calls.append(("delete_port", i))

        def get_router(self, i):
            return NS(id=i, name="r1", external_gateway_info={"network_id": "ext"})

        def ports(self, device_id=None, network_id=None):
            if device_id:
                return [NS(id="if1", device_owner="network:router_interface"),
                        NS(id="gw", device_owner="network:router_gateway")]
            return [NS(id="d", name="", device_owner="network:dhcp"),
                    NS(id="vmport", name="web", device_owner="compute:nova")]

        def remove_interface_from_router(self, r, port_id):
            calls.append(("remove_interface", port_id))

        def update_router(self, r, **kw):
            calls.append(("update_router", kw))

        def delete_router(self, r):
            calls.append(("delete_router", r.id))

        def get_network(self, i):
            return NS(name="busy")

        def delete_network(self, i):
            raise os_exc.ConflictException("in use")

    class Image:
        def get_image(self, i):
            return NS(name=i, is_protected=i == "locked")

        def delete_image(self, i):
            calls.append(("delete_image", i))

    class Compute:
        def get_server_group(self, i):
            return NS(name="grp")

        def delete_server_group(self, i):
            raise os_exc.ResourceNotFound("No server group")

    conn = NS(network=Net(), image=Image(), compute=Compute())
    app.dependency_overrides[user_connection] = lambda: conn
    yield calls
    app.dependency_overrides.pop(user_connection, None)


def test_delete_endpoints(admin, fake_conn):
    assert admin.delete("/api/reclamation/ports/p1", headers=CSRF).json() == {"deleted": "p1"}
    assert admin.delete("/api/reclamation/routers/r1", headers=CSRF).status_code == 200
    assert fake_conn[1:] == [("remove_interface", "if1"),
                             ("update_router", {"external_gateway_info": {}}),
                             ("delete_router", "r1")]
    r409 = admin.delete("/api/reclamation/networks/n1", headers=CSRF)
    assert r409.status_code == 409 and "web (compute:nova)" in r409.json()["detail"]
    assert "dhcp" not in r409.json()["detail"]
    assert admin.delete("/api/reclamation/images/locked", headers=CSRF).status_code == 409
    assert admin.delete("/api/reclamation/images/free", headers=CSRF).status_code == 200
    assert admin.delete("/api/reclamation/server_groups/g", headers=CSRF).status_code == 404
    titles = [e["title"] for e in db.get_recent_events(20)]
    assert "Deleted port: 10.0.0.5" in titles and "Deleted router: r1" in titles
    assert "Delete network failed" in titles and "Delete server group failed" in titles
