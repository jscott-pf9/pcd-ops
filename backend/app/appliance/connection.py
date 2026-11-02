"""The PCD connection: Keystone URL, region and install project (APPLIANCE_STANDARD §5).

Each value comes from the first of:
1. /etc/pcd-app/config.env (PCD_*), written by the catalog. Authoritative; read-only in the UI.
2. The process environment (PCD_*), for local development.
3. connection.json in the state dir: what /setup saved for an install that didn't come from
   the catalog.
"""
from __future__ import annotations

import os
import socket
from dataclasses import asdict, dataclass

from . import config_env, state

CONNECTION_FILE = "connection.json"

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


def load() -> PCDConnection:
    env = config_env.load()
    saved = state.read_json(CONNECTION_FILE) or {}

    def pick(env_key: str, saved_key: str) -> str:
        return env.get(env_key) or os.environ.get(env_key) or saved.get(saved_key) or ""

    return PCDConnection(
        auth_url=pick("PCD_AUTH_URL", "auth_url"),
        region=pick("PCD_REGION", "region"),
        project_id=pick("PCD_PROJECT_ID", "project_id"),
        project_name=pick("PCD_PROJECT_NAME", "project_name"),
        project_domain=saved.get("project_domain") or "Default",
        instance_name=pick("PCD_INSTANCE_NAME", "instance_name") or socket.gethostname(),
        app_id=pick("PCD_APP_ID", "app_id") or "pcd-ops",
        from_config_env=bool(env.get("PCD_AUTH_URL")),
    )


def save(**fields: str) -> None:
    """Merge into connection.json (installs without config.env)."""
    saved = state.read_json(CONNECTION_FILE) or {}
    saved.update({k: v for k, v in fields.items() if v})
    state.write_json(CONNECTION_FILE, saved)
