"""
SSH log collection from PCD hypervisors using paramiko.
Runs synchronously and is called via asyncio.to_thread().
"""

import logging
import os
from typing import NamedTuple

import paramiko

logger = logging.getLogger(__name__)

# PF9-specific service logs — all optional (missing files silently return nothing via 2>/dev/null)
# Each entry: (path, lines_to_tail)  — higher line counts for high-volume / most important logs
LOG_PATHS: list[tuple[str, int]] = [
    ("/var/log/pf9/hostagent.log",         300),   # most important — session & convergence events
    ("/var/log/pf9/hostagent-daemon.log",  300),   # daemon lifecycle, errors
    ("/var/log/pf9/cindervolume-base.log", 200),   # volume service
    ("/var/log/pf9/glance-api.log",        200),   # image service
    ("/var/log/pf9/ostackhost.log",        200),   # hypervisor host agent
    # Supplemental
    ("/var/log/pf9/pf9-logd.log",         100),
    ("/var/log/nova/nova-compute.log",     100),
    ("/var/log/syslog",                    100),
]

# Friendly display names mapped from log file basenames
_SERVICE_LABELS = {
    "hostagent":          "hostagent",
    "hostagent-daemon":   "hostagent-daemon",
    "cindervolume-base":  "cinder-volume",
    "glance-api":         "glance",
    "ostackhost":         "ostackhost",
    "pf9-logd":           "pf9-logd",
    "nova-compute":       "nova",
    "syslog":             "system",
}

LEVEL_KEYWORDS = {
    "ERROR":    ["error", "exception", "fail", "fatal", "critical", "traceback"],
    "WARNING":  ["warn", "warning"],
    "INFO":     ["info", "started", "stopped", "connected"],
    "DEBUG":    ["debug"],
}


class LogEntry(NamedTuple):
    host: str
    service: str
    level: str
    message: str
    raw: str


def _classify_level(line: str) -> str:
    low = line.lower()
    for level, keywords in LEVEL_KEYWORDS.items():
        if any(k in low for k in keywords):
            return level
    return "INFO"


def _service_from_path(path: str) -> str:
    name = os.path.basename(path).replace(".log", "").replace("_log", "")
    return _SERVICE_LABELS.get(name, name[:20])


def _ssh_client(host: str, user: str, key_path: str, password: str) -> paramiko.SSHClient:
    """Open and return a connected SSHClient. Caller is responsible for close()."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict = {"username": user, "timeout": 10}
    if key_path and os.path.exists(os.path.expanduser(key_path)):
        kwargs["key_filename"] = os.path.expanduser(key_path)
    elif password:
        kwargs["password"] = password
    client.connect(host, **kwargs)
    return client


def collect_host_hardware(host: str, user: str, key_path: str, password: str) -> dict:
    """Collect physical hardware facts over one SSH connection.

    Returns::
        {
            "connected":      bool,
            "nic_count":      int | None,
            "ram_mb":         int | None,
            "os_version":     str | None,  # e.g. "Ubuntu 22.04.3 LTS"
            "pending_patches": int | None, # packages awaiting upgrade
        }
    """
    result: dict = {
        "connected": False, "nic_count": None, "ram_mb": None,
        "os_version": None, "pending_patches": None,
    }
    client = None
    try:
        client = _ssh_client(host, user, key_path, password)
        result["connected"] = True

        # Physical NICs only: /sys/class/net/<iface>/device exists only for real hardware
        _, stdout, _ = client.exec_command(
            "find /sys/class/net/*/device -maxdepth 0 2>/dev/null | wc -l", timeout=10
        )
        out = stdout.read().decode("utf-8", errors="replace").strip()
        if out.isdigit():
            result["nic_count"] = int(out)

        # Physical RAM: MemTotal from /proc/meminfo (kB → MB)
        _, stdout, _ = client.exec_command(
            "awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null", timeout=10
        )
        out = stdout.read().decode("utf-8", errors="replace").strip()
        if out.isdigit():
            result["ram_mb"] = int(out) // 1024

        # OS version from /etc/os-release (works on Ubuntu + RHEL/Rocky)
        _, stdout, _ = client.exec_command(
            "awk -F= '/^PRETTY_NAME/{gsub(/\"/,\"\"); print $2}' /etc/os-release 2>/dev/null",
            timeout=10,
        )
        out = stdout.read().decode("utf-8", errors="replace").strip()
        if out:
            result["os_version"] = out

        # Pending patches: try apt first, fall back to dnf/yum
        _, stdout, _ = client.exec_command(
            "apt list --upgradable 2>/dev/null | tail -n +2 | wc -l || "
            "dnf check-update -q 2>/dev/null | grep -cE '^[a-zA-Z0-9_-]+\\.' || echo 0",
            timeout=30,
        )
        out = stdout.read().decode("utf-8", errors="replace").strip()
        if out.isdigit():
            result["pending_patches"] = int(out)

    except Exception as e:
        logger.warning("Hardware collection on %s failed: %s", host, e)
    finally:
        if client:
            client.close()
    return result


def collect_host_logs(host: str, user: str, key_path: str, password: str) -> list[dict]:
    """SSH to host, tail each log file, return structured entries."""
    entries = []
    client = None
    try:
        client = _ssh_client(host, user, key_path, password)
        for path, n_lines in LOG_PATHS:
            try:
                _, stdout, _ = client.exec_command(
                    f"tail -n {n_lines} {path} 2>/dev/null", timeout=10
                )
                service = _service_from_path(path)
                for line in stdout.read().decode("utf-8", errors="replace").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    entries.append({
                        "host":    host,
                        "service": service,
                        "level":   _classify_level(line),
                        "message": line[:400],
                    })
            except Exception as e:
                logger.debug("Could not read %s on %s: %s", path, host, e)
    except Exception as e:
        logger.warning("SSH to %s failed: %s", host, e)
    finally:
        if client:
            client.close()

    return entries
