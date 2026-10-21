"""The PCD connection: Keystone URL, region and install project (APPLIANCE_STANDARD §5).

Each value comes from the first of:
1. /etc/pcd-app/config.env (PCD_*), written by the catalog. Authoritative; read-only in the UI.
2. The process environment (PCD_*), for local development.
3. connection.json in the state dir: what /setup saved for an install that didn't come from
   the catalog, or what was carried over from 0.4.x when setup completed.
4. A 0.4.x settings.json (os_auth_url, os_project_name, os_region_name), until setup completes.
"""
from __future__ import annotations

import os
import socket
from dataclasses import asdict, dataclass

from app.services import settings_store

from . import config_env, state

CONNECTION_FILE = "connection.json"

# 0.4.x kept a service account in settings.json. Used for background work only until an admin
# authorizes background access in /setup, then deleted (forget_legacy).
LEGACY_KEYS = ("os_auth_url", "os_username", "os_password", "os_project_name",
               "os_user_domain_name", "os_project_domain_name", "os_region_name")


@dataclass
class PCDConnection:
    auth_url: str = ""
    region: str = ""
    project_id: str = ""
    project_name: str = ""
    project_domain: str = "Default"
    instance_name: str = ""
    app_id: str = "pcd-ops"
    from_config_env: bool = False   # auth URL, region and project came from config.env

    @property
    def configured(self) -> bool:
        return bool(self.auth_url and (self.project_id or self.project_name))

    @property
    def project_label(self) -> str:
        return self.project_name or self.project_id

    def public(self) -> dict:
        """For the UI: no secrets here, but keep the shape explicit."""
        d = asdict(self)
        d["configured"] = self.configured
        return d


def legacy_settings() -> dict:
    """The 0.4.x OS_* values still in settings.json (non-empty only)."""
    saved = settings_store.load()
    return {k: saved[k] for k in LEGACY_KEYS if saved.get(k)}


def legacy_credentials() -> dict | None:
    """A complete 0.4.x service account, or None."""
    legacy = legacy_settings()
    if all(legacy.get(k) for k in ("os_auth_url", "os_username", "os_password")):
        return legacy
    return None


def forget_legacy() -> None:
    """Remove every 0.4.x OS_* key from settings.json."""
    saved = settings_store.load()
    if any(k in saved for k in LEGACY_KEYS):
        settings_store.save({k: v for k, v in saved.items() if k not in LEGACY_KEYS})


def load() -> PCDConnection:
    env = config_env.load()
    saved = state.read_json(CONNECTION_FILE) or {}
    legacy = legacy_settings()

    def pick(env_key: str, saved_key: str, legacy_key: str | None = None) -> str:
        return (env.get(env_key) or os.environ.get(env_key) or saved.get(saved_key)
                or (legacy.get(legacy_key) if legacy_key else None) or "")

    return PCDConnection(
        auth_url=pick("PCD_AUTH_URL", "auth_url", "os_auth_url"),
        region=pick("PCD_REGION", "region", "os_region_name"),
        project_id=pick("PCD_PROJECT_ID", "project_id"),
        project_name=pick("PCD_PROJECT_NAME", "project_name", "os_project_name"),
        project_domain=saved.get("project_domain") or legacy.get("os_project_domain_name")
        or "Default",
        instance_name=pick("PCD_INSTANCE_NAME", "instance_name") or socket.gethostname(),
        app_id=pick("PCD_APP_ID", "app_id") or "pcd-ops",
        from_config_env=bool(env.get("PCD_AUTH_URL")),
    )


def save(**fields: str) -> None:
    """Merge into connection.json (installs without config.env, and the 0.4.x carry-over)."""
    saved = state.read_json(CONNECTION_FILE) or {}
    saved.update({k: v for k, v in fields.items() if v})
    state.write_json(CONNECTION_FILE, saved)
