"""Export of App Builder data for PCD App Builder (the import side is tested there). PCD Ops no
longer creates the two tables; an install that used App Builder still has them."""
import json

import pytest

from app.services import db
from app.services import openstack as os_service

TF_STATE = '{"version": 4, "resources": []}\n'


@pytest.fixture(autouse=True)
def setup_done(monkeypatch):
    monkeypatch.setattr(os_service, "setup_complete", lambda: True)


def _old_install():
    """The two tables as PCD Ops 0.5 created them, with one profile and one deployment."""
    with db._connect() as conn:
        conn.executescript("""
            CREATE TABLE saved_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL);
            CREATE TABLE deployments (id TEXT PRIMARY KEY, app_name TEXT NOT NULL,
                profile_id INTEGER, tenant_name TEXT NOT NULL, network_name TEXT, key_pair TEXT,
                extra_vars TEXT NOT NULL DEFAULT '{}', hcl TEXT NOT NULL, tf_state TEXT,
                outputs TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'deploying',
                error_msg TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        """)
        conn.execute("INSERT INTO saved_configs VALUES (7, 'Shop', 'app-profile', ?, 't', 't')",
                     (json.dumps({"hcl": "h", "params": {}}),))
        conn.execute("INSERT INTO deployments VALUES ('dep-1', 'shop', 7, 'acme', 'net', 'k', "
                     "'{\"a\": \"b\"}', 'hcl', ?, '{}', 'running', NULL, 't', 't')", (TF_STATE,))


def test_export_has_library_and_deployments_with_state(logged_in):
    _old_install()
    r = logged_in.get("/api/orchestration/export")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="pcd-ops-app-builder-')
    body = r.json()
    assert body["format"] == "pcd-ops-orchestration/v1"
    assert body["saved_configs"] == [{"id": 7, "name": "Shop", "type": "app-profile",
                                      "content": {"hcl": "h", "params": {}},
                                      "created_at": "t", "updated_at": "t"}]
    [d] = body["deployments"]
    assert d["tf_state"] == TF_STATE and d["profile_id"] == 7 and d["extra_vars"] == {"a": "b"}


def test_export_without_app_builder_data(logged_in):
    body = logged_in.get("/api/orchestration/export").json()
    assert body["saved_configs"] == [] and body["deployments"] == []


def test_app_builder_routes_are_gone(logged_in):
    assert logged_in.get("/api/deployments/").status_code == 404
    assert logged_in.get("/api/generate/saved").status_code == 404


def test_export_needs_login(client):
    assert client.get("/api/orchestration/export").status_code == 401
