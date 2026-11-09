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


# ── Right-sizing drill-down ───────────────────────────────────────────────────────


def test_classify_and_reasons_agree():
    assert rs.classify(None, None, False) == ("no-data", "unknown")
    assert rs.classify(50, 92, False) == ("memory-pressure", "high")
    assert rs.classify(85, 50, False) == ("cpu-pressure", "medium")
    assert rs.classify(3, 10, True) == ("idle", "low")
    assert rs.classify(10, 15, False) == ("overprovisioned", "low")
    assert rs.classify(40, 15, False) == ("right-sized", "low")
    why = rs.reasons({"classification": "memory-pressure", "cpu_avg_pct": 50,
                      "mem_avg_pct": 92, "window_days": 30})
    assert "92.0 %" in why[0] and "last 30 days" in why[0] and "high risk" in why[1]
    idle = rs.reasons({"classification": "idle", "idle": {
        "cpu_pct": 1.2, "net_bps": 2048, "iops": None,
        "rule": {"days": 14, "cpu_pct": 5, "net_kbps": 10, "iops": 1}}})
    assert "14 days" in idle[0] and "2.0 KB/s" in idle[1] and "disk no data" in idle[1]


def test_basis_projection_and_alternatives():
    cur = {"name": "4x8", "vcpus": 4, "ram_mb": 8192}
    down = {"classification": "overprovisioned", "current_flavor": cur, "cpu_avg_pct": 10,
            "mem_avg_pct": 15,
            "stats": {"cpu": {"avg": 10, "p95": 60, "peak": 95}, "mem": {"avg": 15, "p95": 18}}}
    b = rs.basis(down)
    assert b["direction"] == "down" and b["vcpus"] == 1 and b["ram_mb"] == 1844
    alts = rs.alternatives(down, FLAVORS)
    # Smaller than 4x8 in vCPUs or RAM, and at least the basis; the suggestion comes first
    assert [a["flavor"]["name"] for a in alts][0] == rs.smaller_flavor(
        cur, 10, 15, FLAVORS)["name"]
    assert all(a["flavor"]["vcpus"] < 4 or a["flavor"]["ram_mb"] < 8192 for a in alts)
    p = rs.project(cur, FLAVORS[0], down["stats"])
    # Same work on fewer vCPUs: 60 % of 4 vCPUs is 240 % of 1
    assert p["cpu"]["p95"] == round(60 * 4 / FLAVORS[0]["vcpus"], 1)
    assert p["warnings"] and "busiest hours" in p["warnings"][0]
    up = {**down, "classification": "cpu-pressure", "cpu_avg_pct": 95, "mem_avg_pct": 40}
    b = rs.basis(up)
    assert b["direction"] == "up" and b["vcpus"] == 6 and b["ram_mb"] == 8192
    assert rs.basis({**down, "classification": "right-sized"}) is None


def test_host_room_lists_the_cluster():
    hosts, clusters = _hosts()
    cur = {"vcpus": 4, "ram_mb": 8192}
    rows = rs.host_room(FLAVORS[2], cur, "a", hosts, clusters)
    # Cluster 1 only; a counts its own 4 vCPUs as free, b has 2
    assert [(r["hostname"], r["fits"]) for r in rows] == [("a", True), ("b", False)]
    assert rows[0]["current"] and rows[1]["why"] == "not enough free vCPUs"


def test_detail_endpoint(admin):
    hosts, clusters = _hosts()
    db.cache_set("capacity:overcommit", {"hosts": hosts})
    db.cache_set("inventory:clusters", clusters)
    db.cache_set("inventory:flavors", [{**f, "public": True, "disabled": False} for f in FLAVORS])
    sug = rs.smaller_flavor({"vcpus": 4, "ram_mb": 8192}, 10, 15, FLAVORS)
    db.cache_set("rightsizing:recommendations", [{
        "server_id": "1", "server_name": "web", "hypervisor_id": "a",
        "classification": "overprovisioned", "cpu_avg_pct": 10, "mem_avg_pct": 15,
        "current_flavor": {"name": "4x8", "vcpus": 4, "ram_mb": 8192},
        "suggested_flavor": sug, "stats": {"cpu": {"avg": 10, "p95": 20}}, "window_days": 30,
    }])
    assert admin.get("/api/rightsizing/recommendations/nope").status_code == 404
    d = admin.get("/api/rightsizing/recommendations/1").json()
    assert d["fit"]["status"] == "fits" and d["basis"]["direction"] == "down"
    assert d["reasons"] and d["projected"]["cpu"]["avg"] is not None
    assert d["alternatives"][0]["flavor"]["id"] == sug["id"] and "fit" in d["alternatives"][0]
    assert {h["hostname"] for h in d["hosts"]} == {"a", "b"}
    assert d["thresholds"]["cpu_high"] == rs.CPU_HIGH


def test_list_without_series(admin):
    db.cache_set("rightsizing:recommendations", [{
        "server_id": "1", "server_name": "web", "classification": "right-sized",
        "current_flavor": {"name": "4x8", "vcpus": 4, "ram_mb": 8192}, "suggested_flavor": None,
        "cpu_series": [{"ts": 1, "v": 2}], "mem_series": [], "io_series": [],
    }])
    assert admin.get("/api/rightsizing/recommendations").json()[0]["cpu_series"]
    assert admin.get("/api/rightsizing/recommendations?series=false").json()[0]["cpu_series"] == []


def test_image_backed_vms_keep_their_disk():
    flavors = [
        {"id": "u", "name": "pf9.unknown", "vcpus": 1, "ram_mb": 1024, "disk_gb": 0},
        {"id": "s", "name": "small", "vcpus": 1, "ram_mb": 2048, "disk_gb": 20},
        {"id": "m", "name": "medium", "vcpus": 2, "ram_mb": 4096, "disk_gb": 40},
        {"id": "l", "name": "large", "vcpus": 4, "ram_mb": 8192, "disk_gb": 80},
        {"id": "x", "name": "xlarge", "vcpus": 8, "ram_mb": 16384, "disk_gb": 160},
    ]
    vol = {"vcpus": 4, "ram_mb": 8192, "disk_gb": 0, "image_backed": False}
    assert rs.smaller_flavor(vol, 1, 5, flavors)["name"] == "pf9.unknown"
    # 40 GB local root disk: nothing smaller than 40 GB, and never a flavor with no disk
    img = {"vcpus": 4, "ram_mb": 8192, "disk_gb": 40, "image_backed": True}
    assert rs.smaller_flavor(img, 1, 5, flavors)["name"] == "medium"
    assert rs.smaller_flavor({**img, "disk_gb": 80}, 1, 5, flavors) is None
    assert rs.larger_flavor({**img, "vcpus": 1, "ram_mb": 2048, "disk_gb": 160}, 95, 10,
                            flavors, True, False)["name"] == "xlarge"
    rec = {"classification": "overprovisioned", "current_flavor": img, "cpu_avg_pct": 1,
           "mem_avg_pct": 5}
    assert [a["flavor"]["name"] for a in rs.alternatives(rec, flavors)] == ["medium"]


def _rec(cls, cur, cpu, mem):
    return {"classification": cls, "current_flavor": cur, "cpu_avg_pct": cpu, "mem_avg_pct": mem}


def test_custom_flavor_when_the_catalog_fits_badly():
    # Memory pressure on 2 vCPUs / 8 GB: it needs 2 vCPUs and 11 GB, the catalog's best is 8x16
    specs = {"aggregate_instance_extra_specs:c": "1"}
    rec = _rec("memory-pressure", {"vcpus": 2, "ram_mb": 8192, "disk_gb": 40, "extra_specs": specs},
               30, 95)
    choice = rs.larger_flavor(rec["current_flavor"], 30, 95, FLAVORS, False, True)
    assert choice["name"] == "8x16"
    c = rs.custom_flavor(rec, choice)
    assert (c["name"], c["vcpus"], c["ram_mb"], c["disk_gb"]) == ("rs.2c11g.40d", 2, 11264, 40)
    assert c["extra_specs"] == specs
    assert "8x16, has 6 more vCPUs" in c["reason"]
    # A close catalog fit: none
    over = _rec("overprovisioned", {"vcpus": 8, "ram_mb": 16384}, 10, 10)
    close = rs.smaller_flavor(over["current_flavor"], 10, 10, FLAVORS)
    assert rs.custom_flavor(over, close) is None
    # Nothing to change, or nothing smaller to shape
    assert rs.custom_flavor(_rec("right-sized", {"vcpus": 2, "ram_mb": 4096}, 50, 50), None) is None
    assert rs.custom_flavor(_rec("idle", {"vcpus": 1, "ram_mb": 512}, 1, 5), None) is None


def test_custom_flavor_keeps_an_image_backed_disk_the_catalog_lacks():
    cur = {"vcpus": 4, "ram_mb": 8192, "disk_gb": 120, "swap_mb": 512, "image_backed": True}
    rec = _rec("overprovisioned", cur, 10, 10)
    disked = [{**f, "disk_gb": 20} for f in FLAVORS]
    assert rs.smaller_flavor(cur, 10, 10, disked) is None
    c = rs.custom_flavor(rec, None)
    assert (c["vcpus"], c["ram_mb"], c["disk_gb"], c["swap_mb"]) == (1, 2048, 120, 512)
    assert c["reason"].startswith("No flavor in the catalog it can resize to is smaller")
    assert rs.flavor_label(c) == "1 vCPU, 2 GB RAM, 120 GB disk"


def test_private_flavors_only_for_projects_with_access():
    fl = [{"id": "pub", "public": True}, {"id": "mine", "public": False},
          {"id": "theirs", "public": False}]
    access = {"mine": ["p1"], "theirs": ["p2"]}
    assert [f["id"] for f in rs.usable(fl, access, "p1")] == ["pub", "mine"]
    assert [f["id"] for f in rs.usable(fl, access, "p3")] == ["pub"]


class FakeNova:
    """The compute calls the create-flavor endpoint makes."""

    def __init__(self, flavors=(), access=None, fail_access=False):
        self.existing, self.access, self.fail_access = list(flavors), access or {}, fail_access
        self.calls = []

    def flavors(self):
        return self.existing

    def get_flavor_access(self, fid):
        return [{"flavor_id": fid, "tenant_id": t} for t in self.access.get(fid, [])]

    def create_flavor(self, **attrs):
        self.calls.append(("create", attrs))
        return NS(id="new-id", **attrs)

    def flavor_add_tenant_access(self, fid, tenant):
        self.calls.append(("access", fid, tenant))
        if self.fail_access:
            raise RuntimeError("forbidden")

    def create_flavor_extra_specs(self, fid, specs):
        self.calls.append(("specs", fid, specs))

    def delete_flavor(self, fid, ignore_missing=True):
        self.calls.append(("delete", fid))


def _flv(name, vcpus, ram, public=True, fid=None):
    return NS(id=fid or name, name=name, vcpus=vcpus, ram=ram, disk=40, ephemeral=0, swap=0,
              is_public=public, is_disabled=False)


@pytest.fixture
def nova(admin):
    from app.main import app
    from app.services.openstack import user_connection

    holder = {"nova": FakeNova()}
    app.dependency_overrides[user_connection] = lambda: NS(compute=holder["nova"])
    custom = {"name": "rs.2c11g.40d", "vcpus": 2, "ram_mb": 11264, "disk_gb": 40,
              "ephemeral_gb": 0, "swap_mb": 0, "extra_specs": {"hw:cpu_policy": "shared"},
              "reason": "…"}
    db.cache_set("rightsizing:recommendations", [{
        "server_id": "1", "server_name": "db", "project_id": "p1", "tenant_name": "tenant-a",
        "classification": "memory-pressure", "cpu_avg_pct": 30, "mem_avg_pct": 95,
        "current_flavor": {"name": "2x8", "vcpus": 2, "ram_mb": 8192, "disk_gb": 40},
        "suggested_flavor": FLAVORS[3], "custom_flavor": custom,
    }], collected_at="2026-11-01T00:00:00")
    yield holder
    app.dependency_overrides.pop(user_connection, None)


def test_create_custom_flavor(admin, nova):
    url = "/api/rightsizing/recommendations/1/flavor"
    d = admin.get("/api/rightsizing/recommendations/1").json()
    assert d["custom"]["name"] == "rs.2c11g.40d" and d["custom"]["projected"]["mem"] is not None
    assert "fit" in d["custom"]

    nova["nova"] = FakeNova([_flv("rs.2c11g.40d", 1, 1024)])
    r = admin.post(url, json={"name": "rs.2c11g.40d"}, headers=CSRF)
    assert r.status_code == 409 and r.json()["detail"]["existing"] == "rs.2c11g.40d"
    # The same shape, private to another tenant, doesn't count; public does
    nova["nova"] = FakeNova([_flv("other", 2, 11264, public=False, fid="o")], {"o": ["p2"]})
    nova["nova"].fail_access = True
    r = admin.post(url, json={"name": "db-flavor"}, headers=CSRF)
    assert r.status_code == 502 and ("delete", "new-id") in nova["nova"].calls
    nova["nova"] = FakeNova([_flv("shared", 2, 11264)])
    assert admin.post(url, json={"name": "db-flavor"}, headers=CSRF).json()["detail"]["existing"] \
        == "shared"

    nova["nova"] = FakeNova()
    r = admin.post(url, json={"name": " db-flavor "}, headers=CSRF)
    assert r.status_code == 200, r.text
    (_, attrs), access, specs = nova["nova"].calls
    assert attrs["name"] == "db-flavor" and attrs["is_public"] is False
    assert (attrs["vcpus"], attrs["ram"], attrs["disk"]) == (2, 11264, 40)
    assert access == ("access", "new-id", "p1")
    assert specs == ("specs", "new-id", {"hw:cpu_policy": "shared"})
    [rec], at = db.cache_get("rightsizing:recommendations")
    assert rec["suggested_flavor"]["id"] == "new-id" and rec["custom_flavor"] is None
    assert at == "2026-11-01T00:00:00"
    assert db.cache_get("rightsizing:flavor_access")[0] == {"new-id": ["p1"]}
    # Nothing left to create
    assert admin.post(url, json={"name": "again"}, headers=CSRF).status_code == 409


def test_ram_that_counts_cache_isnt_memory_pressure():
    assert rs.classify(30, 95, False) == ("memory-pressure", "high")
    assert rs.classify(30, 95, False, mem_counts_cache=True) == ("right-sized", "low")
    assert rs.classify(90, 95, False, mem_counts_cache=True)[0] == "cpu-pressure"
    assert rs.classify(5, 10, False, mem_counts_cache=True)[0] == "overprovisioned"
    rec = {"classification": "right-sized", "cpu_avg_pct": 30, "mem_avg_pct": 95,
           "mem_source": "pcd", "window_days": 7, "current_flavor": {"vcpus": 2, "ram_mb": 4096}}
    why = rs.reasons(rec)
    assert "between 20 % and 80 %" in why[0] and "RAM" not in why[0]
    assert "counts the guest's disk cache" in why[1]
    # CPU pressure with cache-counting RAM: only CPU grows
    rec |= {"classification": "cpu-pressure", "cpu_avg_pct": 95}
    assert rs.basis(rec)["ram_mb"] == 4096 and rs.basis(rec)["vcpus"] > 2
    local = {**rec, "mem_source": "local", "source": "pcd", "mem_window_days": 3,
             "mem_avg_pct": 22}
    assert "PCD Ops' metrics store (its last 3 days)" in rs.reasons(local)[-1]


def test_collector_takes_ram_from_the_local_store(monkeypatch):
    import time as _time

    from app.agent import collector
    from app.services import local_metrics, metrics_catalog

    def series(values):
        return [{"metric": {"domain": d}, "values": [[1_800_000_000, str(v)]]}
                for d, v in values.items()]

    class Prom:
        def __init__(self, src):
            self.src = src

        async def query(self, q):
            return []

        async def query_range(self, q, start, end, step):
            if self.src == "local":
                assert "used_percent" in q
                return series({"vm1": 22})          # vm2 has no local data
            if "cpu" in q:
                return series({"vm1": 30, "vm2": 30})
            if "mem" in q:
                return series({"vm1": 95, "vm2": 95})
            return []

    async def source(min_days=0):
        return "local" if min_days <= collector.RS_MEM_LOCAL_MIN_DAYS else "pcd"

    monkeypatch.setattr(metrics_catalog, "source", source)
    monkeypatch.setattr(metrics_catalog, "client", lambda s: Prom(s))
    monkeypatch.setattr(local_metrics, "collecting_since", lambda: _time.time() - 3.5 * 86400)
    monkeypatch.setattr(settings, "ai_rightsizing_enabled", False)
    flavor = {"original_name": "2x4", "vcpus": 2, "ram": 4096, "disk": 20}
    def vm(i):
        return NS(id=i, name=i, status="ACTIVE", project_id="p1", flavor=flavor, image={},
                  hypervisor_hostname="h1")

    conn = NS(compute=NS(servers=lambda all_projects: [vm("vm1"), vm("vm2")], flavors=lambda: [],
                         get_flavor_access=lambda f: []))
    monkeypatch.setattr(collector, "get_connection", lambda: conn)
    monkeypatch.setattr(collector, "get_ai_provider", lambda: None)

    asyncio.run(collector.collect_rightsizing())
    recs = {r["server_id"]: r for r in db.cache_get("rightsizing:recommendations")[0]}
    assert recs["vm1"]["mem_source"] == "local" and recs["vm1"]["mem_avg_pct"] == 22
    assert recs["vm1"]["mem_window_days"] == 3 and recs["vm1"]["source"] == "pcd"
    assert recs["vm2"]["mem_source"] == "pcd" and recs["vm2"]["mem_avg_pct"] == 95
    assert {r["classification"] for r in recs.values()} == {"right-sized"}
