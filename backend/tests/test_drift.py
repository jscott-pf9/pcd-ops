"""Config change log: snapshots and diffs (services/drift.py), the collector and the API."""

from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace as NS

from app.services import db
from app.services import drift as d

FLAVOR = {
    "id": "f1",
    "name": "m1.large",
    "vcpus": 4,
    "ram_mb": 8192,
    "disk_gb": 40,
    "ephemeral_gb": 0,
    "swap_mb": 0,
    "public": True,
    "disabled": False,
    "extra_specs": {"hw:cpu_policy": "shared"},
    "vms": 3,
}


def rule(port, prefix="0.0.0.0/0", desc=""):
    return {
        "direction": "ingress",
        "ethertype": "IPv4",
        "protocol": "tcp",
        "port_range_min": port,
        "port_range_max": port,
        "remote_ip_prefix": prefix,
        "remote_group_id": None,
        "description": desc,
    }


SG = {
    "id": "sg1",
    "name": "web",
    "description": "",
    "project_id": "p1",
    "rules": [rule(22), rule(443)],
}
AGG = {
    "id": 1,
    "name": "lab01",
    "availability_zone": "lab01",
    "metadata": {"pf9-managed": "true"},
    "hosts": [{"hostname": "hyp1"}, {"hostname": "hyp2"}],
}
HYP = {
    "id": "h1",
    "hostname": "hyp1",
    "state": "up",
    "status": "enabled",
    "hypervisor_version": 8002000,
    "os_version": "Ubuntu 22.04",
    "cpu_model": "EPYC",
    "vcpus_total": 16,
    "memory_mb_total": 65536,
    "running_vms": 4,
}
OC = [{"id": "h1", "cpu": {"ratio": 2.0, "reserved": 0}, "memory": {"ratio": 1.0, "reserved": 512}}]


def snap(**over):
    s = {
        "flavors": d.flavors([FLAVOR]),
        "security_groups": d.security_groups([SG]),
        "aggregates": d.aggregates([AGG]),
        "hosts": d.hosts([HYP], OC),
    }
    s.update(over)
    return s


def test_nothing_changed_and_volatile_fields_ignored():
    a = snap()
    busy = dict(HYP, running_vms=12)
    assert d.diff(a, snap(hosts=d.hosts([busy], OC))) == []
    assert d.diff(a, snap(flavors=d.flavors([dict(FLAVOR, vms=99)]))) == []


def test_rule_order_is_not_a_change_but_a_new_rule_is_high():
    a = snap()
    b = snap(security_groups=d.security_groups([dict(SG, rules=[rule(443), rule(22)])]))
    assert d.diff(a, b) == []
    c = snap(security_groups=d.security_groups([dict(SG, rules=[rule(22), rule(443), rule(3389)])]))
    [ch] = d.diff(a, c)
    assert ch["change"] == "modified" and ch["severity"] == "high"
    assert ch["fields"] == [
        {
            "field": "rules.ingress IPv4 tcp 3389 from 0.0.0.0/0",
            "op": "added",
            "before": None,
            "after": "",
        }
    ]
    # Only a rule's description changed: medium
    e = snap(security_groups=d.security_groups([dict(SG, rules=[rule(22, desc="ssh"), rule(443)])]))
    assert d.diff(a, e)[0]["severity"] == "medium"


def test_flavor_extra_spec_metadata_and_hosts():
    a = snap()
    b = snap(
        flavors=d.flavors([dict(FLAVOR, vcpus=8, extra_specs={"hw:cpu_policy": "dedicated"})]),
        aggregates=d.aggregates([dict(AGG, metadata={}, hosts=[{"hostname": "hyp1"}])]),
    )
    ch = {c["kind"]: c for c in d.diff(a, b)}
    assert [f["field"] for f in ch["flavors"]["fields"]] == ["extra_specs.hw:cpu_policy", "vcpus"]
    assert ch["flavors"]["severity"] == "medium"
    agg = ch["aggregates"]
    assert {(f["field"], f["op"]) for f in agg["fields"]} == {
        ("hosts.hyp2", "removed"),
        ("metadata.pf9-managed", "removed"),
    }
    assert agg["severity"] == "high"
    assert "vcpus 4 → 8" in d.describe(ch["flavors"])


def test_hosts_down_disabled_or_retuned():
    a = snap()
    down = d.diff(a, snap(hosts=d.hosts([dict(HYP, state="down")], OC)))
    assert down[0]["severity"] == "high"
    oc = copy.deepcopy(OC)
    oc[0]["cpu"]["ratio"] = 4.0
    [r] = d.diff(a, snap(hosts=d.hosts([HYP], oc)))
    assert r["fields"] == [
        {"field": "cpu_allocation_ratio", "op": "changed", "before": 2.0, "after": 4.0}
    ]
    assert r["severity"] == "medium"
    gone = d.diff(a, snap(hosts={}))
    assert gone[0]["change"] == "removed" and gone[0]["severity"] == "high"


def test_added_removed_renamed():
    a = snap()
    b = snap(flavors=d.flavors([dict(FLAVOR, name="m1.big"), dict(FLAVOR, id="f2", name="new")]))
    ch = d.diff(a, b)
    assert [(c["item_id"], c["change"]) for c in ch] == [("f1", "modified"), ("f2", "added")]
    assert ch[0]["fields"][0] == {
        "field": "name",
        "op": "changed",
        "before": "m1.large",
        "after": "m1.big",
    }


def test_quotas_skip_admin_and_failed_sources_are_not_removals():
    projects = [
        {"id": "p1", "name": "tenant-a"},
        {"id": "p0", "name": "admin"},
        {"id": "p2", "name": "tenant-b"},
    ]
    nova = {p: {"cores": 20, "ram": 51200, "fixed_ips": -1} for p in ("p0", "p1", "p2")}
    cinder = {p: {"id": p, "volumes": 10, "gigabytes": 1000} for p in ("p0", "p1", "p2")}
    neutron = {p: {"network": 100, "port": 500, "trunk": -1} for p in ("p0", "p1", "p2")}
    q = d.quotas(projects, nova, cinder, neutron)
    assert set(q) == {"p1", "p2"}
    assert q["p1"]["attrs"] == {
        "compute.cores": 20,
        "compute.ram": 51200,
        "block_storage.gigabytes": 1000,
        "block_storage.volumes": 10,
        "network.network": 100,
        "network.port": 500,
    }
    prev = snap(quotas=q)
    # p2's Cinder couldn't be read this time; flavors weren't collected at all
    cur = {
        k: v
        for k, v in snap(quotas=d.quotas(projects, nova, {"p1": cinder["p1"]}, neutron)).items()
        if k != "flavors"
    }
    kept = d.merge(prev, cur, {"quotas": {"p2"}})
    assert d.diff(prev, kept) == [] and set(kept["quotas"]) == {"p1", "p2"} and "flavors" in kept


def test_collector_first_run_then_changes_and_alerts(monkeypatch):
    from app.agent import collector
    from app.services import alerts

    db.cache_set("inventory:flavors", [FLAVOR])
    db.cache_set("inventory:security_groups", [SG])
    db.cache_set("inventory:clusters", [AGG])
    db.cache_set("inventory:hypervisors", [HYP])
    db.cache_set("capacity:overcommit", {"hosts": OC})
    db.cache_set(
        "inventory:tenants", [{"id": "p1", "name": "tenant-a"}, {"id": "p0", "name": "admin"}]
    )
    limits = {"cores": 20}
    asked = []

    def proxy(key, body):
        def get(path):
            asked.append(path)
            return NS(raise_for_status=lambda: None, json=lambda: {key: dict(body())})

        return NS(get=get)

    conn = NS(
        compute=proxy("quota_set", lambda: limits),
        block_storage=proxy("quota_set", lambda: {"volumes": 10}),
        network=proxy("quota", lambda: {"port": 500}),
    )
    monkeypatch.setattr(collector, "get_connection", lambda: conn)
    raised = []

    async def fake_raise(a):
        raised.append(a)

    monkeypatch.setattr(alerts, "raise_alert", fake_raise)

    asyncio.run(collector.collect_drift())
    assert db.drift_list() == [] and raised == []
    assert not any("p0" in p for p in asked)  # admin's quotas never read
    st, _ = db.cache_get("drift:status")
    assert st["items"]["quotas"] == 1 and st["last_changes"] == 0

    limits["cores"] = 40
    db.cache_set("inventory:security_groups", [dict(SG, rules=SG["rules"] + [rule(3389)])])
    asyncio.run(collector.collect_drift())
    rows = db.drift_list()
    assert {(r["kind"], r["severity"]) for r in rows} == {
        ("quotas", "medium"),
        ("security_groups", "high"),
    }
    assert sorted(a.key for a in raised) == ["drift:quotas", "drift:security_groups"]
    sg_alert = next(a for a in raised if a.key == "drift:security_groups")
    assert sg_alert.severity == "high" and "+rules.ingress IPv4 tcp 3389" in sg_alert.body
    assert sg_alert.link == "/changes?kind=security_groups"

    asyncio.run(collector.collect_drift())  # no further change
    assert len(db.drift_list()) == 2


def test_api(admin):
    assert admin.get("/api/drift/status").status_code == 503
    db.cache_set(
        "drift:status",
        {
            "started_at": "2026-11-06T00:00:00",
            "last_run": "x",
            "notes": {},
            "items": {},
            "last_changes": 0,
        },
    )
    db.drift_add(
        [
            {
                "kind": "flavors",
                "item_id": "f1",
                "name": "m1.large",
                "project_id": None,
                "change": "modified",
                "severity": "medium",
                "fields": [{"field": "vcpus", "op": "changed", "before": 4, "after": 8}],
            }
        ]
    )
    assert admin.get("/api/drift/status").json()["counts_24h"] == {"flavors": 1}
    rows = admin.get("/api/drift/changes?days=7&q=large").json()
    assert rows[0]["fields"][0]["after"] == 8
    assert admin.get("/api/drift/changes?q=nothing").json() == []
    assert admin.get("/api/drift/changes?kind=bogus").status_code == 400
