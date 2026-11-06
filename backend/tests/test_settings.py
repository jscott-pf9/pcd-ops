"""Settings page: every field saves, changes apply without a restart, secrets stay masked;
Grafana/Prometheus lookup; Private AI; capacity-report email recipient."""

import asyncio
import os
import stat

import httpx
import pytest

from app.appliance import state
from app.config import settings
from app.dependencies import get_ai_provider
from app.services import prometheus, settings_store
from app.services.ai import ClaudeProvider, PrivateAIProvider
from app.services.ai import private as private_ai

from .conftest import CSRF


def test_every_tab_saves_its_fields(admin):
    alerts = {
        "smtp_host": "smtp.example.com",
        "smtp_port": "25",
        "smtp_password": "pw",
        "alert_email_to": "ops@example.com",
        "webhook_url": "https://hooks.example.com/x",
    }
    ssh = {"hypervisor_ssh_user": "pf9", "hypervisor_ssh_key_path": "/var/lib/pcd-ops/id_ed25519"}
    retention = {"job_run_retention_days": 7, "report_retention_days": 0}
    for payload in (alerts, ssh, retention):
        assert admin.put("/api/settings", json=payload, headers=CSRF).status_code == 200

    saved = settings_store.load()
    for k, v in {**alerts, **ssh, **retention}.items():
        assert saved[k] == v and getattr(settings, k) == v
    path = state.state_dir() / "settings.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    body = admin.get("/api/settings").json()
    assert body["smtp_password"] == "***" and body["smtp_host"] == "smtp.example.com"
    # A blank or masked secret keeps the saved one; other fields can be blanked.
    admin.put("/api/settings", json={"smtp_password": "", "webhook_url": ""}, headers=CSRF)
    assert settings.smtp_password == "pw" and settings.webhook_url == ""


def test_ai_change_applies_without_restart(admin):
    admin.put(
        "/api/settings",
        json={"ai_backend": "ollama", "ai_url": "http://ai:11434/v1", "ai_model": "llama3.1:8b"},
        headers=CSRF,
    )
    assert isinstance(get_ai_provider(), PrivateAIProvider)
    admin.put(
        "/api/settings", json={"ai_backend": "claude", "ai_api_key": "sk-ant-x"}, headers=CSRF
    )
    provider = get_ai_provider()
    assert isinstance(provider, ClaudeProvider)
    assert provider.model == "claude-opus-5-5"  # llama3.1:8b isn't a Claude model
    admin.put("/api/settings", json={"ai_model": "claude-haiku-5-5"}, headers=CSRF)
    assert get_ai_provider().model == "claude-haiku-5-5"


def test_grafana_url_defaults_to_the_pcd_host(admin):
    body = admin.get("/api/settings").json()
    assert body["grafana_url"] == ""
    assert body["grafana_url_default"] == "https://pcd.example.com/grafana"
    assert prometheus.grafana_url() == "https://pcd.example.com/grafana"
    settings.grafana_url = "https://grafana.example.com/"
    assert prometheus.grafana_url() == "https://grafana.example.com"


FRONTEND_SETTINGS = {
    "datasources": {
        "Loki": {"id": 3, "uid": "loki", "type": "loki", "name": "Loki"},
        "VM": {
            "id": 1,
            "uid": "vm",
            "type": "prometheus",
            "name": "VictoriaMetrics",
            "isDefault": True,
        },
    }
}


def test_prometheus_found_through_grafana(http):
    seen, routes = http
    g = "https://pcd.example.com/grafana"
    routes[f"{g}/api/frontend/settings"] = lambda r: httpx.Response(200, json=FRONTEND_SETTINGS)
    routes[f"{g}/api/datasources/proxy/1/api/v1/query"] = lambda r: httpx.Response(
        200, json={"data": {"result": [{"value": [0, "1"]}]}}
    )
    settings.grafana_token = "glsa_x"
    settings.prometheus_url = ""
    prometheus._found.clear()

    result = asyncio.run(prometheus.prometheus_client.query("vector(1)"))
    assert result == [{"value": [0, "1"]}]
    assert seen[-1].headers["Authorization"] == "Bearer glsa_x"
    target = asyncio.run(prometheus.resolve())
    assert (target["source"], target["name"]) == ("grafana", "VictoriaMetrics")


def test_prometheus_lookup_errors(http):
    _, routes = http
    g = "https://pcd.example.com/grafana"
    routes[f"{g}/api/frontend/settings"] = lambda r: httpx.Response(401, json={})
    with pytest.raises(prometheus.MetricsNotConfigured, match="refused the token"):
        asyncio.run(prometheus.find_datasource(g, "bad"))
    with pytest.raises(prometheus.MetricsNotConfigured, match="token"):
        asyncio.run(prometheus.find_datasource(g, ""))


def test_metrics_test_endpoint(admin, http):
    _, routes = http
    g = "https://pcd.example.com/grafana"
    routes[f"{g}/api/frontend/settings"] = lambda r: httpx.Response(200, json=FRONTEND_SETTINGS)
    routes[f"{g}/api/datasources/proxy/1/"] = lambda r: httpx.Response(
        200, json={"data": {"result": [{"value": [0, "1"]}]}}
    )
    r = admin.post(
        "/api/settings/metrics/test", json={"grafana_token": "glsa_x"}, headers=CSRF
    ).json()
    assert r["ok"] and r["datasource"] == "VictoriaMetrics"
    assert r["prometheus_url"] == f"{g}/api/datasources/proxy/1"


def test_private_ai_speaks_ollama_or_openai(http):
    seen, routes = http
    routes["http://ollama:11434/api/tags"] = lambda r: httpx.Response(
        200, json={"models": [{"name": "llama3.1:8b"}, {"name": "gemma4:31b"}]}
    )
    routes["http://ollama:11434/api/generate"] = lambda r: httpx.Response(
        200, json={"response": "OK"}
    )
    routes["http://vllm:8000/v1/models"] = lambda r: httpx.Response(
        200, json={"data": [{"id": "qwen"}]}
    )
    routes["http://vllm:8000/v1/chat/completions"] = lambda r: httpx.Response(
        200, json={"choices": [{"message": {"content": "OK"}}]}
    )
    private_ai._flavors.clear()

    ollama = PrivateAIProvider("http://ollama:11434/", "llama3.1:8b")
    assert asyncio.run(ollama.models()) == ["gemma4:31b", "llama3.1:8b"]
    assert asyncio.run(ollama.analyze("hi", {})) == "OK"

    vllm = PrivateAIProvider("http://vllm:8000/v1", "qwen", api_key="k")
    assert asyncio.run(vllm.models()) == ["qwen"]
    assert asyncio.run(vllm.analyze("hi", {})) == "OK"
    assert seen[-1].headers["Authorization"] == "Bearer k"


def test_ai_test_endpoint(admin, http):
    _, routes = http
    routes["http://ollama:11434/api/tags"] = lambda r: httpx.Response(
        200, json={"models": [{"name": "m"}]}
    )
    routes["http://ollama:11434/api/generate"] = lambda r: httpx.Response(
        200, json={"response": "OK"}
    )
    private_ai._flavors.clear()
    body = {"ai_backend": "ollama", "ai_url": "http://ollama:11434", "ai_model": "m"}
    r = admin.post("/api/settings/ai/test", json=body, headers=CSRF).json()
    assert r == {"ok": True, "models": ["m"], "model": "m", "reply": "OK"}
    assert admin.post("/api/settings/ai/models", json=body, headers=CSRF).json() == {
        "models": ["m"]
    }
    # Claude without a key is refused before any call.
    r = admin.post("/api/settings/ai/models", json={"ai_backend": "claude"}, headers=CSRF)
    assert r.status_code == 400


def test_report_purge_route_is_reachable(admin):
    r = admin.delete("/api/reports/purge?older_than_days=5", headers=CSRF)
    assert r.status_code == 200 and r.json() == {"deleted": 0, "older_than_days": 5}


def test_email_goes_to_the_given_recipient(monkeypatch):
    from app.services import notifications

    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, **kw):
            sent["server"] = (host, port)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def ehlo(self):
            pass

        def starttls(self):
            pass

        def login(self, user, pw):
            pass

        def sendmail(self, frm, to, msg):
            sent["to"] = to

    monkeypatch.setattr(notifications.smtplib, "SMTP", FakeSMTP)
    settings.smtp_host, settings.alert_email_to = "smtp.example.com", "oncall@example.com"
    assert asyncio.run(notifications.send_email("s", "b", to="a@example.com, b@example.com"))
    assert sent["to"] == ["a@example.com", "b@example.com"]
    assert asyncio.run(notifications.send_email("s", "b"))
    assert sent["to"] == ["oncall@example.com"]


def test_generate_ssh_key(admin):
    import paramiko

    assert admin.get("/api/settings/ssh/key").json()["public_key"] is None
    k = admin.post("/api/settings/ssh/key", json={}, headers=CSRF).json()
    assert k["generated"] and k["public_key"].startswith("ssh-ed25519 ")
    assert settings.hypervisor_ssh_key_path == k["path"] == settings_store.load()[
        "hypervisor_ssh_key_path"]
    assert stat.S_IMODE(os.stat(k["path"]).st_mode) == 0o600
    paramiko.Ed25519Key.from_private_key_file(k["path"])   # what the SSH collectors load
    assert admin.get("/api/settings/ssh/key").json()["public_key"] == k["public_key"]

    # A working key is replaced only when asked.
    assert admin.post("/api/settings/ssh/key", json={}, headers=CSRF).status_code == 409
    new = admin.post("/api/settings/ssh/key", json={"replace": True}, headers=CSRF).json()
    assert new["public_key"] != k["public_key"]


def test_rightsizing_says_why_it_has_no_data(admin):
    from app.agent.runner import RIGHTSIZING_ERROR
    from app.services import db

    r = admin.get("/api/rightsizing/recommendations")
    assert r.status_code == 503 and r.json()["detail"]["error"] is None
    db.run_finish(db.run_start(), "error", f"{RIGHTSIZING_ERROR}Grafana refused the token")
    detail = admin.get("/api/rightsizing/recommendations").json()["detail"]
    assert detail == {"code": "no_data", "key": "rightsizing:recommendations",
                      "error": "Grafana refused the token"}


def test_refresh_runs_rightsizing_off_schedule(monkeypatch):
    from app.agent import collector, runner
    from app.services import db

    ran = []

    async def fake():
        ran.append(1)
        db.cache_set("rightsizing:recommendations", [])

    monkeypatch.setattr(collector, "collect_rightsizing", fake)
    monkeypatch.setattr(runner, "_can_run", lambda tier: True)
    settings.ai_rightsizing_schedule = "daily@02:00"
    asyncio.run(runner.run_daily())              # never ran: runs now, not at 02:00
    asyncio.run(runner.run_daily())              # ran: waits for the schedule
    asyncio.run(runner.run_daily(force=True))    # Refresh
    assert len(ran) == 2
