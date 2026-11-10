"""Statistical anomaly detection: scoring (services/anomaly.py), the collector and the API."""

from __future__ import annotations

import asyncio
import math
from types import SimpleNamespace as NS

from app.services import anomaly as an
from app.services import db

NOW = 1_793_000_000 - (1_793_000_000 % 3600)  # on the hour
CPU = an.RULE[("vm", "cpu_pct")]
MEM = an.RULE[("vm", "mem_pct")]


def series(hours, f, last=None):
    """Hourly points ending now; f(hour of day, i) gives each value, `last` overrides the last."""
    pts = [
        (NOW - (hours - 1 - i) * 3600, f(((NOW - (hours - 1 - i) * 3600) // 3600) % 24, i))
        for i in range(hours)
    ]
    if last is not None:
        pts[-1] = (pts[-1][0], last)
    return pts


def noisy(base):
    return lambda h, i: base + 2 * math.sin(i * 1.7)


def test_needs_a_day_of_history_and_a_current_hour():
    assert an.score(series(20, noisy(20), last=95), CPU, NOW) is None
    assert an.score(series(48, noisy(20), last=95), CPU, NOW + 3 * 3600) is None
    f = an.score(series(48, noisy(20), last=95), CPU, NOW)
    assert f["severity"] == "critical" and f["direction"] == "up" and f["baseline"] == "window"
    assert len(f["spark"]) == an.SPARK_POINTS


def test_minimum_change_and_direction():
    # A flat idle VM: a tiny change is many sigmas but not an anomaly
    assert an.score(series(48, lambda h, i: 0.1, last=0.9), CPU, NOW) is None
    # CPU counts both ways, memory only up
    assert an.score(series(48, noisy(70), last=5), CPU, NOW)["direction"] == "down"
    assert an.score(series(48, noisy(70), last=5), MEM, NOW) is None
    assert an.score(series(48, noisy(40), last=90), MEM, NOW)["severity"] in ("high", "critical")


def test_seasonal_baseline_knows_the_nightly_backup():
    # Every night at 02:00 UTC the VM runs at 85 %, otherwise 10 %; the last hour is 02:00
    end = NOW - ((NOW // 3600 - 2) % 24) * 3600
    pts = [(end - k * 3600, 0.0) for k in range(24 * 8 - 1, -1, -1)]
    pts = [
        (ts, (85 if (ts // 3600) % 24 == 2 else 10) + math.sin(n)) for n, (ts, _) in enumerate(pts)
    ]
    pts[-1] = (end, 86.0)
    assert an.score(pts, CPU, end) is None  # usual for 2 am
    pts[-1] = (end, 10.0)  # the backup didn't run: far below
    f = an.score(pts, CPU, end)
    assert f["baseline"] == "seasonal" and f["direction"] == "down"
    # The whole window's mean (about 13 %) would have called the 2 am run an anomaly instead
    assert an.score(pts[-48:-1] + [(end, 86.0)], CPU, end)["direction"] == "up"


def test_severity_bands():
    assert [an.severity(z) for z in (2.9, 3, -4.6, 6.1)] == [None, "medium", "high", "critical"]
    assert (
        an.worse("high", None) and an.worse("critical", "high") and not an.worse("medium", "high")
    )


def test_collector_findings_since_and_alerts_on_new_or_worse(monkeypatch):
    from app.agent import collector
    from app.services import alerts, metrics_catalog

    db.cache_set(
        "inventory:servers",
        [{"id": "vm1", "name": "web-1", "project_id": "p1", "hypervisor_hostname": "hyp1"}],
    )
    db.cache_set("inventory:hypervisors", [{"id": "h1", "hostname": "hyp1", "service_host": "s1"}])
    spike = {"v": 95.0}

    async def query_range(q, start, end, step):
        assert q.startswith("avg_over_time((") and q.endswith(")[1h:5m])") and step == "1h"
        if "libvirt_domain_info_cpu_time" in q and "vcpu_delay" not in q:
            return [
                {
                    "metric": {"domain": "vm1"},
                    "values": [[ts, str(v)] for ts, v in series(48, noisy(20), last=spike["v"])],
                },
                {"metric": {"domain": "unknown-vm"}, "values": [[NOW, "99"]]},
            ]
        if "node_cpu_seconds_total" in q:
            return [
                {
                    "metric": {"hypervisor_id": "h1"},
                    "values": [[ts, str(v)] for ts, v in series(48, noisy(30))],
                }
            ]
        return []

    async def src(min_days=0):
        return "local"

    monkeypatch.setattr(metrics_catalog, "source", src)
    monkeypatch.setattr(metrics_catalog, "client", lambda s: NS(query_range=query_range))
    monkeypatch.setattr(
        collector,
        "datetime",
        NS(utcnow=lambda: __import__("datetime").datetime.utcfromtimestamp(NOW)),
    )
    raised = []

    async def fake(a):
        raised.append(a)

    monkeypatch.setattr(alerts, "raise_alert", fake)

    asyncio.run(collector.collect_anomaly())
    data, _ = db.cache_get("anomaly:latest")
    [f] = data["findings"]
    assert f["id"] == "vm:vm1:cpu_pct" and f["name"] == "web-1" and f["host"] == "hyp1"
    assert f["since"] and data["checked"] == {"vm": 1, "host": 1}
    assert data["note"].startswith("Compared with the whole")
    assert len(raised) == 1 and raised[0].key == "anomaly:vm:vm1:cpu_pct"
    assert raised[0].link == "/anomaly?id=vm:vm1:cpu_pct" and "far above usual" in raised[0].title

    asyncio.run(collector.collect_anomaly())  # same finding: no new alert
    assert len(raised) == 1
    spike["v"] = 20.0  # back to normal: finding and first-seen go
    asyncio.run(collector.collect_anomaly())
    assert db.cache_get("anomaly:latest")[0]["findings"] == []
    assert db.seen_get("anomaly") == {}


def test_collector_without_metrics(monkeypatch):
    from app.agent import collector
    from app.services import metrics_catalog

    async def none(min_days=0):
        return None

    monkeypatch.setattr(metrics_catalog, "source", none)
    asyncio.run(collector.collect_anomaly())
    assert "No metrics" in db.cache_get("anomaly:latest")[0]["note"]


def test_api_explanation_current(admin):
    assert admin.get("/api/anomaly/").status_code == 503
    db.cache_set("anomaly:latest", {"findings": [{"id": "vm:a:cpu_pct"}], "note": None, "checked": {}})
    assert admin.get("/api/anomaly/").json()["explanation"] is None
    db.cache_set("anomaly:explanation", {"text": "Both on hyp1", "finding_ids": ["vm:a:cpu_pct"]})
    body = admin.get("/api/anomaly/").json()
    assert body["explanation"] == "Both on hyp1" and body["explanation_current"] is True
    db.cache_set("anomaly:latest", {"findings": [{"id": "vm:b:cpu_pct"}], "note": None, "checked": {}})
    assert admin.get("/api/anomaly/").json()["explanation_current"] is False


def test_results_from_before_0_8_3_dont_break_the_page_or_detection(admin, monkeypatch):
    from app.agent import collector
    from app.services import metrics_catalog

    old = {"lookback_hours": 24, "analysis": "…", "metric_summary": {},
           "findings": [{"description": "web-1 CPU high", "severity": "high", "instance": "web-1"}]}
    db.cache_set("anomaly:latest", old)
    assert admin.get("/api/anomaly/").status_code == 503          # not a 500

    async def src(min_days=0):
        return "local"

    async def query_range(q, start, end, step):
        return []

    monkeypatch.setattr(metrics_catalog, "source", src)
    monkeypatch.setattr(metrics_catalog, "client", lambda s: NS(query_range=query_range))
    asyncio.run(collector.collect_anomaly())
    assert admin.get("/api/anomaly/").json()["findings"] == []
