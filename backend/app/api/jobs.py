import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.agent import jobs as job_executor
from app.services import db

router = APIRouter(prefix="/jobs", tags=["jobs"])

JOB_TYPES = ["snapshot-cleanup", "snapshot-create", "snapshot-rotate", "resource-reclamation", "capacity-report"]


class JobCreate(BaseModel):
    name: str
    type: str
    # Format: "interval" or "interval@HH:MM" e.g. "daily@09:00", "weekly@08:30"
    schedule: str | None = None
    config: dict = {}


class JobUpdate(BaseModel):
    name: str | None = None
    schedule: str | None = None
    config: dict | None = None
    enabled: bool | None = None


def _annotate_job(job: dict) -> dict:
    """Add computed next_run_at field."""
    nxt = job_executor.next_run_at(job.get("schedule"), job.get("last_run_at"))
    job["next_run_at"] = nxt.isoformat() if nxt else None
    job["is_due"] = job_executor.is_due(job)
    return job


@router.get("/")
async def list_jobs():
    return [_annotate_job(j) for j in db.job_list()]


@router.post("/", status_code=201)
async def create_job(body: JobCreate):
    if body.type not in JOB_TYPES:
        raise HTTPException(400, detail=f"Invalid job type. Must be one of: {JOB_TYPES}")
    return _annotate_job(db.job_create(body.name, body.type, body.schedule, body.config))


@router.put("/{job_id}")
async def update_job(job_id: int, body: JobUpdate):
    job = db.job_get(job_id)
    if not job:
        raise HTTPException(404, detail="Job not found")
    updates = body.model_dump(exclude_none=True)
    if "enabled" in updates:
        updates["enabled"] = 1 if updates["enabled"] else 0
    return _annotate_job(db.job_update(job_id, **updates))


@router.delete("/{job_id}", status_code=204)
async def delete_job(job_id: int):
    db.job_delete(job_id)


@router.post("/{job_id}/run")
async def trigger_job(job_id: int):
    job = db.job_get(job_id)
    if not job:
        raise HTTPException(404, detail="Job not found")
    asyncio.create_task(job_executor.execute_job(job))
    return {"triggered": True, "job_id": job_id}


@router.get("/{job_id}/runs")
async def job_runs(job_id: int, limit: int = 20):
    job = db.job_get(job_id)
    if not job:
        raise HTTPException(404, detail="Job not found")
    return db.job_runs_list(job_id, limit)


@router.delete("/{job_id}/runs", status_code=200)
async def clear_job_runs(job_id: int):
    """Delete all run history for a specific job."""
    job = db.job_get(job_id)
    if not job:
        raise HTTPException(404, detail="Job not found")
    count = db.clear_job_runs(job_id)
    return {"deleted": count}


@router.delete("/runs/purge", status_code=200)
async def purge_all_runs(older_than_days: int = 30):
    """Delete run history older than N days across all jobs."""
    count = db.purge_job_runs(older_than_days)
    return {"deleted": count, "older_than_days": older_than_days}


@router.get("/types")
async def job_types():
    return {
        "snapshot-cleanup": {
            "label": "Snapshot Cleanup",
            "description": "Delete volume snapshots older than a threshold.",
            "config_schema": {
                "max_age_days": {"type": "number",        "default": 30,   "label": "Max age (days)"},
                "tenant_id":    {"type": "tenant_select", "default": "",   "label": "Tenant (blank = all)"},
                "dry_run":      {"type": "boolean",       "default": True, "label": "Dry run"},
            },
        },
        "snapshot-create": {
            "label": "Snapshot Create",
            "description": "Create volume snapshots for matching VMs on a schedule.",
            "config_schema": {
                "tenant_id":       {"type": "tenant_select", "default": "",     "label": "Tenant (blank = all)"},
                "vm_name_pattern": {"type": "string",        "default": "",     "label": "VM name pattern (regex, blank = all)"},
                "name_prefix":     {"type": "string",        "default": "auto", "label": "Snapshot name prefix"},
                "dry_run":         {"type": "boolean",       "default": True,   "label": "Dry run"},
            },
        },
        "snapshot-rotate": {
            "label": "Snapshot Rotate",
            "description": "Keep N most recent snapshots per volume (by prefix), delete older ones.",
            "config_schema": {
                "tenant_id":    {"type": "tenant_select", "default": "",     "label": "Tenant (blank = all)"},
                "name_prefix":  {"type": "string",        "default": "auto", "label": "Snapshot prefix to manage"},
                "retain_count": {"type": "number",        "default": 7,      "label": "Snapshots to retain per volume"},
                "dry_run":      {"type": "boolean",       "default": True,   "label": "Dry run"},
            },
        },
        "resource-reclamation": {
            "label": "Resource Reclamation",
            "description": "Shelve or delete stopped VMs and orphaned volumes past thresholds.",
            "config_schema": {
                "stopped_days":    {"type": "number",  "default": 30,      "label": "VM stopped for (days)"},
                "unattached_days": {"type": "number",  "default": 30,      "label": "Volume unattached for (days)"},
                "action":          {"type": "select",  "default": "shelve", "label": "VM action",
                                    "options": ["shelve", "delete"]},
                "dry_run":         {"type": "boolean", "default": True,     "label": "Dry run"},
            },
        },
        "capacity-report": {
            "label": "Capacity Report",
            "description": "Visual + AI capacity report per tenant. Stored and optionally emailed.",
            "config_schema": {
                "tenant_id": {"type": "tenant_select", "default": "", "label": "Tenant (blank = all)"},
                "email_to":  {"type": "string",        "default": "", "label": "Email report to"},
            },
        },
    }
