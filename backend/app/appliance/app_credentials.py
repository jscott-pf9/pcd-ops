"""Application credentials for background work (APPLIANCE_STANDARD §7.5).

Adapted from the standard's §8.3 reference module: the key and the stored record live in
the state dir (state.py), and the record is saved/loaded here so the console TUI can wipe it
("Reset setup") by deleting one file.
"""
from __future__ import annotations

import os
import time

import requests
from cryptography.fernet import Fernet

from . import state
from .keystone import TIMEOUT_S, Token

KEY_FILE = "secret.key"
RECORD_FILE = "app_credential.json"


def _fernet() -> Fernet:
    """The key is generated on first use, 0600, never shipped in the image."""
    key_path = state.state_dir() / KEY_FILE
    if not key_path.exists():
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(Fernet.generate_key())
    return Fernet(key_path.read_bytes())


def encrypt(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt(blob: str) -> str:
    return _fernet().decrypt(blob.encode()).decode()


def mint(auth_url: str, tok: Token, app_id: str, instance: str, roles: tuple[str, ...] = ("admin",),
         verify: bool | str = True) -> dict:
    """Create an application credential from the logged-in admin's token, scoped to tok.project_id.
    Returns the record to store (secret encrypted)."""
    name = f"{app_id}-{instance}-{time.strftime('%Y%m%d-%H%M', time.gmtime())}"
    body = {"application_credential": {
        "name": name,
        "description": f"Background access for {instance} ({app_id}); created in its setup screen.",
        "roles": [{"name": r} for r in roles],
        "unrestricted": False,
    }}
    r = requests.post(f"{auth_url.rstrip('/')}/users/{tok.user_id}/application_credentials",
                      json=body, headers={"X-Auth-Token": tok.value}, timeout=TIMEOUT_S, verify=verify)
    r.raise_for_status()
    cred = r.json()["application_credential"]
    return {"id": cred["id"], "name": name, "secret_enc": encrypt(cred["secret"]),
            "project_id": cred["project_id"], "owner_id": tok.user_id, "owner": tok.user_name,
            "created": int(time.time()), "last_used": None}


def revoke(auth_url: str, tok: Token, record: dict, verify: bool | str = True) -> None:
    """Delete it in Keystone with the current admin's token (owner, or an admin allowed by policy)."""
    r = requests.delete(
        f"{auth_url.rstrip('/')}/users/{record['owner_id']}/application_credentials/{record['id']}",
        headers={"X-Auth-Token": tok.value}, timeout=TIMEOUT_S, verify=verify)
    if r.status_code not in (204, 404):
        r.raise_for_status()


def connection(auth_url: str, record: dict, region: str, verify: bool | str = True):
    """openstacksdk Connection for background jobs. A 401 from it means the credential is gone:
    flag setup_required and tell the admin to re-authorize."""
    import openstack
    from keystoneauth1 import session as ks_session
    from keystoneauth1.identity import v3

    auth = v3.ApplicationCredential(auth_url=auth_url, application_credential_id=record["id"],
                                    application_credential_secret=decrypt(record["secret_enc"]))
    return openstack.connection.Connection(session=ks_session.Session(auth=auth, verify=verify),
                                           region_name=region or None, interface="public")


# ── The stored record ─────────────────────────────────────────────────────────

def load_record() -> dict | None:
    return state.read_json(RECORD_FILE)


def save_record(record: dict) -> None:
    state.write_json(RECORD_FILE, record)


def clear_record() -> None:
    state.delete(RECORD_FILE)
