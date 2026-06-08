import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/system", tags=["system"])

# Resolved from PCD_OPS_DIR env var (set by the systemd unit) or inferred
# from this file's location: .../backend/app/api/system.py → repo root is parents[3]
APP_DIR = Path(os.environ.get("PCD_OPS_DIR", Path(__file__).resolve().parents[3]))
_UPDATE_LOG = Path("/tmp/pcd-ops-update.log")


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
    )


@router.get("/version")
async def get_version():
    """Return current git commit (short), branch name, and tag (if on an exact tag)."""
    commit = _git("rev-parse", "--short", "HEAD")
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    tag = _git("describe", "--tags", "--exact-match")
    return {
        "commit": commit.stdout.strip() if commit.returncode == 0 else "unknown",
        "branch": branch.stdout.strip() if branch.returncode == 0 else "unknown",
        "tag": tag.stdout.strip() if tag.returncode == 0 else None,
    }


@router.get("/update/check")
async def check_update():
    """Check whether a newer version is available by running git fetch and comparing HEAD to upstream."""
    fetch = _git("fetch")
    if fetch.returncode != 0:
        raise HTTPException(status_code=503, detail=f"git fetch failed: {fetch.stderr.strip()}")

    local = _git("rev-parse", "HEAD")
    remote = _git("rev-parse", "@{u}")
    if local.returncode != 0 or remote.returncode != 0:
        raise HTTPException(status_code=500, detail="No upstream branch configured")

    local_hash = local.stdout.strip()
    remote_hash = remote.stdout.strip()
    return {
        "up_to_date": local_hash == remote_hash,
        "local": local_hash[:7],
        "remote": remote_hash[:7],
    }


@router.get("/update/log")
async def get_update_log():
    """Return the stdout/stderr log from the most recent self-update run."""
    try:
        return {"log": _UPDATE_LOG.read_text()}
    except FileNotFoundError:
        return {"log": ""}


@router.post("/update")
async def trigger_update():
    """Trigger a self-update: runs deploy/scripts/update.sh detached (git pull + pip install + npm build + service restart)."""
    update_script = APP_DIR / "deploy/scripts/update.sh"
    if not update_script.exists():
        raise HTTPException(
            status_code=404,
            detail="update.sh not found — self-update only works on a VM deployment",
        )

    _UPDATE_LOG.write_text("")
    log_file = _UPDATE_LOG.open("a")
    subprocess.Popen(
        [str(update_script)],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # detach from uvicorn's process group so it survives a service restart
        env={**os.environ, "PCD_OPS_DIR": str(APP_DIR)},
    )
    log_file.close()
    return {"status": "update_started"}
