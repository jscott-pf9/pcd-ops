import asyncio
import json
import logging
import re

import openstack
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_ai_provider
from app.services import capacity, db
from app.services.ai.base import AIProvider
from app.services.db import cache_get
from app.services.openstack import user_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/capacity", tags=["capacity"])


# ── Summary & Trends ───────────────────────────────────────────────────────────

@router.get("/summary")
async def capacity_summary():
    """What the cloud can allocate and what is allocated: vCPUs and RAM from Placement
    (host CPUs or memory minus reserved, times the allocation ratio; `physical` and `ratio` say
    which), storage from Cinder's backends (GB written against the disks' size; `provisioned` is
    volumes' GB, `provisionable` what thin backends let Cinder provision). Not the sum of tenant
    quotas."""
    data, _ = cache_get("capacity:summary")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:summary"})
    return data


@router.get("/trends")
async def capacity_trends():
    """Allocation against capacity over up to 30 days from PCD Ops' metrics store, with a linear
    forecast per resource and AI analysis. `note` says why there is none."""
    data, _ = cache_get("capacity:trends")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:trends"})
    return data


@router.get("/overcommit")
async def capacity_overcommit():
    """CPU and memory overcommit per host and cluster: Placement's allocation (physical, reserved,
    allocation ratio, allocated) against the 95th percentile of real load, with a status and its
    reason for each host. Thresholds are in `thresholds`."""
    data, _ = cache_get("capacity:overcommit")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:overcommit"})
    return data


# ── What-If simulation (ad-hoc, not saved) ────────────────────────────────────

class WhatIfRequest(BaseModel):
    additional_vcpus: float = 0
    additional_ram_gb: float = 0
    additional_storage_gb: float = 0
    additional_vdisks: int = 0
    tenant_id: str | None = None


def _add(r) -> dict:
    return {"vcpus": r["additional_vcpus"], "ram_gb": r["additional_ram_gb"],
            "storage_gb": r["additional_storage_gb"], "vdisks": r["additional_vdisks"]}


def _tenant_quota(conn, project_id: str) -> dict | None:
    """A tenant's Nova and Cinder quotas with what is in use, in plan units; None if PCD
    wouldn't say (no access, or the tenant is gone)."""
    if not re.fullmatch(r"[\w-]+", project_id):
        return None
    try:
        c = conn.compute.get(f"/os-quota-sets/{project_id}/detail")
        b = conn.block_storage.get(f"/os-quota-sets/{project_id}?usage=True")
        c.raise_for_status()
        b.raise_for_status()
        return capacity.tenant_quota(c.json()["quota_set"], b.json()["quota_set"])
    except Exception as e:
        logger.warning("Quota lookup for tenant %s failed: %s", project_id, e)
        return None


async def _simulations(conn, items: list[tuple[dict, str | None]]) -> list[dict | None]:
    """What-if for each (resources to add, tenant id), with each tenant's quota looked up once."""
    summary, _ = cache_get("capacity:summary")
    if summary is None:
        return [None] * len(items)
    tenants = sorted({t for _, t in items if t})
    quotas = dict(zip(tenants, await asyncio.gather(
        *(asyncio.to_thread(_tenant_quota, conn, t) for t in tenants))))
    out = []
    for add, t in items:
        sim = capacity.simulate(summary, add, quotas.get(t) if t else None)
        if t and quotas.get(t) is None:
            sim["quota_error"] = "Couldn't read the tenant's quotas"
        out.append(sim)
    return out


@router.post("/what-if")
async def what_if(request: WhatIfRequest,
                  conn: openstack.connection.Connection = Depends(user_connection)):
    """Simulate adding resources: current vs projected capacity and whether it fits. With
    `tenant_id`, also the tenant's quotas (cores, RAM, volume GB, and vDisks against the volumes
    quota), and `would_fit` needs both."""
    if cache_get("capacity:summary")[0] is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:summary"})
    [sim] = await _simulations(conn, [(_add(request.model_dump()), request.tenant_id)])
    return sim


# ── NLP: parse plain-text description into resource numbers ───────────────────

class ParseRequest(BaseModel):
    description: str


@router.post("/plans/parse")
async def parse_description(body: ParseRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Extract structured resource requirements (vCPUs, RAM, storage) from a natural language description."""
    prompt = (
        "Extract OpenStack compute resource requirements from the user's description.\n"
        "Return ONLY a valid JSON object — no markdown fences, no explanation.\n"
        "Fields (all required, use 0 if not mentioned):\n"
        '  "vcpus": total vCPUs (integer) — multiply VMs × vCPUs per VM\n'
        '  "ram_gb": total RAM in GB (number) — multiply VMs × RAM per VM\n'
        '  "storage_gb": total storage in GB (number)\n'
        '  "vdisks": total number of separate volumes/disks (integer)\n'
        '  "summary": one concise line describing what was parsed\n\n'
        "Examples:\n"
        '  "5 VMs, 4 vCPU and 16 GB RAM each, two 100 GB data volumes"\n'
        '  → {"vcpus":20,"ram_gb":80,"storage_gb":200,"vdisks":2,"summary":"5×(4 vCPU, 16 GB RAM) + 2×100 GB volumes"}\n\n'
        '  "a small dev box, 2 cores and 4 gigs"\n'
        '  → {"vcpus":2,"ram_gb":4,"storage_gb":0,"vdisks":0,"summary":"1×(2 vCPU, 4 GB RAM)"}\n\n'
        f"Description:\n{body.description}"
    )
    raw = await ai.analyze(prompt, {})
    # Extract first JSON object from response
    match = re.search(r"\{[^{}]*\}", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group())
            return {
                "vcpus":      float(parsed.get("vcpus", 0)),
                "ram_gb":     float(parsed.get("ram_gb", 0)),
                "storage_gb": float(parsed.get("storage_gb", 0)),
                "vdisks":     int(parsed.get("vdisks", 0)),
                "summary":    str(parsed.get("summary", "")),
            }
        except (json.JSONDecodeError, ValueError):
            pass
    raise HTTPException(422, detail="Could not parse resource requirements from description")


# ── Plans CRUD ─────────────────────────────────────────────────────────────────

class PlanCreate(BaseModel):
    name: str
    tenant_id: str | None = None
    tenant_name: str | None = None
    description: str = ""
    additional_vcpus: float = 0
    additional_ram_gb: float = 0
    additional_storage_gb: float = 0
    additional_vdisks: int = 0


@router.get("/plans")
async def list_plans(conn: openstack.connection.Connection = Depends(user_connection)):
    """List capacity plans, each with a what-if against current capacity (and its tenant's
    quotas, for a tenant plan)."""
    plans = db.plan_list()
    sims = await _simulations(conn, [(_add(p), p.get("tenant_id")) for p in plans])
    for plan, sim in zip(plans, sims):
        plan["simulation"] = sim
    return plans


@router.post("/plans", status_code=201)
async def create_plan(body: PlanCreate,
                      conn: openstack.connection.Connection = Depends(user_connection)):
    """Create a capacity plan and return it with a what-if simulation."""
    plan = db.plan_create(
        name=body.name,
        tenant_id=body.tenant_id,
        tenant_name=body.tenant_name,
        description=body.description,
        vcpus=body.additional_vcpus,
        ram_gb=body.additional_ram_gb,
        storage_gb=body.additional_storage_gb,
        vdisks=body.additional_vdisks,
    )
    [plan["simulation"]] = await _simulations(conn, [(_add(plan), plan.get("tenant_id"))])
    return plan


@router.delete("/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: int):
    """Delete a capacity plan."""
    db.plan_delete(plan_id)
