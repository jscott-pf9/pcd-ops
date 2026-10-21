"""Login, sessions and the request gate (APPLIANCE_STANDARD §7.1–7.3, §7.7)."""
import time

from app.appliance import keystone, web_auth

from .conftest import CSRF, make_token


def test_health_is_open_and_reports_setup(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "0.5.0"
    assert body["setup_required"] is True


def test_api_needs_login(client):
    r = client.get("/api/inventory/servers")
    assert r.status_code == 401
    assert r.json() == {"detail": "login required"}
    assert client.get("/api/settings").status_code == 401


def test_writes_need_csrf_header(client, mock_login):
    r = client.post("/api/auth/login", json={"username": "alice", "password": "pw"})
    assert r.status_code == 403
    assert mock_login.calls == []


def test_login_scopes_to_install_project(client, mock_login):
    r = client.post("/api/auth/login",
                    json={"username": "alice", "password": "pw", "domain": "corp"}, headers=CSRF)
    assert r.status_code == 200
    assert r.json()["user"] == "alice"
    call = mock_login.calls[0]
    assert call["auth_url"] == "https://pcd.example.com/keystone/v3"
    assert call["project_id"] == "proj-123"
    assert call["domain"] == "corp"


def test_session_cookie_flags(client, mock_login):
    r = client.post("/api/auth/login", json={"username": "alice", "password": "pw"}, headers=CSRF)
    cookie = r.headers["set-cookie"].lower()
    assert "pcd_session=" in cookie and "httponly" in cookie and "samesite=lax" in cookie
    assert "secure" not in cookie   # plain HTTP appliance
    # The cookie holds only a random id; the token stays on the server.
    assert "tok-alice" not in r.headers["set-cookie"]


def test_non_admin_is_refused(client, mock_login):
    mock_login.token = make_token(roles=("member",))
    r = client.post("/api/auth/login", json={"username": "bob", "password": "pw"}, headers=CSRF)
    assert r.status_code == 401
    assert r.json()["detail"] == "Your PCD account needs the admin role in project service."
    assert "set-cookie" not in r.headers


def test_bad_password_is_refused(client, mock_login):
    mock_login.error = keystone.AuthError("Invalid username, password or domain, or no role in that project.")
    r = client.post("/api/auth/login", json={"username": "alice", "password": "bad"}, headers=CSRF)
    assert r.status_code == 401
    assert "Invalid username" in r.json()["detail"]


def test_failed_logins_are_rate_limited(client, mock_login):
    mock_login.error = keystone.AuthError("nope")
    codes = [client.post("/api/auth/login", json={"username": "a", "password": "b"},
                         headers=CSRF).status_code for _ in range(6)]
    assert codes == [401] * 5 + [429]
    assert len(mock_login.calls) == 5      # the 6th never reaches Keystone


def test_successful_logins_are_not_rate_limited(client, mock_login):
    codes = [client.post("/api/auth/login", json={"username": "a", "password": "b"},
                         headers=CSRF).status_code for _ in range(8)]
    assert codes == [200] * 8


def test_setup_gate_after_login(logged_in):
    r = logged_in.get("/api/inventory/servers")
    assert r.status_code == 409
    assert r.json() == {"setup_required": True}
    # The auth and setup endpoints stay reachable.
    assert logged_in.get("/api/auth/session").json()["setup_required"] is True
    assert logged_in.get("/api/access").status_code == 200


def test_session_endpoint(client, mock_login):
    assert client.get("/api/auth/session").json() == {
        "authenticated": False, "connection_configured": True}
    client.post("/api/auth/login", json={"username": "alice", "password": "pw"}, headers=CSRF)
    s = client.get("/api/auth/session").json()
    assert s["authenticated"] and s["user"] == "alice" and s["project"] == "service"
    assert s["background"] == "none"


def test_logout_drops_session(logged_in):
    assert logged_in.post("/api/auth/logout", headers=CSRF).status_code == 200
    assert logged_in.get("/api/access").status_code == 401


def test_session_lifetimes(monkeypatch):
    sessions = web_auth.Sessions()
    sid = sessions.create(make_token())
    assert sessions.get(sid) is not None
    s = sessions.get(sid)
    s["seen"] = time.time() - web_auth.IDLE_S - 1          # 8 h idle
    assert sessions.get(sid) is None

    sid = sessions.create(make_token())
    sessions.get(sid)["created"] = time.time() - web_auth.MAX_S - 1   # 12 h total
    assert sessions.get(sid) is None

    sid = sessions.create(make_token(hours=-1))          # Keystone token expired
    assert sessions.get(sid) is None


def test_login_without_connection_asks_for_it(client, mock_login, isolated):
    (isolated / "config.env").unlink()
    r = client.post("/api/auth/login", json={"username": "a", "password": "b"}, headers=CSRF)
    assert r.status_code == 409
    assert r.json()["connection_required"] is True
    assert client.get("/api/auth/session").json()["connection_configured"] is False


def test_settings_have_no_pcd_credentials(logged_in, keystone_api):
    logged_in.post("/api/access/authorize", headers=CSRF)
    body = logged_in.get("/api/settings").json()
    assert not [k for k in body if k.startswith("os_")]
    # Unknown os_* fields in a PUT are ignored, not stored.
    payload = {**body, "os_username": "svc", "os_password": "pw", "grafana_token": ""}
    assert logged_in.put("/api/settings", json=payload, headers=CSRF).status_code == 200
    from app.services import settings_store
    assert not [k for k in settings_store.load() if k.startswith("os_")]
