"""Whether a Nova server group's members are placed as its policy asks."""

from __future__ import annotations

from collections import Counter

HARD = {"affinity", "anti-affinity"}


def check(policy: str | None, members: list[dict], rules: dict | None = None) -> dict:
    """{status, detail}: status is "empty", "ok", "violated" (a hard policy is broken) or
    "not_satisfied" (a soft policy couldn't be met). Members are {host, ...}; unscheduled
    members (no host) are ignored."""
    if not members:
        return {"status": "empty", "detail": "No members"}
    per_host = Counter(m["host"] for m in members if m.get("host"))
    if not per_host:
        return {"status": "ok", "detail": "No member is placed yet"}
    base = (policy or "").removeprefix("soft-")
    broken = "violated" if policy in HARD else "not_satisfied"

    if base == "anti-affinity":
        limit = int((rules or {}).get("max_server_per_host") or 1)
        crowded = {h: n for h, n in per_host.items() if n > limit}
        if crowded:
            hosts = ", ".join(f"{h} ({n})" for h, n in sorted(crowded.items()))
            return {"status": broken, "detail": f"More than {limit} per host on {hosts}"}
        return {"status": "ok", "detail": f"Spread over {len(per_host)} hosts"}

    if base == "affinity":
        if len(per_host) > 1:
            return {"status": broken, "detail": f"Members are on {len(per_host)} hosts"}
        return {"status": "ok", "detail": "All on one host"}

    return {"status": "ok", "detail": f"Policy {policy or 'unknown'}"}
