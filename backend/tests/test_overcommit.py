"""CPU and memory overcommit: the rules (services/overcommit.py), the collector and the API."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS

from app.agent import collector
from app.services import db
from app.services import overcommit as o


def inv(total, ratio=1.0, reserved=0):
    return {"total": total, "reserved": reserved, "allocation_ratio": ratio}


def test_allocation_uses_reserved_and_ratio():
    a = o.allocation(inv(16, 2.0, reserved=2), 21)
    assert a["capacity"] == 28.0                 # (16 - 2) × 2
    assert a["effective_ratio"] == 1.5           # 21 vCPUs on 14 usable cores
    assert a["alloc_pct"] == 75.0
    assert a["headroom"] == 7.0
    assert o.allocation(None, 3) is None
    assert o.allocation(inv(0), 0) is None


def test_vm_wait_is_weighted_by_vcpus_with_the_worst_vm():
    servers = [{"id": "a", "name": "big", "host": "h1", "vcpus": 8},
               {"id": "b", "name": "small", "host": "h1", "vcpus": 2},
               {"id": "c", "name": "nohost", "host": None, "vcpus": 2}]
    w = o.vm_wait_by_host(servers, {"a": 1.0, "b": 11.0, "c": 50.0})
    assert w == {"h1": {"avg": 3.0, "worst": {"id": "b", "name": "small", "pct": 11.0}}}


def test_cpu_contended_needs_overcommit_otherwise_busy():
    over = o.allocation(inv(16, 4.0), 40)        # 2.5 vCPUs per core
    assert o.cpu_verdict(over, {"cpu_pct": 40, "cpu_wait_pct": 7})["status"] == "contended"
    assert o.cpu_verdict(over, {"cpu_pct": 90, "cpu_wait_pct": 0})["status"] == "contended"
    under = o.allocation(inv(16, 4.0), 12)
    v = o.cpu_verdict(under, {"cpu_pct": 92, "cpu_wait_pct": 0})
    assert v["status"] == "busy" and "without overcommit" in v["reason"]


def test_cpu_room_suggests_a_higher_ratio_in_half_steps():
    a = o.allocation(inv(16, 2.0), 30)           # 94 % of 32
    v = o.cpu_verdict(a, {"cpu_pct": 20, "cpu_wait_pct": 0.2})
    # 30 vCPUs at 20 % → 105 at 70 %: 6.56 per core, capped at double the 2:1 ratio
    assert v["status"] == "room" and v["suggested_ratio"] == 4.0
    v = o.cpu_verdict(a, {"cpu_pct": 40, "cpu_wait_pct": 0.2})
    assert v["suggested_ratio"] == 3.0           # 30 × 70/40 / 16 = 3.28 → 3.0
    # Room by load, but the ratio isn't nearly used up: nothing to suggest
    assert o.cpu_verdict(o.allocation(inv(16, 2.0), 10), {"cpu_pct": 5})["status"] == "ok"
    # Nearly full without load data, or with load: near_full
    assert o.cpu_verdict(a, {})["status"] == "near_full"
    assert o.cpu_verdict(a, {"cpu_pct": 60, "cpu_wait_pct": 0.5})["status"] == "near_full"
    assert o.cpu_verdict(None, {})["status"] == "unknown"


def test_memory_pressure_high_and_near_full():
    over = o.allocation(inv(65536, 1.5), 80000)
    assert o.mem_verdict(over, {"mem_pct": 95})["status"] == "pressure"
    assert o.mem_verdict(over, {"mem_pct": 60})["status"] == "near_full"
    flat = o.allocation(inv(65536, 1.0), 30000)
    assert o.mem_verdict(flat, {"mem_pct": 95})["status"] == "high"
    assert o.mem_verdict(flat, {"mem_pct": 40, "swap_in_pps": 250})["status"] == "pressure"
    assert o.mem_verdict(flat, {"mem_pct": 40})["status"] == "ok"


def test_hosts_clusters_and_totals():
    hyps = [{"id": "h1", "hostname": "one", "running_vms": 3},
            {"id": "h2", "hostname": "two", "running_vms": 1},
            {"id": "h3", "hostname": "unknown-to-placement"}]
    placement = {
        "h1": {"inventories": {"VCPU": inv(16, 2.0), "MEMORY_MB": inv(60000, 1.0, 512)},
               "usages": {"VCPU": 40, "MEMORY_MB": 30000}},
        "h2": {"inventories": {"VCPU": inv(16, 2.0), "MEMORY_MB": inv(60000, 1.0, 512)},
               "usages": {"VCPU": 8, "MEMORY_MB": 8000}},
    }
    load = {"h1": {"cpu_pct": 60, "mem_pct": 50}, "h2": {"cpu_pct": 10, "mem_pct": 20}}
    hosts = o.host_rows(hyps, placement, load, {"h1": {"avg": 9.0, "worst": None}})
    st = {h["id"]: h["cpu_verdict"]["status"] for h in hosts}
    assert st == {"h1": "contended", "h2": "ok", "h3": "unknown"}
    clusters = o.cluster_rows([{"id": 1, "name": "c", "hosts": [
        {"hypervisor_id": "h1"}, {"hypervisor_id": "h2"}, {"hypervisor_id": None}]}], hosts)
    c = clusters[0]
    assert c["hosts"] == 2 and c["cpu"]["allocated"] == 48 and c["cpu"]["capacity"] == 64
    assert c["cpu"]["effective_ratio"] == 1.5 and c["cpu"]["ratio"] == 2.0
    assert c["cpu_status"] == "contended" and c["cpu_counts"] == {"contended": 1, "ok": 1}
    assert c["load"]["cpu_pct"] == 35.0
    t = o.totals(hosts)
    assert t["cpu_counts"] == {"contended": 1, "ok": 1, "unknown": 1}
    assert t["memory"]["reserved"] == 1024


def test_collector_maps_load_and_vms_to_hosts(monkeypatch):
    db.cache_set("inventory:hypervisors", [
        {"id": "h1", "hostname": "one", "service_host": "svc1", "aggregates": ["c"]}])
    db.cache_set("inventory:clusters", [{"id": 1, "name": "c", "hosts": [{"hypervisor_id": "h1"}]}])
    db.cache_set("inventory:servers", [
        {"id": "v1", "name": "vm", "status": "ACTIVE", "flavor_vcpus": 4,
         "hypervisor_hostname": "one"},
        {"id": "v2", "name": "off", "status": "SHUTOFF", "flavor_vcpus": 4,
         "hypervisor_hostname": "one"}])

    def get(path):
        body = ({"inventories": {"VCPU": inv(8, 4.0), "MEMORY_MB": inv(32768)}}
                if path.endswith("inventories") else {"usages": {"VCPU": 30, "MEMORY_MB": 8192}})
        return NS(status_code=200, json=lambda: body, raise_for_status=lambda: None)

    monkeypatch.setattr(collector, "get_connection", lambda: NS(placement=NS(get=get)))

    async def src(min_days=0):
        return "pcd"

    seen = []

    async def query(q):
        seen.append(q)
        if "vm_cpu_throttling" in q:
            return [{"metric": {"domain": "v1"}, "value": [0, "12.5"]}]
        if "hyp_cpu_usage" in q:
            return [{"metric": {"host": "svc1"}, "value": [0, "70"]}]
        return []

    monkeypatch.setattr(collector.metrics_catalog, "source", src)
    monkeypatch.setattr(collector.metrics_catalog, "client", lambda s: NS(query=query))
    asyncio.run(collector.collect_overcommit())
    data, _ = db.cache_get("capacity:overcommit")
    h = data["hosts"][0]
    assert h["cpu"]["effective_ratio"] == 3.75
    assert h["load"]["cpu_pct"] == 70 and h["load"]["cpu_wait_pct"] == 12.5
    assert h["cpu_verdict"]["status"] == "contended"
    assert data["clusters"][0]["cpu_status"] == "contended"
    assert all(q.startswith("quantile_over_time(0.95, (") and "[168h:1h]" in q for q in seen)
    assert not any("pswpin" in q for q in seen)     # swap-in is local only
    assert data["load"] == {"source": "pcd", "hours": 168, "note": None}


def test_overcommit_503_until_collected(admin):
    assert admin.get("/api/capacity/overcommit").status_code == 503
    db.cache_set("capacity:overcommit", {"hosts": [], "clusters": [], "totals": {}})
    assert admin.get("/api/capacity/overcommit").json()["hosts"] == []
