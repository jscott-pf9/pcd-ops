"""Capacity and right-sizing: physical capacity (services/capacity.py), what-if with tenant
quotas, suggested flavors and whether they fit (services/rightsizing.py), the resize job."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS

import pytest

from app.config import settings
from app.services import capacity as cap
from app.services import db
from app.services import overcommit as o
from app.services import rightsizing as rs
from tests.conftest import CSRF


def alloc(physical, ratio, allocated, reserved=0):
    return o.allocation(
        {"total": physical, "reserved": reserved, "allocation_ratio": ratio}, allocated
    )


TOTALS = {
    "cpu": {**alloc(48, 2.0, 53), "ratios": [2.0]},
    "memory": {**alloc(184320, 1.0, 104448, reserved=1536), "ratios": [1.0]},
}
BACKENDS = [
    {"name": "ceph", "total_gb": 1000, "used_gb": 100, "effective_gb": 1000, "provisioned_gb": 300},
    {"name": "nfs", "total_gb": 100, "used_gb": 10, "effective_gb": 2000, "provisioned_gb": 50},
    {
        "name": "unknown",
        "total_gb": None,
        "used_gb": None,
        "effective_gb": None,
        "provisioned_gb": 5,
    },
]


# ── Physical capacity ────────────────────────────────────────────────────────────


def test_summary_from_placement_and_cinder_not_quotas():
    s = cap.summary(TOTALS, [], BACKENDS)
    assert s["vcpus"] == {
        "used": 53.0,
        "total": 96.0,
        "free": 43.0,
        "physical": 48.0,
        "ratio": 2.0,
        "source": "placement",
    }
    assert s["ram_gb"]["total"] == 178.5 and s["ram_gb"]["used"] == 102.0
    st = s["storage_gb"]
    # Written against the disks, where Cinder reports them; thin oversubscription only beside
    assert (st["used"], st["total"], st["free"]) == (110.0, 1100.0, 990.0)
    assert (st["provisioned"], st["provisionable"]) == (355.0, 3000.0)


def test_summary_falls_back_to_hypervisors_without_placement():
    hyps = [{"vcpus_total": 16, "vcpus_used": 10, "memory_mb_total": 65536, "memory_mb_used": 8192}]
    s = cap.summary(None, hyps, [])
    assert s["vcpus"] == {"used": 10, "total": 16, "free": 6, "source": "hypervisors"}
    assert s["ram_gb"]["total"] == 64.0
    assert s["storage_gb"]["total"] is None and s["storage_gb"]["free"] is None


def test_samples_for_the_trends():
    names = {(n, lab["resource"]) for n, lab, _ in cap.samples(cap.summary(TOTALS, [], []))}
    assert ("pcd_ops_capacity_used", "storage_gb") in names
    assert ("pcd_ops_capacity_total", "storage_gb") not in names  # no backend capacity known
    assert ("pcd_ops_capacity_total", "vcpus") in names


# ── What-if ──────────────────────────────────────────────────────────────────────

NOVA = {
    "cores": {"limit": 20, "in_use": 18, "reserved": 0},
    "ram": {"limit": 51200, "in_use": 512, "reserved": 0},
}
CINDER = {
    "volumes": {"limit": 10, "in_use": 9, "reserved": 0},
    "gigabytes": {"limit": -1, "in_use": 40, "reserved": 0},
}


def test_tenant_quota_in_plan_units():
    q = cap.tenant_quota(NOVA, CINDER)
    assert q == {
        "vcpus": {"limit": 20, "used": 18},
        "ram_gb": {"limit": 50.0, "used": 0.5},
        "storage_gb": {"limit": -1, "used": 40},
        "vdisks": {"limit": 10, "used": 9},
    }


def test_simulate_cluster_and_tenant_quota_with_vdisks():
    s = cap.summary(TOTALS, [], BACKENDS)
    sim = cap.simulate(s, {"vcpus": 4, "ram_gb": 8, "storage_gb": 500, "vdisks": 2})
    assert sim["would_fit"] and "quota" not in sim
    assert sim["projected"]["vcpus"]["free"] == 39.0
    sim = cap.simulate(
        s, {"vcpus": 4, "ram_gb": 8, "storage_gb": 500, "vdisks": 2}, cap.tenant_quota(NOVA, CINDER)
    )
    bad = {r["resource"] for r in sim["quota"] if not r["fits"]}
    assert bad == {"vcpus", "vdisks"}  # 22 > 20 cores, 11 > 10 volumes; GB unlimited
    assert not sim["quota_fits"] and not sim["would_fit"]
    assert not cap.simulate(s, {"vcpus": 50})["would_fit"]


@pytest.fixture
def quota_conn(admin, monkeypatch):
    from app.main import app
    from app.services.openstack import user_connection

    def get(path):
        body = {"quota_set": NOVA if "detail" in path else CINDER}
        return NS(status_code=200, json=lambda: body, raise_for_status=lambda: None)

    seen = []
    conn = NS(
        compute=NS(get=lambda p: (seen.append(p), get(p))[1]),
        block_storage=NS(get=lambda p: (seen.append(p), get(p))[1]),
    )
    app.dependency_overrides[user_connection] = lambda: conn
    yield seen
    app.dependency_overrides.pop(user_connection, None)


def test_what_if_and_plans_check_tenant_quotas(admin, quota_conn):
    body = {"additional_vcpus": 1, "additional_vdisks": 1}
    assert admin.post("/api/capacity/what-if", json=body, headers=CSRF).status_code == 503
    db.cache_set("capacity:summary", cap.summary(TOTALS, [], BACKENDS))
    r = admin.post("/api/capacity/what-if", json=body, headers=CSRF).json()
    assert r["would_fit"] and "quota" not in r and quota_conn == []
    r = admin.post("/api/capacity/what-if", json={**body, "tenant_id": "t1"}, headers=CSRF).json()
    assert r["quota_fits"] and r["would_fit"]
    r = admin.post(
        "/api/capacity/what-if",
        json={**body, "additional_vdisks": 3, "tenant_id": "t1"},
        headers=CSRF,
    ).json()
    assert not r["would_fit"] and r["projected"]["vcpus"]["fits"]
    # A bad tenant id never reaches PCD
    r = admin.post("/api/capacity/what-if", json={**body, "tenant_id": "../x"}, headers=CSRF).json()
    assert r["quota_error"] and "../x" not in "".join(quota_conn)

    for t in ("t1", "t1", None):
        assert (
            admin.post(
                "/api/capacity/plans",
                headers=CSRF,
                json={"name": "p", "tenant_id": t, "additional_vcpus": 3},
            ).status_code
            == 201
        )
    quota_conn.clear()
    plans = admin.get("/api/capacity/plans").json()
    # Newest first: the all-tenants plan, then the two over the tenant's 20 cores
    assert [p["simulation"]["would_fit"] for p in plans] == [True, False, False]
    assert len(quota_conn) == 2  # one Nova and one Cinder lookup for the tenant


# ── Right-sizing ─────────────────────────────────────────────────────────────────

FLAVORS = [
    {"id": f"f{v}-{r}", "name": f"{v}x{r // 1024}", "vcpus": v, "ram_mb": r, "extra_specs": {}}
    for v, r in ((1, 1024), (2, 4096), (4, 8192), (8, 16384), (16, 32768))
]


def test_smaller_and_larger_flavors():
    cur = {"vcpus": 8, "ram_mb": 16384}
    assert rs.smaller_flavor(cur, 10, 10, FLAVORS)["name"] == "2x4"
    assert rs.smaller_flavor({"vcpus": 1, "ram_mb": 1024}, 10, 10, FLAVORS) is None
    # CPU at 95 % of 4 vCPUs: 70 % needs 6 → 8; RAM kept at least 8 GB
    up = rs.larger_flavor(
        {"vcpus": 4, "ram_mb": 8192}, 95, 40, FLAVORS, cpu_short=True, mem_short=False
    )
    assert up["name"] == "8x16"
    up = rs.larger_flavor(
        {"vcpus": 2, "ram_mb": 4096}, 10, 85, FLAVORS, cpu_short=False, mem_short=True
    )
    assert up["name"] == "4x8"
    assert rs.larger_flavor({"vcpus": 16, "ram_mb": 32768}, 99, 50, FLAVORS, True, False) is None


def _hosts():
    hyps = [{"id": h, "hostname": h, "state": "up"} for h in ("a", "b", "c")]
    placement = {
        "a": {
            "inventories": {
                "VCPU": {"total": 8, "allocation_ratio": 1.0},
                "MEMORY_MB": {"total": 32768},
            },
            "usages": {"VCPU": 8, "MEMORY_MB": 16384},
        },
        "b": {
            "inventories": {
                "VCPU": {"total": 8, "allocation_ratio": 1.0},
                "MEMORY_MB": {"total": 32768},
            },
            "usages": {"VCPU": 6, "MEMORY_MB": 8192},
        },
        "c": {
            "inventories": {
                "VCPU": {"total": 64, "allocation_ratio": 1.0},
                "MEMORY_MB": {"total": 262144},
            },
            "usages": {"VCPU": 0, "MEMORY_MB": 0},
        },
    }
    hosts = o.host_rows(hyps, placement, {}, {})
    clusters = [
        {"id": 1, "metadata": {}, "hosts": [{"hypervisor_id": "a"}, {"hypervisor_id": "b"}]},
        {"id": 2, "metadata": {"gpu": "true"}, "hosts": [{"hypervisor_id": "c"}]},
    ]
    return hosts, clusters


def test_flavor_fit_stays_in_the_cluster_and_honours_aggregate_specs():
    hosts, clusters = _hosts()
    cur = {"vcpus": 4, "ram_mb": 8192}
    small = FLAVORS[1]  # 2 vCPUs: b has 2 free
    assert rs.flavor_fit(small, cur, "a", hosts, clusters) == {
        "status": "fits",
        "hosts": ["b"],
        "reason": "Room on 1 host in its cluster",
    }
    # 8 vCPUs: nowhere else in cluster 1; host c is in another cluster
    big = FLAVORS[3]
    assert rs.flavor_fit(big, cur, "a", hosts, clusters)["status"] == "no_room"
    # 4 vCPUs fit only where the VM is, once its own 4 are given back
    assert rs.flavor_fit(FLAVORS[2], cur, "a", hosts, clusters)["status"] == "same_host"
    gpu = {**big, "extra_specs": {"aggregate_instance_extra_specs:gpu": "true"}}
    assert rs.flavor_fit(gpu, cur, "c", hosts, clusters)["status"] == "same_host"
    assert rs.flavor_fit(gpu, cur, "a", hosts, clusters)["status"] == "no_room"
    assert rs.flavor_fit(small, cur, "a", [], [])["status"] == "unknown"


def test_resize_job_skips_flavors_with_no_room(monkeypatch):
    from app.agent import jobs

    hosts, clusters = _hosts()
    db.cache_set("capacity:overcommit", {"hosts": hosts})
    db.cache_set("inventory:clusters", clusters)
    rec = {
        "server_status": "ACTIVE",
        "project_id": "p",
        "hypervisor_id": "a",
        "current_flavor": {"name": "4x8", "vcpus": 4, "ram_mb": 8192},
    }
    db.cache_set(
        "rightsizing:recommendations",
        [
            {
                **rec,
                "server_id": "1",
                "server_name": "down",
                "classification": "overprovisioned",
                "suggested_flavor": FLAVORS[1],
            },
            {
                **rec,
                "server_id": "2",
                "server_name": "up",
                "classification": "cpu-pressure",
                "suggested_flavor": FLAVORS[3],
            },
        ],
    )
    monkeypatch.setattr(jobs, "get_connection", lambda: None)
    res = asyncio.run(
        jobs._run_rightsizing_resize(
            {"dry_run": True, "classifications": ["overprovisioned", "cpu-pressure"]}
        )
    )
    assert [v["name"] for v in res["vms"]] == ["down"]
    assert res["skipped"][0]["name"] == "up" and "No host" in res["skipped"][0]["reason"]


def test_recommendations_carry_current_fit(admin):
    hosts, clusters = _hosts()
    db.cache_set("capacity:overcommit", {"hosts": hosts})
    db.cache_set("inventory:clusters", clusters)
    db.cache_set(
        "rightsizing:recommendations",
        [
            {
                "server_id": "1",
                "hypervisor_id": "a",
                "current_flavor": {"vcpus": 4, "ram_mb": 8192},
                "suggested_flavor": FLAVORS[1],
            },
            {"server_id": "2", "suggested_flavor": None},
        ],
    )
    recs = admin.get("/api/rightsizing/recommendations").json()
    assert recs[0]["fit"]["status"] == "fits" and "fit" not in recs[1]


# ── Collectors ───────────────────────────────────────────────────────────────────


def test_capacity_and_trends_from_placement_and_the_local_store(monkeypatch):
    from app.agent import collector

    db.cache_set("capacity:overcommit", {"totals": TOTALS})
    db.cache_set("inventory:storage_backends", BACKENDS)
    pushed = []

    async def push(samples):
        pushed.extend(samples)

    monkeypatch.setattr(collector.local_metrics, "push", push)
    asyncio.run(collector.collect_capacity())
    s, _ = db.cache_get("capacity:summary")
    assert s["vcpus"]["total"] == 96.0 and s["storage_gb"]["used"] == 110.0
    assert ("pcd_ops_capacity_used", {"resource": "vcpus"}, 53.0) in pushed

    queries = []

    async def query_range(q, start, end, step):
        queries.append((q, step))
        used = "used" in q
        # vCPUs growing 1 a day from 50 of 100; RAM has too little history
        n = 10 if "vcpus" in q else 2
        return [{"values": [[86400 * i, str(50 + i if used else 100)] for i in range(n)]}]

    async def ok():
        return True

    monkeypatch.setattr(collector.metrics_catalog, "_local_ok", ok)
    monkeypatch.setattr(collector.metrics_catalog, "_collected_days", lambda: 12.0)
    monkeypatch.setattr(collector.metrics_catalog, "local_client", NS(query_range=query_range))
    monkeypatch.setattr(settings, "ai_capacity_enabled", False)
    asyncio.run(collector.collect_capacity_trends())
    t, _ = db.cache_get("capacity:trends")
    assert t["window_days"] == 12 and t["note"] is None
    v = t["resources"]["vcpus"]
    assert v["latest"] == {"used": 59.0, "total": 100.0, "pct": 59.0}
    assert v["forecast"]["days_to_80pct"] == 21          # 21 more days at 1 a day
    assert t["resources"]["ram_gb"]["series"] == []
    assert all(step == "1h" for _, step in queries)
    assert queries[0][0] == 'max(last_over_time(pcd_ops_capacity_used{resource="vcpus"}))'


def test_trends_say_why_without_the_local_store(monkeypatch):
    from app.agent import collector

    async def no():
        return False

    monkeypatch.setattr(collector.metrics_catalog, "_local_ok", no)
    asyncio.run(collector.collect_capacity_trends())
    t, _ = db.cache_get("capacity:trends")
    assert "metrics store" in t["note"] and t["ai_analysis"] is None
    assert all(r["series"] == [] for r in t["resources"].values())
