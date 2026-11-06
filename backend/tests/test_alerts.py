"""Alerts (services/alerts.py): rules, cooldown, channels, payloads, job alerts and the API."""
from __future__ import annotations

import asyncio

import pytest

from app.config import settings
from app.services import alerts, db, notifications
from tests.conftest import CSRF


@pytest.fixture
def sent(monkeypatch):
    """Every channel configured; deliveries captured instead of sent."""
    out: dict[str, list] = {"email": [], "webhook": [], "slack": []}

    async def email(subject, body, html=None, to=None):
        out["email"].append((subject, body))

    async def webhook(payload):
        out["webhook"].append(payload)

    async def slack(payload):
        out["slack"].append(payload)
        return "HTTP 404: no_service"

    monkeypatch.setattr(notifications, "deliver_email", email)
    monkeypatch.setattr(notifications, "deliver_webhook", webhook)
    monkeypatch.setattr(notifications, "deliver_slack", slack)
    for k, v in {"smtp_host": "smtp", "alert_email_to": "ops@x", "webhook_url": "http://hook",
                 "slack_webhook_url": "https://hooks.slack.com/x",
                 "alert_base_url": "http://pcd-ops.lab/"}.items():
        monkeypatch.setattr(settings, k, v)
    return out


def raise_(a):
    return asyncio.run(alerts.raise_alert(a))


def test_rules_minimum_severity_and_off(sent, monkeypatch):
    monkeypatch.setattr(settings, "alert_anomaly_min", "high")
    assert raise_(alerts.Alert("anomaly", "a", "medium", "m")) is None
    assert raise_(alerts.Alert("anomaly", "a", "high", "h"))["severity"] == "high"
    monkeypatch.setattr(settings, "alert_drift_enabled", False)
    assert raise_(alerts.Alert("drift", "d", "critical", "c")) is None
    assert len(sent["email"]) == 1


def test_cooldown_suppresses_repeats_but_not_escalation(sent, monkeypatch):
    monkeypatch.setattr(settings, "alert_drift_min", "low")
    first = raise_(alerts.Alert("drift", "drift:flavors", "medium", "x"))
    again = raise_(alerts.Alert("drift", "drift:flavors", "medium", "x"))
    worse = raise_(alerts.Alert("drift", "drift:flavors", "high", "x"))
    lower = raise_(alerts.Alert("drift", "drift:flavors", "low", "x"))
    assert [first["suppressed"], again["suppressed"], worse["suppressed"], lower["suppressed"]] \
        == [False, True, False, True]
    assert len(sent["webhook"]) == 2
    monkeypatch.setattr(settings, "alert_cooldown_min", 0)
    assert raise_(alerts.Alert("drift", "drift:flavors", "low", "x"))["suppressed"] is False


def test_results_per_channel_and_event_log(sent):
    rec = raise_(alerts.Alert("job", "job:1", "high", "Job x failed"))
    assert rec["results"] == {"email": None, "webhook": None, "slack": "HTTP 404: no_service"}
    ev = db.get_recent_events(5)[0]
    assert ev["title"] == "Alert (high): Job x failed" and ev["level"] == "error"
    assert "Not sent to slack" in ev["detail"] and "Sent to email, webhook" in ev["detail"]


def test_only_configured_channels(sent, monkeypatch):
    monkeypatch.setattr(settings, "slack_webhook_url", "")
    monkeypatch.setattr(settings, "smtp_host", "")
    rec = raise_(alerts.Alert("job", "job:2", "high", "t"))
    assert list(rec["results"]) == ["webhook"]


def test_payloads():
    a = alerts.Alert("drift", "drift:security_groups", "high", "2 changes <now>", "body",
                     fields=[["Kind", "security group"]], link="/changes")
    settings.alert_base_url = "http://ops/"
    try:
        w = alerts.webhook_payload(a)
        assert {"source", "severity", "subject", "body", "findings"} <= set(w)
        assert w["source"] == "pcd-ops" and w["alert_source"] == "drift" and w["link"] == "http://ops/changes"
        s = alerts.slack_payload(a)
        att = s["attachments"][0]
        assert att["color"] == alerts.SLACK_COLOR["high"] and s["text"].startswith("[high]")
        assert "&lt;now&gt;" in att["blocks"][0]["text"]["text"]       # Slack mrkdwn escaped
        assert att["blocks"][-1]["elements"][0]["url"] == "http://ops/changes"
    finally:
        settings.alert_base_url = ""
    assert "View in PCD Ops" not in str(alerts.slack_payload(a))      # no address, no button


def test_job_failure_partial_failure_and_success(sent, monkeypatch):
    from app.agent import jobs

    async def boom(cfg):
        raise RuntimeError("Keystone said no")

    async def partly(cfg):
        jobs._fail("snapshot of volume v1", RuntimeError("quota exceeded"))
        return {"summary": "Created 1 snapshot(s)"}

    async def fine(cfg):
        return {"summary": "ok"}

    monkeypatch.setitem(jobs._EXECUTORS, "boom", boom)
    monkeypatch.setitem(jobs._EXECUTORS, "partly", partly)
    monkeypatch.setitem(jobs._EXECUTORS, "fine", fine)
    monkeypatch.setattr("app.services.openstack.report_background_failure", lambda e: None)
    job_id = db.job_create("nightly", "boom", None, {})["id"]
    asyncio.run(jobs.execute_job({"id": job_id, "type": "boom", "name": "nightly"}))
    asyncio.run(jobs.execute_job({"id": job_id + 100, "type": "partly", "name": "snaps"}))
    asyncio.run(jobs.execute_job({"id": job_id + 200, "type": "fine", "name": "ok-job"}))
    titles = [(a["severity"], a["title"]) for a in db.alert_list()]
    assert ("high", "Job nightly failed") in titles
    assert ("medium", "Job snaps: 1 item(s) failed") in titles
    assert not any("ok-job" in t for _, t in titles)
    monkeypatch.setattr(settings, "alert_jobs_success", True)
    asyncio.run(jobs.execute_job({"id": job_id + 200, "type": "fine", "name": "ok-job"}))
    assert db.alert_list()[0]["title"] == "Job ok-job succeeded"


def test_api_list_test_and_settings(admin, sent):
    r = admin.post("/api/alerts/test", json={"channel": "webhook"}, headers=CSRF).json()
    assert r == {"webhook": None} and sent["webhook"][0]["alert_source"] == "test"
    bad = admin.post("/api/alerts/test", json={"channel": "pager"}, headers=CSRF)
    assert bad.status_code == 400
    body = admin.get("/api/alerts").json()
    assert body["alerts"][0]["title"] == "Test alert from PCD Ops"
    assert set(body["channels"]) == {"email", "webhook", "slack"}
    assert admin.get("/api/settings").json()["slack_webhook_url"] == "***"
    bad = admin.put("/api/settings", json={"alert_drift_min": "urgent"}, headers=CSRF)
    assert bad.status_code == 400
    ok = admin.put("/api/settings", json={"alert_drift_min": "high"}, headers=CSRF)
    assert ok.status_code == 200
