"""Statistical anomaly detection: is a VM's or host's last hour far from its usual? (pure
functions; collector.collect_anomaly fetches the series and stores the findings).

Each series is hourly means over the last 8 days. The baseline is the same hour of day on
earlier days when there are at least 5 days (load follows the clock: backups at 2 am aren't an
anomaly), else the whole window; under a day of history there is no baseline yet. The score is
z = (last hour - usual) / spread. A finding also needs a minimum real change, so a flat idle VM
going from 0.1 % to 0.5 % CPU isn't one, and some metrics only count when they rise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

Z_MEDIUM, Z_HIGH, Z_CRITICAL = 3.0, 4.5, 6.0
MIN_HISTORY_H = 24
SEASONAL_MIN_DAYS = 5
SEASONAL_MIN_POINTS = 4
WINDOW_DAYS = 8
SPARK_POINTS = 48


@dataclass(frozen=True)
class Rule:
    group: str  # vm | host
    metric: str  # metrics_catalog name, or net_bps (rx + tx)
    label: str
    unit: str  # pct | bps | iops | ms | pps
    up_only: bool  # only a rise counts
    min_change: float  # the smallest absolute change that can be an anomaly


RULES: tuple[Rule, ...] = (
    Rule("vm", "cpu_pct", "CPU", "pct", False, 15),
    Rule("vm", "mem_pct", "Memory", "pct", True, 10),
    Rule("vm", "net_bps", "Network", "bps", False, 1e6),
    Rule("vm", "disk_iops", "Disk IOPS", "iops", False, 50),
    Rule("vm", "cpu_wait_pct", "CPU wait", "pct", True, 2),
    Rule("vm", "disk_latency_ms", "Disk latency", "ms", True, 5),
    Rule("host", "cpu_pct", "CPU", "pct", False, 15),
    Rule("host", "mem_pct", "Memory", "pct", True, 10),
    Rule("host", "net_bps", "Network", "bps", False, 5e6),
    Rule("host", "swap_in_pps", "Swap-in", "pps", True, 10),
)
RULE = {(r.group, r.metric): r for r in RULES}


def _mean_std(vs: list[float]) -> tuple[float, float]:
    m = sum(vs) / len(vs)
    return m, math.sqrt(sum((v - m) ** 2 for v in vs) / len(vs))


def severity(z: float) -> str | None:
    a = abs(z)
    if a >= Z_CRITICAL:
        return "critical"
    if a >= Z_HIGH:
        return "high"
    if a >= Z_MEDIUM:
        return "medium"
    return None


def history_hours(points: list[tuple[int, float]]) -> float:
    return (points[-1][0] - points[0][0]) / 3600 if len(points) > 1 else 0


def score(points: list[tuple[int, float]], rule: Rule, now: float) -> dict | None:
    """A finding for the last point against the ones before it, or None. `points` are
    (timestamp, hourly mean), oldest first."""
    pts = [(ts, v) for ts, v in points if v is not None and math.isfinite(v)]
    if len(pts) < 3 or now - pts[-1][0] > 2 * 3600:  # no current hour
        return None
    cur_ts, cur = pts[-1]
    hist = [(ts, v) for ts, v in pts if ts <= cur_ts - 3600]
    if not hist or (cur_ts - hist[0][0]) / 3600 < MIN_HISTORY_H:
        return None
    hour = datetime.fromtimestamp(cur_ts, timezone.utc).hour
    same_hour = [v for ts, v in hist if datetime.fromtimestamp(ts, timezone.utc).hour == hour]
    all_mean, all_std = _mean_std([v for _, v in hist])
    days = (cur_ts - hist[0][0]) / 86400
    if days >= SEASONAL_MIN_DAYS and len(same_hour) >= SEASONAL_MIN_POINTS:
        mean, s_std = _mean_std(same_hour)
        # Blend with the whole window's spread: a few same-hour points can be all alike
        std, baseline = math.sqrt((s_std**2 + all_std**2) / 2), "seasonal"
    else:
        mean, std, baseline = all_mean, all_std, "window"
    delta = cur - mean
    if rule.up_only and delta <= 0:
        return None
    if abs(delta) < rule.min_change:
        return None
    z = delta / max(std, rule.min_change / Z_MEDIUM)
    sev = severity(z)
    if not sev:
        return None
    return {
        "current": round(cur, 3),
        "usual": round(mean, 3),
        "spread": round(std, 3),
        "z": round(z, 2),
        "direction": "up" if delta > 0 else "down",
        "severity": sev,
        "baseline": baseline,
        "spark": [{"ts": ts, "v": round(v, 3)} for ts, v in pts[-SPARK_POINTS:]],
    }


def worse(new: str, old: str | None) -> bool:
    order = ("medium", "high", "critical")
    return old is None or order.index(new) > order.index(old)
