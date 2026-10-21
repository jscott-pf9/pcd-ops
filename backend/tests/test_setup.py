"""First-run setup, background access and the 0.4.x migration (APPLIANCE_STANDARD §7.5–7.8)."""
import json
import os
import stat

import pytest

from app.appliance import app_credentials, state
from app.appliance import connection as pcd
from app.services import settings_store
from app.services import openstack as os_service

from .conftest import CSRF, make_token

LEGACY = {"os_auth_url": "https://pcd.example.com/keystone/v3", "os_username": "svc",
          "os_password": "hunter2", "os_project_name": "service", "os_region_name": "lab",
          "grafana_url": "https://pcd.example.com/grafana/"}


def test_authorize_mints_from_admin_token(logged_in, keystone_api):
    r = logged_in.post("/api/access/authorize", headers=CSRF)
    assert r.status_code == 200, r.text
    call = keystone_api.created[0]
    assert call["url"] == "https://pcd.example.com/keystone/v3/users/uid-alice/application_credentials"
    assert call["headers"] == {"X-Auth-Token": "tok-alice"}
    body = call["body"]["application_credential"]
    assert body["roles"] == [{"name": "admin"}]
    assert body["unrestricted"] is False
    assert body["name"].startswith("pcd-ops-pcd-ops-01-")

    assert logged_in.get("/api/health").json()["setup_required"] is False
    # The gate opens: no data collected yet, but no longer 409.
    assert logged_in.get("/api/inventory/servers").status_code == 503
    cred = logged_in.get("/api/access").json()["background"]
    assert cred["state"] == "authorized"
    assert cred["credential"]["owner"] == "alice"
    assert "secret_enc" not in cred["credential"]


def test_secret_is_encrypted_at_rest(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    d = state.state_dir()
    raw = (d / app_credentials.RECORD_FILE).read_text()
    assert "s3cret-1" not in raw
    assert app_credentials.decrypt(json.loads(raw)["secret_enc"]) == "s3cret-1"
    for name in (app_credentials.KEY_FILE, app_credentials.RECORD_FILE):
        assert stat.S_IMODE(os.stat(d / name).st_mode) == 0o600


def test_reauthorize_switches_then_deletes_old(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    r = logged_in.post("/api/access/authorize", headers=CSRF)
    assert r.json()["warning"] is None
    assert app_credentials.load_record()["id"] == "cred-2"
    assert keystone_api.deleted[0]["url"].endswith("/users/uid-alice/application_credentials/cred-1")


def test_reauthorize_reports_undeletable_old_credential(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    keystone_api.delete_status = 403
    r = logged_in.post("/api/access/authorize", headers=CSRF)
    assert r.status_code == 200
    assert app_credentials.load_record()["id"] == "cred-2"
    assert "couldn't be deleted" in r.json()["warning"]


def test_revoke_deletes_in_keystone_then_locally(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    r = logged_in.post("/api/access/revoke", headers=CSRF)
    assert r.status_code == 200
    assert keystone_api.deleted[0]["headers"] == {"X-Auth-Token": "tok-alice"}
    assert app_credentials.load_record() is None
    assert logged_in.get("/api/health").json()["setup_required"] is True
    assert logged_in.get("/api/inventory/servers").status_code == 409


def test_revoke_refused_by_keystone_keeps_record(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    keystone_api.delete_status = 403
    r = logged_in.post("/api/access/revoke", headers=CSRF)
    assert r.status_code == 502
    assert "forbidden by policy" in r.json()["detail"]
    assert app_credentials.load_record() is not None


# ── 0.4.x migration ──────────────────────────────────────────────────────────

def test_legacy_service_account_used_until_setup(monkeypatch):
    settings_store.save(LEGACY)
    assert os_service.background_status()["state"] == "legacy"
    assert os_service.background_available() and not os_service.setup_complete()
    seen = {}

    class FakeConn:
        config = type("C", (), {"config": {}})()

    def fake_connect(**kw):
        seen.update(kw)
        return FakeConn()

    monkeypatch.setattr(os_service.openstack, "connect", fake_connect)
    conn = os_service.get_connection()
    assert seen["username"] == "svc" and seen["interface"] == "public"
    assert conn.config.config["region_name"] == "lab"


def test_setup_deletes_legacy_credentials(logged_in, keystone_api):
    settings_store.save(LEGACY)
    logged_in.post("/api/access/authorize", headers=CSRF)
    saved = settings_store.load()
    assert not [k for k in saved if k.startswith("os_")]
    assert saved["grafana_url"] == LEGACY["grafana_url"]     # app settings are kept
    assert os_service.background_status()["state"] == "authorized"


def test_legacy_install_without_config_env(isolated, client, mock_login, keystone_api):
    """A 0.4.x appliance (no config.env): log in with the project from settings.json, and the
    non-secret connection details survive the credential cleanup."""
    (isolated / "config.env").unlink()
    settings_store.save(LEGACY)
    r = client.post("/api/auth/login", json={"username": "alice", "password": "pw"}, headers=CSRF)
    assert r.status_code == 200
    assert mock_login.calls[0]["project_id"] is None
    assert mock_login.calls[0]["project_name"] == "service"
    client.post("/api/access/authorize", headers=CSRF)
    assert not [k for k in settings_store.load() if k.startswith("os_")]
    conn = pcd.load()
    assert (conn.auth_url, conn.region, conn.project_id) == (
        "https://pcd.example.com/keystone/v3", "lab", "proj-123")


# ── Connection before first login ───────────────────────────────────────────

def test_connection_form_only_while_unconfigured(isolated, client, monkeypatch):
    import requests

    from .conftest import FakeResponse
    body = {"auth_url": "https://other/keystone/v3", "project_name": "admin"}
    assert client.post("/api/access/connection", json=body, headers=CSRF).status_code == 409

    (isolated / "config.env").unlink()
    monkeypatch.setattr(requests, "get", lambda url, **kw: FakeResponse(200, {"version": {}}))
    r = client.post("/api/access/connection", json=body, headers=CSRF)
    assert r.status_code == 200, r.text
    assert pcd.load().auth_url == "https://other/keystone/v3"
    # Once set, it can't be changed from the web UI.
    assert client.post("/api/access/connection", json=body, headers=CSRF).status_code == 409


# ── Background 401 → re-authorize banner ────────────────────────────────────

def test_refused_credential_is_flagged(logged_in, keystone_api, monkeypatch):
    from keystoneauth1 import exceptions as ksa_exc
    logged_in.post("/api/access/authorize", headers=CSRF)
    monkeypatch.setattr(os_service.app_credentials, "connection", lambda *a, **k: object())
    os_service.background_connection()

    err = RuntimeError("collector failed")
    err.__cause__ = ksa_exc.Unauthorized("The request you have made requires authentication.")
    assert os_service.report_background_failure(err) is True

    assert logged_in.get("/api/health").json()["setup_required"] is True
    assert logged_in.get("/api/auth/session").json()["background"] == "failed"
    # The UI stays usable (cached data) and shows the banner instead of forcing /setup.
    assert logged_in.get("/api/inventory/servers").status_code == 503
    assert not os_service.background_available()
    with pytest.raises(os_service.BackgroundAccessError):
        os_service.background_connection()
    # Re-authorizing clears it.
    logged_in.post("/api/access/authorize", headers=CSRF)
    assert logged_in.get("/api/auth/session").json()["background"] == "authorized"


def test_deleted_credential_404_counts_as_refused():
    """Live behaviour: Keystone answers a deleted application credential with 404 on
    /auth/tokens. An ordinary 404 from a service API is not an auth failure."""
    from keystoneauth1 import exceptions as ksa_exc
    gone = ksa_exc.NotFound("Could not find Application Credential: abc.", http_status=404,
                            url="https://pcd.example.com/keystone/v3/auth/tokens")
    assert os_service.is_auth_failure(gone)
    missing_server = ksa_exc.NotFound("server not found", http_status=404,
                                      url="https://pcd.example.com/compute/v2.1/servers/x")
    assert not os_service.is_auth_failure(missing_server)


def test_interactive_failures_dont_flag_the_credential(logged_in, keystone_api):
    from keystoneauth1 import exceptions as ksa_exc
    logged_in.post("/api/access/authorize", headers=CSRF)
    with os_service.acting_as(object()):
        assert os_service.report_background_failure(ksa_exc.Unauthorized()) is False
    assert os_service.background_status()["state"] == "authorized"


# ── Which identity a call runs as ────────────────────────────────────────────

def test_get_connection_prefers_the_user(monkeypatch):
    user_conn, bg_conn = object(), object()
    monkeypatch.setattr(os_service, "background_connection", lambda: bg_conn)
    assert os_service.get_connection() is bg_conn
    with os_service.acting_as(user_conn):
        assert os_service.get_connection() is user_conn
    assert os_service.get_connection() is bg_conn


async def test_tasks_started_by_a_user_act_as_that_user(monkeypatch):
    import asyncio
    user_conn = object()
    monkeypatch.setattr(os_service, "background_connection", lambda: "background")

    async def job():
        await asyncio.sleep(0)
        return await asyncio.to_thread(os_service.get_connection)

    with os_service.acting_as(user_conn):
        task = asyncio.create_task(job())
    assert await task is user_conn


async def test_scheduler_waits_for_setup(monkeypatch):
    from app.agent import runner
    started = []
    monkeypatch.setattr(runner.db, "run_start", lambda: started.append(1) or 1)
    await runner.run_fast()
    assert started == []


def test_user_connection_uses_the_session_token(monkeypatch):
    seen = {}

    def fake_user_connection(auth_url, tok, region, verify=True):
        seen.update(auth_url=auth_url, token=tok.value, region=region)
        return "conn"

    monkeypatch.setattr(os_service.keystone, "user_connection", fake_user_connection)
    session = {"token": make_token()}
    assert os_service.connection_for_session(session) == "conn"
    assert os_service.connection_for_session(session) == "conn"   # cached on the session
    assert seen == {"auth_url": "https://pcd.example.com/keystone/v3", "token": "tok-alice",
                    "region": "lab"}
