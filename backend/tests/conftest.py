"""Test fixtures. Every test gets its own config.env, settings.json, state dir and database.

There is no auth bypass: tests log in through /api/auth/login with Keystone mocked, or put a
session in web_auth.sessions directly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.appliance import config_env, keystone, web_auth
from app.services import db, settings_store
from app.services import openstack as os_service

CSRF = {"X-Requested-With": "pcd-ops"}

CONFIG_ENV = """\
# Written by the PCD App Catalog at first boot. Redeploy to change.
PCD_APP_ID='pcd-ops'
PCD_APP_VERSION='0.5.0'
PCD_INSTANCE_NAME='pcd-ops-01'
PCD_REGION='lab'
PCD_PROJECT_ID='proj-123'
PCD_PROJECT_NAME='service'
PCD_AUTH_URL='https://pcd.example.com/keystone/v3'
AI_BACKEND='ollama'
"""


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    for k in ("PCD_AUTH_URL", "PCD_REGION", "PCD_PROJECT_ID", "PCD_PROJECT_NAME",
              "PCD_INSTANCE_NAME", "PCD_APP_ID"):
        monkeypatch.delenv(k, raising=False)
    cfg = tmp_path / "config.env"
    cfg.write_text(CONFIG_ENV)
    monkeypatch.setattr(config_env, "CONFIG_ENV", cfg)
    monkeypatch.setattr(settings_store, "_path", tmp_path / "settings.json")
    monkeypatch.setenv("PCD_OPS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "pcd_ops.db")
    db.init_db()
    web_auth.sessions.clear()
    web_auth.login_limiter.reset()
    os_service.reset_connection()
    yield tmp_path
    os_service.reset_connection()


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)   # no `with`: the lifespan (scheduler) doesn't start


def make_token(roles=("admin",), project_id="proj-123", hours=1, user="alice") -> keystone.Token:
    return keystone.Token(value=f"tok-{user}", user_id=f"uid-{user}", user_name=user,
                          project_id=project_id, project_name="service", roles=list(roles),
                          expires_at=datetime.now(timezone.utc) + timedelta(hours=hours))


@pytest.fixture
def mock_login(monkeypatch):
    """Keystone password login; records the calls. Set .token / .error to change the outcome."""
    class Login:
        token = make_token()
        error: Exception | None = None
        calls: list = []

        def __call__(self, auth_url, username, password, domain="Default", project_id=None,
                     verify=True, **kw):
            self.calls.append({"auth_url": auth_url, "username": username, "domain": domain,
                               "project_id": project_id, **kw})
            if self.error:
                raise self.error
            return self.token

    fake = Login()
    fake.calls = []
    monkeypatch.setattr(keystone, "login", fake)
    return fake


@pytest.fixture
def logged_in(client, mock_login):
    r = client.post("/api/auth/login", json={"username": "alice", "password": "pw"}, headers=CSRF)
    assert r.status_code == 200, r.text
    return client


class FakeResponse:
    def __init__(self, status: int, payload: dict | None = None):
        self.status_code = status
        self._payload = payload or {}
        self.response = self

    def json(self):
        return self._payload

    def raise_for_status(self):
        import requests
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)


@pytest.fixture
def keystone_api(monkeypatch):
    """Fake Keystone application-credential API (create and delete)."""
    import requests

    class API:
        created: list = []
        deleted: list = []
        delete_status = 204
        n = 0

        def post(self, url, json=None, headers=None, **kw):
            self.n += 1
            self.created.append({"url": url, "body": json, "headers": headers})
            return FakeResponse(201, {"application_credential": {
                "id": f"cred-{self.n}", "secret": f"s3cret-{self.n}", "project_id": "proj-123"}})

        def delete(self, url, headers=None, **kw):
            self.deleted.append({"url": url, "headers": headers})
            return FakeResponse(self.delete_status, {"error": {"message": "forbidden by policy"}})

    api = API()
    api.created, api.deleted = [], []
    monkeypatch.setattr(requests, "post", api.post)
    monkeypatch.setattr(requests, "delete", api.delete)
    return api
