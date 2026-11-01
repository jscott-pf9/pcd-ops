"""Export of App Builder data for PCD App Builder (the import side is tested there)."""
import pytest

from app.services import db
from app.services import openstack as os_service

TF_STATE = '{"version": 4, "resources": []}\n'


@pytest.fixture(autouse=True)
def setup_done(monkeypatch):
    monkeypatch.setattr(os_service, "setup_complete", lambda: True)


def test_export_has_library_and_deployments_with_state(logged_in):
    profile = db.saved_config_create("Shop", "app-profile", {"hcl": "h", "params": {}})
    dep = db.deployment_create("shop", profile["id"], "acme", "net", "k", "hcl", {"a": "b"})
    db.deployment_update(dep["id"], status="running", tf_state=TF_STATE)

    r = logged_in.get("/api/orchestration/export")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="pcd-ops-app-builder-')
    body = r.json()
    assert body["format"] == "pcd-ops-orchestration/v1"
    shop = next(c for c in body["saved_configs"] if c["name"] == "Shop")
    assert shop["type"] == "app-profile" and shop["content"] == {"hcl": "h", "params": {}}
    assert {c["type"] for c in body["saved_configs"]} >= {"role", "sg-template"}
    [d] = body["deployments"]
    assert d["tf_state"] == TF_STATE and d["profile_id"] == profile["id"]
    assert d["extra_vars"] == {"a": "b"}


def test_export_needs_login(client):
    assert client.get("/api/orchestration/export").status_code == 401
