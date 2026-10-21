"""Where the appliance keeps per-install state that must never be in the image.

/var/lib/pcd-ops on images built from 0.5.0 (created by provisioning, owned by pcd-ops).
Appliances upgraded in place from 0.4.x can't create it (the service user isn't root), so
they fall back to backend/data/, next to the SQLite database. PCD_OPS_STATE_DIR overrides
both (tests, local development).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_VAR_LIB = Path("/var/lib/pcd-ops")
_FALLBACK = Path(__file__).resolve().parents[2] / "data"


def state_dir() -> Path:
    if os.environ.get("PCD_OPS_STATE_DIR"):
        d = Path(os.environ["PCD_OPS_STATE_DIR"])
    elif _VAR_LIB.is_dir() and os.access(_VAR_LIB, os.W_OK):
        d = _VAR_LIB
    else:
        d = _FALLBACK
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_json(name: str) -> dict | None:
    try:
        return json.loads((state_dir() / name).read_text())
    except (OSError, ValueError):
        return None


def write_json(name: str, data: dict) -> None:
    """Atomic write, mode 0600 (the files hold credential ids and encrypted secrets)."""
    path = state_dir() / name
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def delete(name: str) -> None:
    (state_dir() / name).unlink(missing_ok=True)
