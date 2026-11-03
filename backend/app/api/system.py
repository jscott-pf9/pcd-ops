import asyncio
import os
import subprocess
from importlib import metadata
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
    """Return version from version file (written at image build time) or git, plus git metadata."""
    # version file is written during Packer provisioning; git may not be present
    version_file = APP_DIR / "version"
    file_ver = version_file.read_text().strip() if version_file.exists() else None

    commit = _git("rev-parse", "--short", "HEAD")
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    tag    = _git("describe", "--tags", "--exact-match")

    # The version file is the image's; after an in-app update the installed package is newer.
    try:
        pkg_ver = f"v{metadata.version('pcd-ops')}"
    except metadata.PackageNotFoundError:
        pkg_ver = None
    resolved_tag = (
        tag.stdout.strip() if tag.returncode == 0
        else pkg_ver or file_ver or None
    )
    return {
        "commit": commit.stdout.strip() if commit.returncode == 0 else (file_ver or "unknown"),
        "branch": branch.stdout.strip() if branch.returncode == 0 else "unknown",
        "tag": resolved_tag,
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


@router.get("/connections")
async def check_connections():
    """Test live connectivity to OpenStack (background access) and Grafana; ok/error per service."""
    from app.config import settings as _settings

    result = {
        "openstack": {"ok": False, "error": None, "configured": False},
        "grafana":   {"ok": False, "error": None, "configured": False},
    }

    # ── OpenStack (what background work runs as) ───────────────────────────────
    from app.services import openstack as os_service

    bg = os_service.background_status()
    result["openstack"]["source"] = bg["state"]
    if os_service.background_available():
        result["openstack"]["configured"] = True
        try:
            conn = os_service.background_connection()
            await asyncio.to_thread(conn.authorize)
            result["openstack"]["ok"] = True
        except Exception as exc:
            os_service.report_background_failure(exc)
            result["openstack"]["error"] = str(exc)[:300]
    elif bg["state"] == "failed":
        result["openstack"]["configured"] = True
        result["openstack"]["error"] = ("Background access stopped working — re-authorize it "
                                        "in Settings › Connection")
    else:
        result["openstack"]["error"] = ("Not authorized — finish setup to authorize background "
                                        "access")

    # ── Grafana / Prometheus ───────────────────────────────────────────────────
    from app.services import prometheus

    if _settings.grafana_token or _settings.prometheus_url:
        result["grafana"]["configured"] = True
        try:
            target = await prometheus.resolve()
            await prometheus.prometheus_client.query("vector(1)")
            result["grafana"]["ok"] = True
            result["grafana"]["datasource"] = target.get("name") or target["url"]
        except Exception as exc:
            result["grafana"]["error"] = str(exc)[:300]
    else:
        result["grafana"]["error"] = ("Not configured — add the Grafana token in "
                                      "Settings › Connection")

    return result


@router.post("/restart")
async def restart_service():
    """Restart the pcd-ops backend service without updating code."""
    if Path("/sbin/rc-service").exists():
        cmd = ["sudo", "/sbin/rc-service", "pcd-ops", "restart"]
    else:
        cmd = ["sudo", "systemctl", "restart", "pcd-ops"]
    subprocess.Popen(cmd, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"status": "restarting"}


@router.post("/reboot")
async def reboot_appliance():
    """Reboot the appliance VM (response returns before the reboot completes)."""
    subprocess.Popen(["sudo", "/sbin/reboot"], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"status": "rebooting"}


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
