"""
Job executor — runs user-defined scheduled/on-demand jobs.

Job types:
  snapshot-cleanup      Delete volume snapshots older than max_age_days (optionally per tenant)
  snapshot-create       Create volume snapshots for VMs matching tenant/name filter
  snapshot-rotate       Enforce per-volume retention count for prefixed snapshots
  resource-reclamation  Shelve/delete stopped VMs and unattached volumes past thresholds
  capacity-report       AI-generated capacity summary (stored as report, optionally emailed)
  rightsizing-resize    Resize over-provisioned VMs to their suggested smaller flavor
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta

from app.services import db
from app.services.openstack import get_connection

logger = logging.getLogger(__name__)


# ── Schedule parsing ───────────────────────────────────────────────────────────
#
# Schedule format: "interval" or "interval@HH:MM"
# Examples: "hourly", "daily@09:00", "weekly@08:30", "monthly@07:00"
# Intervals: hourly | daily | weekly | monthly
# Time (UTC) is optional for daily/weekly/monthly; ignored for hourly.

_INTERVALS = {
    "hourly":  timedelta(hours=1),
    "daily":   timedelta(days=1),
    "weekly":  timedelta(weeks=1),
    "monthly": timedelta(days=30),
}


def _parse_schedule(schedule: str) -> tuple[str, str | None]:
    parts = schedule.lower().split("@", 1)
    return parts[0].strip(), (parts[1].strip() if len(parts) > 1 else None)


def next_run_at(schedule: str | None, last_run_at: str | None) -> datetime | None:
    """
    Return the datetime when this job should next run.
    Returns None if schedule is empty (on-demand only).
    """
    if not schedule:
        return None

    interval_key, time_str = _parse_schedule(schedule)
    delta = _INTERVALS.get(interval_key)
    if not delta:
        return None

    now = datetime.utcnow()

    def _at_time(base: datetime) -> datetime:
        """Replace time component with HH:MM from time_str, if provided."""
        if not time_str:
            return base
        try:
            h, m = map(int, time_str.split(":"))
            return base.replace(hour=h, minute=m, second=0, microsecond=0)
        except ValueError:
            return base

    if not last_run_at:
        # Never run — schedule first run
        if time_str and interval_key != "hourly":
            candidate = _at_time(now)
            if candidate <= now:
                candidate += delta
            return candidate
        return now  # run ASAP

    try:
        last = datetime.fromisoformat(last_run_at)
    except ValueError:
        return now

    if time_str and interval_key != "hourly":
        # Advance in delta steps from last run until we find a future time-aligned slot
        candidate = _at_time(last)
        while candidate <= last:
            candidate += delta
        # If that slot is still in the past, keep advancing
        while candidate <= now:
            candidate += delta
        return candidate
    else:
        return last + delta


def is_due(job: dict) -> bool:
    """Return True if this job should run now based on its schedule."""
    if not job.get("enabled"):
        return False
    nxt = next_run_at(job.get("schedule"), job.get("last_run_at"))
    return nxt is not None and nxt <= datetime.utcnow()


# ── Job implementations ────────────────────────────────────────────────────────

def _age_days(dt_str: str | None) -> int:
    if not dt_str:
        return 0
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00")).replace(tzinfo=None)
        return max(0, (datetime.utcnow() - dt).days)
    except ValueError:
        return 0


async def _run_snapshot_cleanup(config: dict) -> dict:
    conn = get_connection()
    max_age_days = int(config.get("max_age_days", 30))
    tenant_id    = config.get("tenant_id") or None
    dry_run      = bool(config.get("dry_run", False))
    cutoff       = datetime.utcnow() - timedelta(days=max_age_days)

    # Resolve tenant name for display
    tenants_cache, _ = db.cache_get("inventory:tenants")
    tenant_map = {t["id"]: t["name"] for t in (tenants_cache or [])}

    snapshots = await asyncio.to_thread(lambda: list(conn.block_storage.snapshots(all_projects=True)))
    candidates = []
    for s in snapshots:
        if tenant_id and s.project_id != tenant_id:
            continue
        created = s.created_at
        if isinstance(created, str):
            try:
                created = datetime.fromisoformat(created.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                continue
        if created < cutoff:
            candidates.append(s)

    actioned, total_gb = [], 0
    for s in candidates:
        logger.info("snapshot-cleanup: %s %s", "DRY" if dry_run else "DELETE", s.name or s.id)
        success = True
        if not dry_run:
            try:
                await asyncio.to_thread(lambda sid=s.id: conn.block_storage.delete_snapshot(sid))
            except Exception as e:
                logger.warning("Failed to delete snapshot %s: %s", s.id, e)
                success = False
        if success:
            size_gb = s.size or 0
            total_gb += size_gb
            actioned.append({
                "id":          s.id,
                "name":        s.name or "(unnamed)",
                "size_gb":     size_gb,
                "age_days":    _age_days(s.created_at),
                "tenant_name": tenant_map.get(s.project_id, s.project_id[:8] if s.project_id else "—"),
            })

    prefix = "[DRY RUN] " if dry_run else ""
    summary = (f"{prefix}{'Would delete' if dry_run else 'Deleted'} "
               f"{len(actioned)} snapshot(s) older than {max_age_days}d ({total_gb} GB freed)")
    return {"summary": summary, "dry_run": dry_run, "deleted_count": len(actioned),
            "total_gb_freed": total_gb, "snapshots": actioned}


async def _run_snapshot_create(config: dict) -> dict:
    import re as _re
    conn = get_connection()
    tenant_id       = config.get("tenant_id") or None
    vm_name_pattern = config.get("vm_name_pattern") or None
    name_prefix     = config.get("name_prefix") or "auto"
    dry_run         = bool(config.get("dry_run", True))

    tenants_cache, _ = db.cache_get("inventory:tenants")
    tenant_map = {t["id"]: t["name"] for t in (tenants_cache or [])}

    servers, all_volumes = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True, status="ACTIVE"))),
        asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True))),
    )

    if tenant_id:
        servers = [s for s in servers if s.project_id == tenant_id]
    if vm_name_pattern:
        pat = _re.compile(vm_name_pattern, _re.IGNORECASE)
        servers = [s for s in servers if pat.search(s.name or "")]

    server_volumes: dict[str, list] = {}
    for v in all_volumes:
        for att in (v.attachments or []):
            sid = att.get("server_id")
            if sid:
                server_volumes.setdefault(sid, []).append(v)

    ts = datetime.utcnow().strftime("%Y%m%d-%H%M")
    created, skipped = [], []

    for server in servers:
        volumes = server_volumes.get(server.id, [])
        if not volumes:
            skipped.append({"id": server.id, "name": server.name or server.id, "reason": "no attached volumes"})
            continue
        for vol in volumes:
            snap_name = f"{name_prefix}-{server.name}-{ts}"
            logger.info("snapshot-create: %s snapshot %s (volume %s)", "DRY" if dry_run else "CREATE", snap_name, vol.id)
            if not dry_run:
                try:
                    snap = await asyncio.to_thread(
                        lambda vid=vol.id, sn=snap_name: conn.block_storage.create_snapshot(
                            volume_id=vid, name=sn, force=True
                        )
                    )
                    created.append({
                        "snapshot_id":  snap.id,
                        "name":         snap_name,
                        "vm_name":      server.name or server.id,
                        "volume_id":    vol.id,
                        "size_gb":      vol.size or 0,
                        "tenant_name":  tenant_map.get(server.project_id, "—"),
                    })
                except Exception as e:
                    logger.warning("Failed to create snapshot for volume %s: %s", vol.id, e)
                    skipped.append({"id": vol.id, "name": vol.name or vol.id, "reason": str(e)})
            else:
                created.append({
                    "snapshot_id":  "(dry-run)",
                    "name":         snap_name,
                    "vm_name":      server.name or server.id,
                    "volume_id":    vol.id,
                    "size_gb":      vol.size or 0,
                    "tenant_name":  tenant_map.get(server.project_id, "—"),
                })

    prefix = "[DRY RUN] " if dry_run else ""
    summary = (f"{prefix}{'Would create' if dry_run else 'Created'} {len(created)} snapshot(s) "
               f"across {len(servers)} VM(s)")
    return {"summary": summary, "dry_run": dry_run, "created_count": len(created),
            "skipped_count": len(skipped), "snapshots": created, "skipped": skipped}


async def _run_snapshot_rotate(config: dict) -> dict:
    conn = get_connection()
    tenant_id    = config.get("tenant_id") or None
    name_prefix  = config.get("name_prefix") or None
    retain_count = int(config.get("retain_count", 7))
    dry_run      = bool(config.get("dry_run", True))

    tenants_cache, _ = db.cache_get("inventory:tenants")
    tenant_map = {t["id"]: t["name"] for t in (tenants_cache or [])}

    snapshots = await asyncio.to_thread(lambda: list(conn.block_storage.snapshots(all_projects=True)))

    if tenant_id:
        snapshots = [s for s in snapshots if s.project_id == tenant_id]
    if name_prefix:
        snapshots = [s for s in snapshots if (s.name or "").startswith(name_prefix)]

    by_volume: dict[str, list] = {}
    for s in snapshots:
        by_volume.setdefault(s.volume_id or "unknown", []).append(s)

    def _created_dt(s) -> datetime:
        try:
            raw = s.created_at if isinstance(s.created_at, str) else ""
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)
        except Exception:
            return datetime.min

    deleted, kept_total = [], 0
    for volume_id, snaps in by_volume.items():
        snaps_sorted = sorted(snaps, key=_created_dt, reverse=True)
        kept_total += min(retain_count, len(snaps_sorted))
        to_delete = snaps_sorted[retain_count:]
        for s in to_delete:
            logger.info("snapshot-rotate: %s snapshot %s (volume %s)", "DRY" if dry_run else "DELETE", s.name or s.id, volume_id)
            success = True
            if not dry_run:
                try:
                    await asyncio.to_thread(lambda sid=s.id: conn.block_storage.delete_snapshot(sid))
                except Exception as e:
                    logger.warning("Failed to delete snapshot %s: %s", s.id, e)
                    success = False
            if success:
                deleted.append({
                    "id":          s.id,
                    "name":        s.name or "(unnamed)",
                    "size_gb":     s.size or 0,
                    "age_days":    _age_days(s.created_at if isinstance(s.created_at, str) else ""),
                    "tenant_name": tenant_map.get(s.project_id, s.project_id[:8] if s.project_id else "—"),
                })

    prefix = "[DRY RUN] " if dry_run else ""
    total_gb = sum(d["size_gb"] for d in deleted)
    summary = (f"{prefix}{'Would delete' if dry_run else 'Deleted'} {len(deleted)} snapshot(s) "
               f"(retain {retain_count}/volume, {kept_total} kept, {total_gb} GB freed)")
    return {"summary": summary, "dry_run": dry_run, "deleted_count": len(deleted),
            "total_gb_freed": total_gb, "retained_per_volume": retain_count, "snapshots": deleted}


async def _run_resource_reclamation(config: dict) -> dict:
    conn = get_connection()
    stopped_days      = int(config.get("stopped_days", 30))
    unattached_days   = int(config.get("unattached_days", 30))
    action            = config.get("action", "shelve")
    dry_run           = bool(config.get("dry_run", True))
    cutoff_stopped    = datetime.utcnow() - timedelta(days=stopped_days)
    cutoff_unattached = datetime.utcnow() - timedelta(days=unattached_days)

    tenants_cache, _ = db.cache_get("inventory:tenants")
    tenant_map = {t["id"]: t["name"] for t in (tenants_cache or [])}

    servers, volumes = await asyncio.gather(
        asyncio.to_thread(lambda: list(conn.compute.servers(all_projects=True))),
        asyncio.to_thread(lambda: list(conn.block_storage.volumes(all_projects=True))),
    )

    # Build server_id → attached_gb map
    attached_gb: dict[str, int] = {}
    for v in volumes:
        for att in (v.attachments or []):
            sid = att.get("server_id")
            if sid:
                attached_gb[sid] = attached_gb.get(sid, 0) + (v.size or 0)

    vms_actioned, volumes_deleted = [], []

    for s in servers:
        if s.status not in ("SHUTOFF", "ERROR", "SHELVED_OFFLOADED"):
            continue
        updated = s.updated_at
        if isinstance(updated, str):
            try:
                updated = datetime.fromisoformat(updated.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                continue
        if updated >= cutoff_stopped:
            continue
        offline_days = (datetime.utcnow() - updated).days
        logger.info("reclamation: %s VM %s (%dd offline)", "DRY" if dry_run else action, s.name, offline_days)
        success = True
        if not dry_run:
            try:
                if action == "delete":
                    await asyncio.to_thread(lambda sid=s.id: conn.compute.delete_server(sid, force=True))
                else:
                    await asyncio.to_thread(lambda sid=s.id: conn.compute.shelve_server(sid))
            except Exception as e:
                logger.warning("Failed to %s VM %s: %s", action, s.name, e)
                success = False
        if success:
            vms_actioned.append({
                "id":           s.id,
                "name":         s.name,
                "action":       action,
                "offline_days": offline_days,
                "attached_gb":  attached_gb.get(s.id, 0),
                "tenant_name":  tenant_map.get(s.project_id, "—"),
            })

    for v in volumes:
        if v.status != "available" or v.attachments:
            continue
        created = v.created_at
        if isinstance(created, str):
            try:
                created = datetime.fromisoformat(created.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                continue
        if created >= cutoff_unattached:
            continue
        logger.info("reclamation: %s volume %s", "DRY" if dry_run else "DELETE", v.name or v.id)
        success = True
        if not dry_run:
            try:
                await asyncio.to_thread(lambda vid=v.id: conn.block_storage.delete_volume(vid))
            except Exception as e:
                logger.warning("Failed to delete volume %s: %s", v.id, e)
                success = False
        if success:
            volumes_deleted.append({
                "id":              v.id,
                "name":            v.name or "(unnamed)",
                "size_gb":         v.size or 0,
                "unattached_days": _age_days(v.created_at),
                "tenant_name":     tenant_map.get(v.project_id, "—"),
            })

    prefix = "[DRY RUN] " if dry_run else ""
    summary = (f"{prefix}{action.title()} {len(vms_actioned)} VM(s) offline >{stopped_days}d, "
               f"deleted {len(volumes_deleted)} volume(s) unattached >{unattached_days}d")
    return {"summary": summary, "dry_run": dry_run, "action": action,
            "vms_actioned": vms_actioned, "volumes_deleted": volumes_deleted}


async def _run_capacity_report(config: dict) -> dict:
    import math as _math
    from app.services.db import cache_get
    from app.dependencies import get_ai_provider
    from app.services.prometheus import prometheus_client
    from app.services.notifications import send_email
    from app.agent.collector import _clean_analysis, _series_from_range

    ai        = get_ai_provider()
    tenant_id = config.get("tenant_id") or None
    email_to  = config.get("email_to")  or None

    # ── Cluster-wide snapshot ──────────────────────────────────────────────────
    cluster_summary, _ = cache_get("capacity:summary")
    capacity_trends, _ = cache_get("capacity:trends")

    # ── Per-tenant quota data (current values) ─────────────────────────────────
    end = datetime.utcnow()
    start = end - timedelta(days=7)

    prom_results = await asyncio.gather(
        prometheus_client.query("openstack_nova_limits_vcpus_used"),
        prometheus_client.query("openstack_nova_limits_vcpus_max"),
        prometheus_client.query("openstack_nova_limits_memory_used"),
        prometheus_client.query("openstack_nova_limits_memory_max"),
        prometheus_client.query("openstack_cinder_limits_volume_used_gb"),
        prometheus_client.query("openstack_cinder_limits_volume_max_gb"),
        return_exceptions=True,
    )

    def _prom_by_tenant(result) -> dict[str, float]:
        if isinstance(result, Exception) or not result:
            return {}
        out = {}
        for s in result:
            t_id = s["metric"].get("tenant_id") or s["metric"].get("tenant", "")
            try:
                v = float(s["value"][1])
                if _math.isfinite(v):
                    out[t_id] = v
            except (ValueError, KeyError, IndexError):
                pass
        return out

    vcpu_used_by   = _prom_by_tenant(prom_results[0])
    vcpu_max_by    = _prom_by_tenant(prom_results[1])
    mem_used_by    = _prom_by_tenant(prom_results[2])
    mem_max_by     = _prom_by_tenant(prom_results[3])
    stor_used_by   = _prom_by_tenant(prom_results[4])
    stor_max_by    = _prom_by_tenant(prom_results[5])

    # ── Tenant metadata ────────────────────────────────────────────────────────
    tenants_cache, _ = cache_get("inventory:tenants")
    tenant_list = [t for t in (tenants_cache or [])
                   if t.get("name", "").lower() not in ("admin", "service")]
    if tenant_id:
        tenant_list = [t for t in tenant_list if t["id"] == tenant_id]

    # All tenant_ids with any data
    all_ids = set(vcpu_used_by) | set(vcpu_max_by) | set(mem_used_by) | set(stor_used_by)
    id_to_name = {t["id"]: t["name"] for t in tenant_list}

    # ── 7-day trend series per tenant (vcpus + memory) ─────────────────────────
    async def _tenant_trend(t_id: str) -> tuple[list, list]:
        try:
            cpu_r, mem_r = await asyncio.gather(
                prometheus_client.query_range(
                    f'openstack_nova_limits_vcpus_used{{tenant_id="{t_id}"}}', start, end, step="6h"),
                prometheus_client.query_range(
                    f'openstack_nova_limits_memory_used{{tenant_id="{t_id}"}}', start, end, step="6h"),
            )
            cpu_s = _series_from_range(cpu_r)
            mem_s = [{"ts": p["ts"], "v": round(p["v"] / 1024, 1)} for p in _series_from_range(mem_r)]
            return cpu_s, mem_s
        except Exception:
            return [], []

    trend_data = await asyncio.gather(*[_tenant_trend(t["id"]) for t in tenant_list])

    # ── Build per-tenant report objects ───────────────────────────────────────
    def _pct(used, total):
        return round(used / total * 100, 1) if total and total > 0 else 0

    tenants_report = []
    for i, t in enumerate(tenant_list):
        t_id = t["id"]
        vu = vcpu_used_by.get(t_id, 0)
        vm = vcpu_max_by.get(t_id, 0)
        mu = mem_used_by.get(t_id, 0)
        mm = mem_max_by.get(t_id, 0)
        su = stor_used_by.get(t_id, 0)
        sm = stor_max_by.get(t_id, 0)
        cpu_series, mem_series = trend_data[i] if i < len(trend_data) else ([], [])

        tenants_report.append({
            "name":       t["name"],
            "tenant_id":  t_id,
            "vcpus":      {"used": vu, "max": vm, "pct": _pct(vu, vm)},
            "ram_gb":     {"used": round(mu / 1024, 1), "max": round(mm / 1024, 1), "pct": _pct(mu, mm)},
            "storage_gb": {"used": su, "max": sm, "pct": _pct(su, sm)},
            "cpu_series": cpu_series,
            "mem_series": mem_series,
        })

    # Sort by vCPU usage descending
    tenants_report.sort(key=lambda x: -(x["vcpus"]["used"]))

    # ── AI analysis ────────────────────────────────────────────────────────────
    ai_context = {
        "cluster": cluster_summary,
        "warning_thresholds": {"vcpus_pct": 70, "ram_pct": 70, "storage_pct": 70},
        "critical_thresholds": {"vcpus_pct": 90, "ram_pct": 90, "storage_pct": 90},
        "tenants": [
            {"name": t["name"], "vcpus_pct": t["vcpus"]["pct"],
             "ram_pct": t["ram_gb"]["pct"], "storage_pct": t["storage_gb"]["pct"]}
            for t in tenants_report
        ],
    }
    ai_text = _clean_analysis(await ai.analyze(
        "Generate a concise capacity planning report for this Platform9 PCD cluster. "
        "Cover: cluster utilization summary, which tenants are consuming the most resources, "
        "which tenants (if any) are above the warning thresholds provided in the context, "
        "and 3 specific recommendations. "
        "IMPORTANT: Only reference thresholds and limits that are explicitly provided in the "
        "context data. Do not invent or assume any thresholds, quotas, or limits. "
        "No preamble, no markdown, plain sentences.",
        ai_context,
    ))

    # ── Assemble and store report ──────────────────────────────────────────────
    report_id = str(uuid.uuid4())
    report = {
        "report_id":     report_id,
        "generated_at":  datetime.utcnow().isoformat(),
        "tenant_filter": id_to_name.get(tenant_id) if tenant_id else None,
        "cluster":       cluster_summary,
        "tenants":       tenants_report,
        "ai_analysis":   ai_text,
        "email_sent_to": None,
    }
    db.report_save(report_id, report)

    # ── Email ──────────────────────────────────────────────────────────────────
    if email_to:
        subject = f"PCD Capacity Report — {datetime.utcnow().strftime('%Y-%m-%d')}"
        body_lines = [f"PCD Capacity Report — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}", ""]
        if cluster_summary:
            body_lines.append(f"Cluster: {cluster_summary.get('vcpus',{}).get('used')} vCPUs, "
                              f"{cluster_summary.get('ram_gb',{}).get('used')} GB RAM, "
                              f"{cluster_summary.get('storage_gb',{}).get('used')} GB storage")
            body_lines.append("")
        body_lines.append("Per-tenant usage:")
        for t in tenants_report:
            body_lines.append(f"  {t['name']}: CPU {t['vcpus']['pct']}%  RAM {t['ram_gb']['pct']}%  Storage {t['storage_gb']['pct']}%")
        body_lines += ["", "Analysis:", ai_text or ""]
        await send_email(subject, "\n".join(body_lines))
        report["email_sent_to"] = email_to
        db.report_save(report_id, report)  # update with email_sent_to

    summary = (f"Report generated for {len(tenants_report)} tenant(s)"
               + (f", emailed to {email_to}" if email_to else ""))
    return {"summary": summary, "report_id": report_id, "email_sent_to": email_to,
            "tenant_filter": id_to_name.get(tenant_id) if tenant_id else None}


async def _run_rightsizing_resize(config: dict) -> dict:
    """Resize over-provisioned / idle VMs to their AI-suggested smaller flavor."""
    conn = get_connection()
    dry_run         = bool(config.get("dry_run", True))
    classifications = config.get("classifications", ["overprovisioned", "idle"])
    tenant_id       = config.get("tenant_id")

    recs, _ = db.cache_get("rightsizing:recommendations")
    if not recs:
        return {"summary": "No right-sizing data in cache — trigger a collection run first.",
                "dry_run": dry_run, "resized_count": 0, "skipped_count": 0, "vms": []}

    candidates = [
        r for r in recs
        if r.get("classification") in classifications
        and r.get("suggested_flavor")
        and r.get("server_status") in ("ACTIVE", "SHUTOFF")
        and (not tenant_id or r.get("project_id") == tenant_id)
    ]

    resized, skipped = [], []
    for rec in candidates:
        vm_id     = rec["server_id"]
        vm_name   = rec["server_name"]
        cur_fl    = rec["current_flavor"]
        sug_fl    = rec["suggested_flavor"]
        action_ok = True

        logger.info("rightsizing-resize: %s %s → %s (vm=%s)",
                    "DRY" if dry_run else "RESIZE", cur_fl["name"], sug_fl["name"], vm_name)

        if not dry_run:
            try:
                await asyncio.to_thread(lambda vid=vm_id, fid=sug_fl["id"]:
                    conn.compute.resize_server(vid, fid))

                # Poll for VERIFY_RESIZE (up to 90 s)
                for _ in range(18):
                    await asyncio.sleep(5)
                    server = await asyncio.to_thread(lambda vid=vm_id: conn.compute.get_server(vid))
                    if server.status == "VERIFY_RESIZE":
                        break
                else:
                    raise TimeoutError("Timed out waiting for VERIFY_RESIZE")

                await asyncio.to_thread(lambda vid=vm_id: conn.compute.confirm_server_resize(vid))
            except Exception as e:
                logger.warning("Failed to resize %s: %s", vm_name, e)
                skipped.append({"name": vm_name, "reason": str(e)})
                action_ok = False

        if action_ok:
            resized.append({
                "name":           vm_name,
                "from_flavor":    cur_fl["name"],
                "to_flavor":      sug_fl["name"],
                "vcpu_reduction": cur_fl["vcpus"] - sug_fl["vcpus"],
                "ram_reduction_mb": cur_fl["ram_mb"] - sug_fl["ram_mb"],
                "tenant_name":    rec.get("tenant_name", "—"),
                "dry_run":        dry_run,
            })
        else:
            skipped.append({"name": vm_name, "reason": "resize failed"})

    prefix = "[DRY RUN] " if dry_run else ""
    summary = (f"{prefix}Resized {len(resized)} VM(s) to smaller flavors; "
               f"{len(skipped)} skipped. Classifications: {', '.join(classifications)}.")
    return {
        "summary": summary,
        "dry_run": dry_run,
        "resized_count": len(resized),
        "skipped_count": len(skipped),
        "vms": resized,
        "skipped": skipped,
    }


# ── Dispatcher ─────────────────────────────────────────────────────────────────

_EXECUTORS = {
    "snapshot-cleanup":     _run_snapshot_cleanup,
    "snapshot-create":      _run_snapshot_create,
    "snapshot-rotate":      _run_snapshot_rotate,
    "resource-reclamation": _run_resource_reclamation,
    "capacity-report":      _run_capacity_report,
    "rightsizing-resize":   _run_rightsizing_resize,
}


async def execute_job(job: dict) -> None:
    """Run a job, log the run, update job status."""
    job_id  = job["id"]
    type_   = job["type"]
    config  = job.get("config") or {}

    executor = _EXECUTORS.get(type_)
    if not executor:
        logger.error("Unknown job type: %s", type_)
        return

    run_id = db.job_run_start(job_id)
    logger.info("Job %d (%s) started (run_id=%d)", job_id, type_, run_id)
    try:
        result = await executor(config)
        result_str = json.dumps(result) if isinstance(result, dict) else str(result)
        db.job_run_finish(run_id, job_id, "success", result=result_str)
        summary = result.get("summary", "") if isinstance(result, dict) else result
        logger.info("Job %d (%s) complete: %s", job_id, type_, summary[:120])
    except Exception as e:
        db.job_run_finish(run_id, job_id, "error", error=str(e))
        logger.exception("Job %d (%s) failed", job_id, type_)
