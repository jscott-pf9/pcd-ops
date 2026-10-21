"""Keystone v3 login with the user's own PCD account (APPLIANCE_STANDARD §7.1, §7.4).

Adapted from the standard's §8.2 reference module:
- login() can scope by project name, for 0.4.x installs that know only the project name;
- network errors become AuthError, so the login page can show them;
- connections use PCD's public endpoints (the catalog's internal URLs are k8s-only).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests

TIMEOUT_S = 15


class AuthError(Exception):
    pass


@dataclass
class Token:
    value: str = field(repr=False)
    user_id: str
    user_name: str
    project_id: str
    roles: list[str]
    expires_at: datetime
    project_name: str = ""


def _issue(auth_url: str, body: dict, verify: bool | str = True) -> Token:
    try:
        r = requests.post(f"{auth_url.rstrip('/')}/auth/tokens", json=body, timeout=TIMEOUT_S,
                          verify=verify)
    except requests.RequestException as e:
        raise AuthError(f"Can't reach PCD at {auth_url}: {e.__class__.__name__}") from e
    if r.status_code in (401, 403):
        raise AuthError("Invalid username, password or domain, or no role in that project.")
    r.raise_for_status()
    t = r.json()["token"]
    project = t.get("project") or {}
    return Token(
        value=r.headers["X-Subject-Token"],
        user_id=t["user"]["id"],
        user_name=t["user"]["name"],
        project_id=project.get("id", ""),
        project_name=project.get("name", ""),
        roles=[x["name"] for x in t.get("roles", [])],
        expires_at=datetime.fromisoformat(t["expires_at"].replace("Z", "+00:00")),
    )


def login(auth_url: str, username: str, password: str, domain: str = "Default",
          project_id: str | None = None, verify: bool | str = True, *,
          project_name: str | None = None, project_domain: str = "Default") -> Token:
    """Password login; scoped to project_id when given (admin appliances: PCD_PROJECT_ID),
    else to project_name in project_domain."""
    body: dict = {"auth": {"identity": {"methods": ["password"], "password": {
        "user": {"name": username, "domain": {"name": domain or "Default"}, "password": password}}}}}
    if project_id:
        body["auth"]["scope"] = {"project": {"id": project_id}}
    elif project_name:
        body["auth"]["scope"] = {"project": {"name": project_name,
                                             "domain": {"name": project_domain or "Default"}}}
    return _issue(auth_url, body, verify)


def rescope(auth_url: str, token: str, project_id: str, verify: bool | str = True) -> Token:
    """Same user, another project; works only where the user has a role. No password needed."""
    body = {"auth": {"identity": {"methods": ["token"], "token": {"id": token}},
                     "scope": {"project": {"id": project_id}}}}
    return _issue(auth_url, body, verify)


def projects(auth_url: str, token: str, verify: bool | str = True) -> list[dict]:
    """Projects the user can scope to (tenant-facing apps' project picker)."""
    r = requests.get(f"{auth_url.rstrip('/')}/auth/projects", headers={"X-Auth-Token": token},
                     timeout=TIMEOUT_S, verify=verify)
    r.raise_for_status()
    return [{"id": p["id"], "name": p["name"]}
            for p in r.json().get("projects", []) if p.get("enabled", True)]


def require_admin(tok: Token, project_name: str) -> None:
    if "admin" not in tok.roles:
        raise AuthError(f"Your PCD account needs the admin role in project {project_name}.")


def expired(tok: Token) -> bool:
    return datetime.now(timezone.utc) >= tok.expires_at


def user_connection(auth_url: str, tok: Token, region: str, verify: bool | str = True):
    """openstacksdk Connection acting as the logged-in user (interactive work)."""
    import openstack
    from keystoneauth1 import session as ks_session
    from keystoneauth1.identity import v3

    auth = v3.Token(auth_url=auth_url, token=tok.value, project_id=tok.project_id)
    return openstack.connection.Connection(session=ks_session.Session(auth=auth, verify=verify),
                                           region_name=region or None, interface="public")
